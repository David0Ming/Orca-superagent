# 2026-11-04：retry、Run 误用和空占槽位核对

范围：核对所有者反馈的真实停滞案例，修复 OSA 适配层；未修改 Orca、`patches/` 或 `vendor/dsh-core`，未恢复已放弃的自动接续架构。

| 问题 | 实际根因 | 本轮处理与边界 |
| --- | --- | --- |
| retry 修复是否生效 | 工作目录已有修复，但 OSA 进程从 12:22 一直运行，未加载 14:57 合入的代码 | 核对主目录和修复工作区一致；移除修复时两项回归测试确实失败；15:19 重载本地服务，现已加载。未实际发起新的业务 retry。 |
| `consumer_fenced` 后停工 | 日报、旧分支执行者创建子 Run 后，仍把父 Run 传给 `check --run`；把读信参数错误当成整个 Dispatch 失效 | 相同终端去掉 `--run` 的只读检查成功；修正新执行者的检查命令，保留对真正 superseded Dispatch 的停止要求。所有者明确授权后，15:22:53 向两个原执行者发送更正，均已收到。 |
| 空闲会话长时间占槽 | OSA 把 Orca 未运行时本地返回的 `runtime_unavailable` 永久缓存，每次轮询重复读旧失败；执行者又只确认消息、未继续或收尾 | 仅对 `id=local`、`runtimeId=null` 的明确本地未发送错误，用原 request ID 重试并保留旧错误证据；新提示说明进度确认后继续、等待子任务后继续，以及无法继续时报告并结束本次尝试。未用“界面空闲”冒充完成或强行释放。 |

## 验证

- 新增“缓存本地运行时断开后恢复轮询并释放已完成执行者”的回归。修复前失败，修复后通过；测试覆盖持久化状态、重启、收到真实格式完成报告、释放槽位且不重复启动 worker。
- 全套测试：18 个文件、365 项通过；`npm run typecheck` 通过。
- 服务于 2026-11-04 15:19:35 +08:00 加载新代码，子进程 PID 从 34285 变为 35454。
- 日报 assignment `375f4a0567de14e2f0ac8680829cecb0` 的轮询从冻结的 23477 恢复至 23568；旧分支 assignment `f34185472f081589e3a3a7ce04063f1a` 从 19418 恢复至 19509。两条旧操作均正常完成并移除，原始失败已归档，轮询错误通知已清除。
- 以上两个执行者尚未报告完成，`finished` 仍为 false；恢复轮询不等于业务已经完成，也不等于已经释放这两个槽位。
- 旧分支执行者收到 `msg_bc3679f60ebe` 后明确更正误判，实际执行 `worker-show`、不带 `--run` 的 `check` 和 OSA 工单读取，开始交接已有审查结果。
- 日报执行者收到 `msg_7acd259c01f8`。它在本次更正发送前已于 15:14 上报恢复推进；15:23 现场可见独立审查实际运行、报告侧 325 项测试结果，以及等待审查结果的 `check --wait`。不把它先前的恢复归因于本次更正。
- 15:24:45 再查：旧分支执行者已发现原审查后的工作区指纹变化，按其读取的既有授权启动当前快照复核 `ctx_d8546b07918b` 并持续等待；日报已收到审查 `worker_done`，正在处理缺少 `OSA_REVIEW` 行的回执。两者均有实际后续动作，不只是回复确认；领域完成和槽位释放尚未发生。

## 可追溯证据

本地私有目录 `.osa/stall-fix-20261104/` 保留：

- `before.json`：排查前相关记录。
- `pre-reload-151922.db`：使用 SQLite backup 接口生成的重载前一致性备份。
- `after-reload.json`：新服务身份、代码 SHA-256、两条轮询恢复结果。
- `daily-correction.txt`、`branch-correction.txt`：经所有者批准发送的更正文案；仅纠正工具用法，沿用原业务授权。
- `daily-sent.json`、`branch-sent.json`：原生投递回执和 request ID。Orca 将消息送至各执行者自己绑定的子 Run 信箱。
- `continuation-observed.json`：15:24:45 两个原终端的脱敏屏幕快照及 OSA 轮询状态。

六个槽位是 OSA 顶层 assignment 上限，界面显示正在生成的窗口数不是这个计数。当前恢复验证没有为了填满六个槽位而创建新任务。代码和服务恢复已有证据；原业务续跑、最终收尾和槽位释放仍需现场验证。

## 16:33 再体验后的需求复核：未通过

所有者再次反馈多处卡点。重新读取 Router 会话、原始输入、OSA 状态和原生 worker 记录后，确认 15:24 的“已续跑”不能作为业务完成或产品达标的证据。

| 实际工作 | 后续结果 | 16:33 的事实 |
| --- | --- | --- |
| 旧分支收敛 | 15:28 提交 ready，业务 completed，binding finished | 本案例收尾成功。 |
| 日报部署 | 15:25 提交 blocked，原因包括审查回执缺少认证行、两轮内无法登记批准 | 原生 Dispatch failed、进程 exited；OSA 已有 settled，但未 released/finished。15:36 的“目标是完成部署”未投递、未读取。 |
| 四日质检 | 数据已产出；15:22 因两轮审查拒绝及剩余修正提交 blocked | 原生 Dispatch failed、进程 exited；OSA 已有 settled，但未 released/finished。15:33 的“能稳定跑出质检表就行”未投递、未读取。 |
| FAQ 设计后实施 | 设计审查通过，15:38 提交 waiting；所有者 15:41 确认方案 | 原生 Dispatch completed、进程 exited；OSA 已有 settled，但未 released/finished。确认输入超过 50 分钟未投递、未读取。 |

三个未收尾 binding 的共同错误为 `Child worker resources remain unresolved; inspect before recovery`。各自子 Run 都有一个 `terminalState=retained` 且 liveness `unverifiable/missing_status` 的审查 worker。不能把这个状态直接当成进程已经退出，也不能为腾槽强制关闭用户接管的窗口。

实际阻塞链：`assertChildrenReleased` 只允许 `released` → `poll` 不能完成父任务资源收尾 → `binding.finished` 一直不成立 → `sendInputs` 在已 settled、未 finished 分支直接返回 → 所有者后续输入停留在队列，顶层容量持续占用。代码位置为 `src/orca.ts` 的 `assertChildrenReleased`、`poll`、`sendInputs`。

Router 15:34、15:37、15:41 仍用“执行者还活着，下一次轮询会读到”解释日报和质检等待。这与原生已结算状态和没有投递回执的事实不符。技能要求区分 queued/delivered/read，但这轮真实行为未遵守；仅增加提示语不能视为已修复。

另一类阻力是审查规则本身：`src/review.ts` 的两轮硬上限、`src/orca.ts` 的两轮内未建立认证则 blocked 指令，把审查格式修复和业务执行绑在一起。独立审查是既有要求；不能用本次不满推定可以全部关闭审查或接受伪造通过。应重新区分实质缺陷、回执格式错误、所有者已经作出的范围裁决，并用真实工作线验收能否继续推进。

本次仅完成复核和记录，未新增代码、重启服务、关闭资源或续跑已被所有者叫停的业务。Router 15:49 的回复已明确确认停止日报和质检，本次调查不撤销该停止。
