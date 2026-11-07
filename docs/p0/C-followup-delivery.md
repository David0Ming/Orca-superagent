# P0-C 给运行中的 worker 补发消息

## 结论
**通过。** 补发的消息能可靠送到正在运行的 worker，worker 在下一次检查邮箱时就能收到并据此行动。`/tmp/p0-c/received.txt` 和发出的正文逐字节一致（用 cmp 比过），worker 也回报了 worker_done（succeeded）。
**「worker 已读」目前拿不到可靠信号**：发送方能看到的 `read` 字段始终是 0，`delivered_at` 只表示消息进了邮箱，不代表 worker 读了。

## 命令序列（Orca 1.4.227）
```
orca orchestration run-create --objective "..." --json                 # → run_2ad85fb9e227
orca orchestration worker-start --run <run> --worktree current --agent claude --spec "<轮询邮箱直到收到主题 followup…>" --json
                                                                        # → dispatch ctx_e9c39eeedf7c, terminal term_0662…
# worker 内部：每 5 秒执行一次 preamble 里给的 check 命令
orca orchestration check --terminal <worker_handle> --json
# 外部发送
orca orchestration send --to dispatch:<dispatch_id> --run <run> --subject followup --body "<正文>" --json
# 查看状态
orca orchestration inbox --json                                          # 发送方视角：read / delivered_at
orca orchestration worker-list --run <run> --json                         # workerState=succeeded
orca orchestration worker-release --dispatch <dispatch_id> --json
```

## 消息 JSON 关键字段
| 位置 | 字段 | 观察到的值 | 含义 |
|---|---|---|---|
| send 回执 | `message.id` | msg_e3a1532a4247 | 消息 ID |
| send 回执 | `delivered_at` | null | 刚写入库，还没挂到投递批次 |
| inbox（发送后立刻查） | `delivered_at` | 08:19:35Z（和 created_at 同一秒） | 已挂到收件人的投递批次，**不是已读** |
| inbox | `read` | 0，worker 读完、发完 worker_done、我又补了一次 ack 之后**仍然是 0** | 不能当已读回执用 |
| worker 侧 check | `deliveryId` | delivery_d14fcb464753 | 这一批消息的投递 ID，确认收到用 `check --ack <deliveryId>` |
| worker 侧 check | `acknowledged` / `replayed` | null / false | worker 没 ack，所以下一次 check 会把同一批再发一遍 |
| inbox | `type` | 没指定 --type 时默认为 `status` | |

## 延迟
- 08:19:35 发送 → 08:19:39 worker 写出 received.txt（约 4 秒，受 5 秒轮询间隔限制）→ 08:19:51 收到 worker_done。
- 投递完全靠 worker 自己去拉（轮询或在检查点调用 check），不会打断 worker 正在进行的工作；send 附带的唤醒只是尽力而为。

## 坑
1. **共享协调者终端会被抢绑定**：我和 P0-A、P0-B 在同一个父会话终端里跑，P0-B 后来也执行了 run-create，把这个终端改绑到了它的 Run。之后我执行 `check --run <我的run>` 被拒，错误是 `consumer_fenced`。一个终端同一时间只能做一个 Run 的协调者。好在 inbox、worker-list 这类只读命令不受影响。
2. **`read` 和 `delivered_at` 都不能当已读回执**（原因见上表）。
3. worker 不 ack 时，同一批消息会被反复重发，worker 必须按消息 ID 自己去重。
4. worker_done 之后 worker-list 显示 `terminalState=retained, retainedReason=user_takeover`，release 返回 ok，但状态没变；可回收列表（reclaimable）为空，说明没有欠下的清理工作。原因没查清，猜测是在 worker 运行期间读取它的屏幕被算成了用户接管。
5. 默认 claude worker 会把轮询放到后台 shell 里跑；终端显示空闲不等于它没在工作。

## 对 osa「送达 / 已读」的建议
- **送达** = `send` 返回 `ok:true` 且拿到 `message.id`（Orca 保证消息已持久入队）。在 osa 的派工表里把这个 ID 记成「已投递」。
- **已读**：不要依赖 Orca 的 `read` 字段。在 Executor 提示词里约定：每处理完一条后续消息，就用 `send`（不写 --to，默认发到所属 Run 的邮箱）回一条 `type=status`、正文带原消息 ID 的确认（或者直接用 thread-id / payload 字段带上），osa 收到确认才标记「已读 / 已处理」。worker 也应该 `check --ack`，避免重复处理。
- osa 是独立进程，**每个 Executor 必须单独占一个协调者身份**，不要和别的 Run 共用一个终端，否则会撞上 consumer_fenced；读状态尽量用 inbox / worker-list 这类不会被拦的只读命令。
- 延迟上限 ≈ Executor 的检查点间隔，在提示词里规定「每个子步骤之间都检查一次邮箱」。
