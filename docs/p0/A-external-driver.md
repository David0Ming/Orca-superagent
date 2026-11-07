# P0-A：外部进程驱动 Orca 编排

日期：2026-11-02　Orca CLI 1.4.227　脚本：`/tmp/p0-a/run.sh`（产物 JSON 同目录）

## 结论：通过（带一个前提）

不在 Orca 终端里的普通进程（用 `env -i HOME=$HOME PATH=$PATH` 剥掉所有 ORCA_* 变量模拟）可以完成「建 Run → 启动受监督 worker → 阻塞等待 → 收到 worker_done → release」全流程。

**前提：只靠 `--run` 不够。** 外部进程没有终端身份，`run-create` 会直接拒绝。解决办法：外部进程先用 `orca terminal create` 给自己开一个空闲的「锚点终端」，之后所有需要身份的命令都带上这个终端的句柄（`--from` / `--terminal`）。这个锚点就是 osa 在 Orca 里的身份。

```
osa(普通进程) ──terminal create──→ 锚点终端(空闲 shell，句柄 = osa 身份)
     │ run-create --from 锚点          → Run.coordinator_handle = 锚点
     │ worker-start --run --from 锚点  → worker 终端(claude) ──worker_done──┐
     │ check --run --terminal 锚点 --wait  ←────────────────────────────────┘
     │ worker-release --dispatch      → worker 终端被关闭
     └ check --ack；锚点在服务停止时关闭
```

## 第一次尝试（只传 --run）：失败

```json
{"ok": false, "error": {"code": "no_active_sender_terminal",
 "message": "Could not determine the sender terminal for this orchestration command. Pass --from with your own terminal's handle — another pane's handle would act on its mailbox — or run the command inside a live Orca terminal with ORCA_TERMINAL_HANDLE set."}}
```
`run-create` 和 `worker-start` 都报这个错。`run-create` 根本没有 `--run` 参数，只能靠 `--from` 指定身份。

## 实际可用的命令序列

```bash
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
WT=path:/Users/mzg/orca/projects/Super-agent-orca   # 仓库早已注册，不需要 repo add

# 1. 锚点终端（osa 自己的身份）
$ORCA terminal create --worktree $WT --title osa-anchor --json        # → result.terminal.handle
# 2. 建 Run 并绑定到锚点
$ORCA orchestration run-create --objective "..." --from $ANCHOR --json # → result.run.id
# 3. 启动 worker（一次调用同时建 Task 和 Dispatch）
$ORCA orchestration worker-start --spec "..." --task-title "..." --worktree $WT \
      --agent claude --run $RUN --from $ANCHOR --json                  # → result.taskId / dispatchId，state=ready
# 4. 阻塞等待
$ORCA orchestration check --run $RUN --terminal $ANCHOR --wait \
      --types "worker_done,escalation,question" --timeout-ms 600000 --json 2>keepalive.log
# 5. 校验 worker_done 的 payload.dispatchId == 第 3 步的 dispatchId，然后：
$ORCA orchestration worker-release --dispatch $DISPATCH --json         # 没有 --from 参数
$ORCA orchestration check --run $RUN --terminal $ANCHOR --ack $DELIVERY --json
# 6. 查状态
$ORCA orchestration task-list --run $RUN --json                        # tasks[].status = completed
$ORCA orchestration worker-show --dispatch $DISPATCH --json            # dispatch.status=completed, worker.state=succeeded
$ORCA orchestration worker-list --run $RUN --terminal-state reclaimable --json   # workers=[] 表示没有残留
# 7. 服务退出时
$ORCA terminal close --terminal $ANCHOR --json
```

第 1–4 步由脚本完成；第 5–7 步是在同样剥掉环境变量的情况下手动执行的。worker 从启动到收到 worker_done 大约 17 秒。

## 关键 JSON 片段

