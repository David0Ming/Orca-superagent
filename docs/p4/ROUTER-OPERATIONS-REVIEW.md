# Router 日常运行复盘（2026-11-03）

范围：用户反馈「60 秒租约到期，Router 不派送」，核查指定 Claude Router 屏幕、当前 `.osa/p4-live` 状态和 Router → intake → route → Executor 路径。没有新增依赖、修改 vendor 或改变业务授权。

## 已修复：空闲后首次命令直接失败

现场 Router 明确报告登记第一步失败，未入库。原 `App.authorizeRouter` 同时检查 token 和 60 秒到期时间，导致无人接替时原 Router 也不能继续。技能依赖模型手动重新 attach，思考、等用户和回合间停顿都容易触发。

最小复现：`npm test -- tests/app.test.ts -t 'idle Router|replaced Router'`。先将当前租约设为已到期，再执行真实 `intake` 和 `route accept`；修复前失败于 `Router lease expired or invalid`。修复后原 token 若仍是当前 token，命令自动续租；60 秒仅决定另一 Router 何时可以 attach 接替。接替会更换 token，旧 token 即使在新租约过期后也不能直接写入。所有命令共用同一个授权函数，没有增加后台续租进程或简单拉长超时。

相关调用包括普通 Router 命令，以及 `project sync` 和 `router bind/unbind/status` 的独立入口；异步发现、绑定原有的返回前复核仍保留。测试还覆盖两次停顿后登记/派工、重放不重复、被接替后的拒绝，以及真实 Unix socket CLI 空闲后命令和服务重启。

## 已修复：领域状态容易被误读成执行占槽

Router 屏幕将两张报告 `blocked`、领域 assignment `running` 的工单描述为长期占用两槽。但数据库中这两次派工已 `settled/released/finished`；调度器实际按 `!binding.finished` 计算占槽，新的诊断派工 `ctx_8fd5db785b37` 已在运行。因此不能把业务尚未完成当成调度死锁。

`status` 新增 `executionBindings`，每条包含 `holdsExecutorSlot`，与调度器判断一致。技能明确要求根据该字段、实际派工和队列通知判断，不能为了释放已经空出的名额而取消业务工单。测试覆盖 `finished: true` 不占槽、仅 `released: true` 尚未完成收尾仍占槽。没有篡改上游领域状态，也没有新增超时自动取消规则。

调查过程中，原 Router 已按其记录的所有者裁决于 00:30:37 UTC 停止这两张业务工单；本修复保留该决定，不回滚或重新派发。不能用此后的业务停止倒推此前确实占槽。

## 尚未补齐：提醒送达与处理进展分离

`RouterWake` 对同一待办指纹保存一次原生提醒回执。回执不代表已读或业务处理完成；待办不变化时不会周期性再提醒。当前仍依赖 Router 返回 `router wait`、原生信箱确认和已有看门狗。本次未建立「提醒已送达后模型结束回合」的真实停滞复现，因此未把它当成本次错误的根因，也未增加可能造成信箱堆积的重复提醒。Router 换运行身份后的显式重新绑定要求仍在。

## 验证与生效

- 相关 5 个测试文件（app/router/cli/projects/orca）74 项通过，类型检查通过；最后补充派工前再次过期的断言后 app 9 项复跑通过。
- 修改前 SQLite 快照：`.osa/p4-live/before-router-lease-fix-1793665980079.db`。加载修复前后记录：`router-lease-fix-before.json` / `router-lease-fix-after.json`。
- 正常卸载/重装监督服务以加载源码；服务恢复运行。14 张工单身份保留，无新增派工，原诊断 Dispatch 不变，数据库 `integrity_check` 为 `ok`。
- 真实 socket 使用无效测试 token 返回新的拒绝错误，确认当前服务加载修复；没有读取并冒用 Router 的真实 token 做人工派工。
- 未重启 Orca、停止业务 worker、提交推送或发送飞书测试目标；真实 Router 的下一条用户命令尚未作为端到端验收。
