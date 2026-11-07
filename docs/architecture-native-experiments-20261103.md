# 三项 Orca 原生能力实验

2026-11-03。结论：可以复用原生 retry、mailbox 和资源身份机制；不能把普通 status 当成当前 Dispatch 的可信业务报告，也不能把渲染 history 当成无损用户提交日志。领域接受回执依然需要 OSA 保存。

本轮是隔离实验，不是生产修复。使用 Orca 安装版 1.4.227 对应 commit `7c19f712f77ba9fa629ccf0abb9a50503c8c3750` 的干净 git archive；未带入源码工作树中的配套资源补丁。测试使用原生 journal/dispatch/mailbox 数据库和 RPC handler，运行时/PTY 查询使用原生测试夹具。没有创建真实 agent、修改业务任务或重启服务。

## 1. 用户提交跨 epoch 恢复：未满足

控制场景：appendSubmission → accepted → 关闭并重开 journal，提交仍在，测试通过。

缺口场景：消费者保存旧 cursor 后离线；原生 journal 接收一条 user submission 并标记 accepted；调用原生 rollEpoch(handle_forked)；消费者按旧 cursor 恢复。

结果：history 明确返回 epoch_changed；旧 epoch 的数据库行数为 0；当前 submissions 为 0。断言“消费者仍可找回 owner-1”失败。当前 history 接口没有提供足以补齐该消息的证明，不能把 reset 后读取新 tail 当作已经恢复完整输入。

原生 `journal-cursor` 的压缩边界检查通过；但本版本 `journal-open.ts` 明确当前 journal floor 保持 1，本轮没有运行一个真实的压缩/归档流程，也没有据此断言所有其他存储都不存在副本。已复现的 epoch rollover 缺口本身足以否定 history 单独保证无遗漏的方案。

实施决定：复用 Orca submission 写入点，补独立于渲染 epoch 的提交留存/消费确认契约及可信来源。先证明任何已有更长寿命存储能否补扫，不能直接推断必须另造全套聊天日志。不可恢复 gap 必须显式保留并阻止依赖该区间完整性的自动授权/完成。

## 2. 同 Task retry 身份：原生能力通过，OSA 接入仍有缺口

新增实验通过真实 `createStartingWorkerDispatch`、`prepareStartingWorkerAuthority`、`failWorkerStart` 和 retryOf 路径验证：

- retry 保持相同 Task，创建新 Dispatch，retry_of_dispatch_id 指回前驱。
- 前次启动失败计数 1 被新 Dispatch 继承；没有通过换 Task 重置。
- 为两次尝试附加的不同 launch-token hash 和 process incarnation 被原生持久记录；旧进程身份不能通过新 Dispatch 的 isDispatchProcessCurrent。
- 原生六项 failed-start 熔断测试通过，包括第三次失败后拒绝第四次 retry。
- 原生启动路径的一项单独测试通过，确认 Codex PTY 启动环境注入 ORCA_AGENT_LAUNCH_TOKEN；它使用模拟 spawn，没有启动真实 Codex，因此不代表任意真实 worker CLI 都已验证可读取该环境变量。

进一步做了传输反例：旧发送者通过普通 status payload 声称来自新 Dispatch。原生 send handler 接收了消息，保留 from_handle=term_old，但没有拒绝伪造的 payload.dispatchId。相同情形的 worker_done 原生生命周期消息被拒绝，控制测试通过。

这不是“Orca 普通消息有 bug”的结论，而是证明其契约不等于 OSA 想要的业务写入认证。OSA 若把 payload.dispatchId 直接当当前尝试证明，就会出错。测试模拟运行时身份查询，没有覆盖恶意进程、真实 IPC attestation 或全部启动竞态。