run-create：
```json
"run": {"id": "run_d9790793fd60", "coordinator_handle": "term_c6e1ac98-...", "consumer_generation": 1}
```
worker-start（成功时退出码为 0）：
```json
"runId": "run_d9790793fd60", "taskId": "task_b6479c2dcb11", "dispatchId": "ctx_4d9658e03239",
"state": "ready", "stage": "input_accepted", "residualResources": [],
"effects": [{"kind":"terminal","role":"agent","action":"created","id":"term_2aec565a-..."}]
```
check 收到的 worker_done（注意 `payload` 是 **JSON 字符串**，需要再解析一次）：
```json
"deliveryId": "delivery_3939f05274b3",
"messages": [{"id": "msg_ea4412e016e8", "type": "worker_done",
  "from_handle": "term_2aec565a-...", "to_handle": "run:run_d9790793fd60",
  "subject": "p0-a worker-output.txt created", "body": "Created /tmp/p0-a/worker-output.txt ...",
  "payload": "{\"taskId\":\"task_b6479c2dcb11\",\"dispatchId\":\"ctx_4d9658e03239\",\"outcome\":\"succeeded\",\"filesModified\":[\"/tmp/p0-a/worker-output.txt\"]}"}],
"timedOut": false, "cancelled": false, "connectionLost": false
```
worker-release：
```json
"dispatchId": "ctx_4d9658e03239", "state": "released", "processAction": "closed_agent_terminal",
"archive": {"source": "transcript", "status": "captured"}
```

## 踩到的坑

1. **没有终端身份就建不了 Run**：必须用锚点终端加 `--from`（见上）。锚点会以可见标签页的形式出现在 Orca 界面里。
2. **`--worktree current` 对外部进程没意义**（它指的是协调者所在的工作区）。改用 `path:<仓库路径>`。
3. **check 必须带 `--terminal <锚点>`**。不带的话报 `consumer_fenced`（"This coordinator terminal is no longer bound to Run"），错误信息容易误导。check 不接受 `--from`。
4. **各命令的参数不统一**：`run-show` 用的是 `--id`，不是 `--run`；`worker-release` 没有 `--from`，不带身份也能执行。
5. **run-show 只返回 Run 本身的元数据**，看不到任务状态。判断「完成」要用 `task-list`（status=completed，result 里带 worker 的报告）或 `worker-show`。
6. **顺序**：使用说明要求先决定 worker 终端怎么处理（release），再 ack。这次我先 ack 后 release，没造成问题，但 osa 应按 release → ack 的顺序。
7. `check --wait` 每 15 秒往 stderr 写一行保活 JSON，stdout 只有最终结果，所以 stderr 要单独处理。
8. 锚点终端本身的深度是 0，它起的 worker 深度是 1（worker-show 里的 `depth: 1`），和 P0-B 的嵌套限制有关。

## 额外验证：锚点丢失后可以重新接管

关掉锚点，新开一个锚点，执行 `run-use --id $RUN --from $新锚点` 后，Run 的 `coordinator_handle` 换成新锚点，`consumer_generation` 从 1 变成 2，`check --terminal $新锚点` 正常返回。旧句柄会被隔离，不能再消费。

## 对 osa 实现的建议

- osa 启动时：确认运行时可用（`status --json`），然后开一个锚点终端并把句柄写进 SQLite。之后每条编排命令都**显式**带 `--run` 和 `--from/--terminal`，不依赖任何环境变量。
- 重启或锚点丢失时（`terminal show` 找不到，或 check 报 `consumer_fenced` / `no_active_sender_terminal`）：新开锚点，对每个还没结束的 Run 执行 `run-use --id <run> --from <新锚点>`，再继续用 check 消费。没 ack 的批次会重放，所以只要「先写库再 ack」就不会丢消息。
- 用一个 Run 还是一工单一个 Run：一个锚点可以同时绑定多个 Run 吗？这次**没有验证**（run-create 会把当前协调者绑定到新 Run，可能把旧 Run 挤掉）。建议 P1 先确认；如果不行，可以每个工单开一个锚点，或者一个 Run 下挂多个任务。
- 处理 worker_done：先解析 `payload`（字符串）→ 核对 dispatchId 和库里记录的当前派工是否一致 → 写库 → `worker-release` → `check --ack`。
- 判断结果看 JSON 里的 `ok` 字段和 `error.code`；`worker-start` 失败时按回执里的 `failedStage` / `residualResources` 处理，不要直接重试。
- 等待用一直循环的 `check --wait`；超时或返回空都只是一个检查点，不算失败。
