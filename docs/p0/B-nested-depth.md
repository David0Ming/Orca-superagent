# P0-B 嵌套深度验证

## 结论（通过）

- 默认值下的拒绝：**已验证**，拿到 `nested_worker_depth_exceeded`。
- 调成 2 后两层回报：**已验证**（用户在 GUI 里手动改成 2 后跑了第 3 轮，结果见文末）。

## 设置入口与取值

- 位置：Orca 桌面端 → 设置（Cmd+,）→ Orchestration（编排）→ **Nested worker depth（嵌套工人深度）**。说明文字是"多少代的派遣工可以再起自己的工人。1 保持智能体树平坦"。
- 范围 1–21，默认 1。
- 原值：**1**（真正生效的存储是 `~/Library/Application Support/orca/profiles/local-default/profile-state.db`，settings 文档里的 `nestedWorkerMaxDepth`，只读查过）。
- 新值：**2**（用户手动改，已保留；profile-state.db 里已读到 2）。
- 坑：同目录下的 `orca-data.json` 写的是 `nestedWorkerMaxDepth: 2`，但它是旧版导出的副本，不生效。别被它误导。

## 深度怎么算

协调者起的 worker 是第 1 层，这个 worker 再起的就是第 2 层。上限 = 1 时，worker 里调 worker-start 会被拒（报错是 "depth 2 (max 1)"）。上限 = 2 时应该允许 Executor 再起一层子 worker，正好覆盖方案的两层结构。

## 命令序列（第 1b 轮，默认值）

```
orca orchestration run-create --objective "..." --json                 # 协调者 Run
orca orchestration worker-start --spec "<外层 spec>" --worktree current --agent claude --run <RUN> --json
# 外层 worker 内部：
orca orchestration run-create --objective "child run" --json             # 必须先建自己的 Run
orca orchestration worker-start --spec "<子 spec>" --worktree current --agent claude --run <CHILD_RUN> --json
```

## 错误原文

```json
"code": "nested_worker_depth_exceeded",
"message": "Sub-worker dispatch is not permitted at depth 2 (max 1). Complete this task yourself. ...",
"data": { "effectsApplied": false, "nextSteps": [
  "Do the work in this terminal instead of dispatching a sub-worker.",
  "To allow deeper nesting, open Settings → Orchestration in the Orca desktop app and raise \"Nested worker depth\"." ] }
```

## 坑

1. **worker 必须先建自己的 Run**。第 1 轮外层 worker 直接调 worker-start（没带 `--run`），报的是 `consumer_fenced`："worker-start requires the coordinator terminal currently bound to the Task Run."。原因是它被默认挂到了上层的 Run 上，而它不是那个 Run 的协调者。建新 Run 不会重置深度。
2. `orca computer` 拿不到窗口：Orca 和 Finder 用 list-windows 都返回空列表，系统事件（System Events）却能看到 Orca 的窗口。多半是 computer-use 缺屏幕录制/辅助功能授权，或者窗口在别的桌面空间上。所以 GUI 设置暂时没法自动化。
3. 设置没有 CLI 入口，`orca --help` 和 worker-start 的帮助里都没有深度选项。

## 第 3 轮命令（改成 2 之后再跑）

外层 spec 要点：先 run-create 建子 Run，再在子 Run 里起 `--agent claude` 子 worker（spec：立即发 worker_done --outcome succeeded），然后用 `check --wait --run <CHILD_RUN> --types worker_done` 等子 worker 回报，收到后 worker-release 子 dispatch，最后发自己的 worker_done。最外层用 `check --wait` 收外层的 worker_done，收到后再 release。

## 对方案的影响

- 两层执行在机制上是成立的，前提是部署时把深度设成 ≥2。这是每台机器一次性的 GUI 设置，必须写进安装文档。
- Executor 的 prompt 里要写明：先 `run-create`，再 `worker-start --run`；自己负责等子 worker 的 worker_done 并 release。
- 改成 2 之前就能确认：深度不够时 Executor 能拿到明确的错误码和"自己做"的提示，可以按这个降级成"自己做"，或者走 `osa spawn` 扁平退路。

## 第 3 轮结果（深度 = 2）

- 外层 worker `ctx_183885b06311` 先建了子 Run `run_045e3f8a196d`，再 worker-start 起子 worker `ctx_5e205995afe7`，退出码 0，没有被拒绝。
- 子 worker 回报 worker_done `msg_b2b77073dce6`（outcome succeeded）。外层收到后把它 release 了，然后发了自己的 worker_done `msg_4f7d88615560`。最外层（协调者 Run `run_e99d5357f425`）收到了，随后 release 了外层 worker。
- 两个 Run 都没有残留需要回收的 worker 终端。