源码还确认 dispatchShow 返回当前原生 Dispatch，包括 launch-token hash；现有 Orca 自己已有环境证据和 hook attestation。下一步应优先复用这些身份校验点，验证带原生认证来源的报告/请求适配，保留同 Task retry。不把 launch secret 写进日志或普通 mailbox body，不把只读 hash、自报 handle 或旧 OSA token 当新尝试凭据；也不能为了借用校验而把普通进度伪装为 worker_done。

因此，不需要仅为“获得新 Dispatch 身份”换原生 Task；但当前 OSA socket/read/report 的可信身份接入尚未实现，不能声称已经完成旧 worker 隔离。

## 3. mailbox 与领域回执：三个真实进程崩溃点通过

实验用真实 Orca OrchestrationDb 持久 mailbox 方法、OSA App/Store 与未修改的 DSH core；在隔离副本中增加最小领域 receipt 原型。生产源码未修改。

生产者在领域消费者不运行时写入 mailbox 并退出。消费者取 delivery，使用同一 OSA SQLite 事务执行 App.handle(report ready) 并保存固定 reportId + payload hash + 接受结果，随后 ack 原生 delivery。receipt 是新增的实验逻辑，不能说现有生产 OSA 已有此保证。输入使用受控主体 fixture，不验证真实请求认证；two-layer review 未启用。

| 注入的真实 SIGKILL 时点 | 恢复前：receipt / 结果出站消息 / 原生 unread | 新进程恢复结果 |
| --- | --- | --- |
| 取 delivery 后、领域提交前 | 0 / 0 / 1 | 原生重放，首次接受，最终 1 / 1 / 0 |
| 领域事务提交后、原生 ack 前 | 1 / 1 / 1 | 原生重放，返回已存 receipt，最终仍 1 / 1 / 0 |
| 原生 ack 后 | 1 / 1 / 0 | mailbox 为空，不重复处理 |

每个场景最终只有一个领域接受回执、一条 DSH/OSA 结果 outbox 消息，工单 outcome=completed。再启动消费者没有新消息。故障由消费者自发 SIGKILL，随后使用新的 Node 进程重开两份数据库，不只是同进程 close/reopen。

它证明的是“原生 mailbox 已成功持久接收以后，领域消费者进程崩溃可恢复”的组合路径。没有经过真实 Orca CLI/socket 送达；没有验证 Orca 本身不可用、发送前崩溃、系统断电、原生 WAL NORMAL 的断电耐久性、乱序/永久拒绝、review 并发、远程链路或对外显示恰好一次。结果 outbox 中只有一条，不等于用户界面已经显示一次。

实施决定：针对 OSA 服务停机，优先复用 Orca mailbox，OSA 增加共同业务接受路径与原子 receipt；不先新建第二套本地报告队列。若要求 Orca 也不可用时仍能成功排队，保留窄本地 outbox 作为另一故障边界的需求，不能用本实验宣称覆盖。

## 检查、证据与下一步

- 8 个原生/实验测试文件：39 项通过、2 项需求断言失败。两个失败分别是 epoch rollover 保留和普通 status 身份认证，属于已确认能力缺口，原样保留作为后续验收用例。
- 启动环境测试：1 项通过、1341 项因筛选未运行；不是全套运行时回归。
- 进程级 mailbox 故障实验：3 个崩溃点全部通过。

证据、测试源、OSA 实验源码快照、执行命令和进程日志归档于 `.osa/architecture-fix-20261103/native-experiments/`，入口说明为该目录 README.md。原始测试目录是临时目录，关键证据已持久保存。

最小实现路线已有实验支撑：修 OSA 的旧回执/异步写入前驱保护；复用 Orca 同 Task retry；接入可核验的原生尝试身份；复用 mailbox 并实现 OSA 领域回执；补原生提交来源及跨 epoch 留存契约。DSH 继续持有业务状态，责任与消费记录作为差量保存。仍需真实原生 canary、认证和 review/撤销竞态、完整 T1–T12 才能发布，不能将本轮实验称为全需求完成。
