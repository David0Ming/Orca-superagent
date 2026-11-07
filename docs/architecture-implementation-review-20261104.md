# 可靠性实施独立审查（2026-11-04）

结论：当前改动已有原生提交保留、受管 Run、mailbox 和 OSA 接管的实现骨架，但**存在阻断完整需求的 P0**，不宜根据 352+9+3 项局部通过进入发布。以下是审查时点的具体反例与修复位置；主窗口仍在并行修改，行号和哈希代表本轮读取快照，修复前应重新核对。隔离 Orca 的独立 Git HEAD 是 `8dc0334c`（提交说明为 `Isolated Orca baseline ec7da75d`），不是原仓库 commit 对象本身；它有未提交实施改动，审查未修改它。

## P0：输入与授权

### 1. 撤回/编辑只增加新 Trigger，旧授权仍可被接受

`src/native-inputs.ts:67-85` 将 `queued`、`edited`、`withdrawn` 分别存为独立 human Trigger，仅在 meta 写 `revises`。`src/app.ts:193-219,235-253` 接受/attach 时没有检查原消息的最新修订或撤回。反例：owner 排队发送“执行操作”，随后撤回；两个事件都登记后，Router 仍可 `route accept --trigger native:s:1` 创建原操作工单。**隔离实测该应该拒绝的断言失败。** 已发出外部动作无法撤销，但在撤回事件已被 OSA 登记后，尚未执行的旧授权不能继续启动。

最小修法：以 `(sessionId,messageId)` 维护当前有效事件、修订及撤回状态；事务登记新事件时使旧 trigger 的可授权性失效，保留原文及审计映射。`route accept/attach`、计划/派工、review/ready 和外部动作提交前检查对应 revision，发生变更则等待 Router 根据新输入重新决定；已执行/进行中的动作只按实际语义撤销或对账。区分已提交排队消息与真正未提交草稿，不能仅按 `queue` 名称一律推定为新授权。测试覆盖 edit、withdraw 与 accept/dispatch 的三种交错及重启。

### 2. 来源未知的消息被记下但可绕过 ready，且 ack 可消除唯一告警

`src/native-inputs.ts:70-72` 将 unknown 存 `native-origin` notice 后返回，不创建可路由的输入责任；`src/app.ts:116-118` 的 ready 门禁只检查 `unroutedNativeInputs()` 和 `input-gap`。`src/app.ts:159-164` 的 `router ack` 又能删除该 notice。反例：unknown 消息可能是 owner 的“停止”，barrier 已消费它，工单仍被 ready 完结。**隔离实测 unknown notice 存在时 ready 仍成功。**

修法：unknown 不能自动被当作人类授权，但必须保留不可被通知 ack 消掉的来源核查/归属责任；ready 和续派对可能相关的未决来源 fail-closed。记录显式核查结论及原事件，以 scope/session 归属界定影响；可证明无关的 ticket 不应被全局阻塞。排查真实来源时核验 `journal-input-stream.ts:22-35` 的 `getActiveRpcCaller` 在真实 desktop/paired RPC、异步队列、后台重放时的值；现有测试人为包 `runWithActiveRpcCaller`，不能证明所有真实路径正确。automation 必须可靠区分，不能把 bootstrap/系统事件提升为 owner。

### 3. 明确停止事件未先对受影响 Task 执行 fence

原生 `journal-input-stream.ts:35-36` 只把 stop 作为输入事件写账本；OSA `src/native-inputs.ts:72-85` 将 stop 变成普通 Trigger/通知，没有同步经 `acceptNativeFence` 关闭受影响 generation。**正在处理的 worker 仍可在 Router 语义处理前读写或报告。** 同一 barrier 后、领域 ready 前的 stop 若尚未被消费，也没有跨服务停写屏障。这里的原生会话 stop 需要先确认它代表“停止本轮对话”还是“停止某业务 Task”，不得把每个 UI 停止错误扩展到所有项目；若 UI 提供了针对受管 Task 的明确 stop/暂停，它必须在原生动作前统一走受管 fence。

修法：把具有明确 task 目标的面板/CLI stop 统一接入第 4 项前置 gate；自然语言与目标不明的 stop 先登记为未决并仅对可能相关操作保守等待。同步留存请求与受影响范围，Router 负责解释而非决定是否遗漏 fence。测试覆盖 stop 在报告 review 中及 OSA 离线时到达。

### 4. 单一来源的 gap/待归属消息全局卡住所有 ready

`src/native-inputs.ts:29-46` barrier 遍历所有已注册 session，任一不可读就整体抛错；`src/app.ts:116-118` 对所有 `unroutedNativeInputs` 或任意 `input-gap` 一律拒绝每个 ticket。反例：已经明确独立的 B 的输入源损坏/待归属，A 的 ready 也被永久阻塞。安全地等待目标不明的消息是合理的，但不能在已有足够归属证据时仍把所有任务串成一个故障域。

修法：保留事件→来源/目标、相关性及每源 watermark；ready 检查当前 ticket 可能受影响的已确认水位与未决事件。目标确实不明时记录 Router 处理责任，不能凭猜测放行；可证明不同会话/项目且无交集的工作应继续。需明确 barrier 后输入和关闭旧 session 的处理，不能简单删除失败来源。

## P0：受管重试、资源和身份

### 5. 面板同 Task retry 的 fence 没有复用 OSA 的安全前置检查

OSA `src/orca.ts:40-80,96-112` 的 `route retry` 检查 owner 状态、容量/依赖、native `worker-show` 和子 Run 资源。原生面板/CLI 路径在隔离 Orca 的 `src/main/runtime/rpc/methods/orchestration/worker/local-worker-start.ts:142-157` 直接请求 `fenceManagedRun`，其回调 `src/worker-authority.ts:17-33` 对 start 只确认 ticket open 和 assignment 最新，随后原生可启动；没有调用 OSA 的 `canStart`、workspace/依赖、输入 barrier、旧 worker 活性和 `assertChildrenReleased`。原生 `retried-worker-terminal-release.ts` 的旧窗口回收是异步、并不等待完成；native failed 也并非物理退出证明。反例：原执行的子 worker 仍在写工作区，用户面板 retry 启动新 worker，两者同时改同一位置；或者新暂停/补充尚未消费，面板仍启动旧范围。

修法：不要只在 Router 的 `route retry` 检查；把所有受管 start/retry（面板、CLI、自动）接入**同一个异步准入与持久 fence 协议**：先关闭旧写代，再检查最新 scope/stop/input barrier、实际目标与资源、原生当前 Task/Dispatch、旧进程与子资源退出、已发生外部效果；确认后颁发与前驱/版本绑定的一次性 start intent。失败/未知保持 fence 并说明等待条件，不仅靠本地 `finished`。`acceptNativeFence` 当前是同步事务，耗时 native 查询应放事务外且最终在启动消费时 CAS；避免把慢调用放 SQLite 事务。使用真实原生面板与模拟残留 child 的隔离测试。

### 6. 原生 worker 身份验证缺少 caller 与 Dispatch 的进程身份绑定

隔离 Orca `src/main/runtime/rpc/methods/orchestration/managed-methods.ts:11-37` 对 terminal 先 `verifyOrchestrationCompatibilityCaller` 得到 caller 的 `paneKey/processIncarnation`，却只用 `getActiveDispatchForTerminal(handle)` 查 Dispatch，随后检查 managed run/dispatch；没有把 attested pane/incarnation 与该 Dispatch 的 `assignee_pane_key/process_incarnation` 比较。session 分支同样计算新 `incarnation`，但没有证明它等于该 Dispatch 的已绑定 incarnation。反例：同一 handle/session 恢复或重用后，新进程的证据能通过自身校验，但旧的 active Dispatch 仍按 handle 被找到；它可能作为旧 Dispatch 获得 OSA 写权。这是身份交叉绑定缺口，**不是已验证可跨同 UID 窃取凭据**；真实 handle 复用可达性仍需 canary。

修法：在 Orca 发证明前按 dispatch 的真实 authority 校验 pane + process incarnation（terminal 可复用 `isDispatchProcessCurrent`，structured session 使用其现有 session/dispatch incarnation 绑定与 lease fence），并拒绝旧 incarnation、重建/clear、跨 host 或运行态不可证明的情况；最终 OSA 事务仍检查 generation、assignment、scope revision。增加真实 PTY 和 structured session 重启/复用旧 handle 的负向测试；仅 hash 是否不同的 DB 单测不足以证明真实身份。

### 7. 变更围栏入口覆盖和外部动作并发尚未证明

隔离 Orca 的 `managed_dispatch_admission` trigger 保护新 dispatch 插入，`worker-stop.ts` 对常规 stop 调用 fence；`beginWorkerStop` 有数据库断言。这是有价值的防线，但本轮没有发现能证明**所有**面板、CLI、federated、context-only 变更和紧急停止统一接入 gate 的端到端测试。不能仅凭 trigger 推断“所有 stop 都已 fenced”：trigger 只覆盖 INSERT。`src/publish.ts:78-94` 在检查后跨 `git push`/远端 PR 请求；期间 fence 仍可提交，已启动的外部操作会晚完成。

修法：列举并测试每个真实入口，缺少统一 gate 的入口 fail-closed；尤其允许紧急物理停止时必须先持久 pending fence 并禁止新代写。对 OSA 已进入外部调用的动作，fence 必须等待其达到可对账边界，或把动作 intent 标 unknown 并阻止相关 successor；不能声称 fence 撤销了已发出的 push。这里是**覆盖未证明及可构造异步窗口**，不是断言已经找到每个面板绕过入口。

## P0/P1：报告可靠接管

### 8. 原生 reserve 与 enqueue 分两次 RPC，reserve 后进程退出可长期卡住报告

`bin/osa.ts:221-229` 先 `workerReport reserve` 再 `enqueue`；隔离 Orca `managed-report-methods.ts:29-47` 将 reserve 的完整报告和 sequence 持久化，但仅 enqueue 才插 mailbox 消息。进程在 reserve 之后、enqueue 之前崩溃时 `managed_reports.message_id IS NULL`，没有 mailbox 可被 OSA `Reports.takeover` 消费；其他 report 由于第 34 行 `prior_reservation_unresolved` 一直被拒绝，且没有看到服务端的过期恢复或入队重放工作。CLI 原封不动重试同 ID 能恢复，但 worker 已退出时不应依赖手工重挂。

修法：首选一次经过认证的原生事务**同时分配序号、写 report 与 mailbox**，复用同 ID/hash 及请求回执；不需要单独 reserve。若为强制发送顺序保留 reservation，则在 Orca 或 OSA 自动扫描并幂等完成原 reservation，覆盖 worker 退出/重启/旧尝试失效，并对永久无效 reservation 写终态以消除 gap。清晰区分 reserve 成功但 CLI 未声明 queued 与“已可靠入队”；不可把上轮仅在 mailbox 已入队后的 SIGKILL 测试套用到此窗口。

### 9. 永久业务拒绝被归类为暂时错误，同 assignment 后续报告被无限阻塞

`src/reports.ts:69-90` 只对 `ReportRefusal` 终结并推进高水位，其他所有异常每 15 秒重试原项。`src/app.ts:12-15` 的 `required()` 抛普通 `Error`（如缺 `summary`），`ReviewGate` 及 `Publisher` 也有普通领域拒绝。反例：序号 1 的 report 格式永久错误，序号 2 合法，序号 1 永远 pending、2 永不处理。**隔离测试以对应普通错误模拟该路径，断言终态拒绝和后续处理均未满足。** 不能把所有 `Error` 改成拒绝：网络、数据库、暂时 unavailable 等应继续重试。

修法：在接管边界做受约束的 schema/必要字段验证；将可确定、不可自行恢复的领域错误统一为 typed refusal，事务记录原因与消费高水位，通知执行者重读并重新报告；区分可恢复 review/输入等待与瞬态 I/O，限制重试并暴露具体责任。以真实 `App.handle` 和 review 拒绝、瞬态失败混合顺序做测试，不仅 mock 一个错误。

### 10. 默认 report ID 以全文哈希推导，不表示一次独立报告

`bin/osa.ts:222-228` 未传 `--id` 时对 `[evidence,fields]` 哈希。反例：同一 worker 先报告 progress A，再报告 B，之后真实重报 A（例如恢复到同一症状）；第三次自动得到第一次的 reportId，被原生当旧请求重放，根本不会写新 sequence，当前仍显示 B。固定 ID 的用途是重试同一请求，不应把两个时间上独立且内容相同的请求当同一次。

修法：每个逻辑报告生成独立 ID 并在首次提交前可恢复（例如要求调用方生成并持久复用，CLI 明确返回 ID；或在现有执行上下文安全保存待提交 ID），对确认失败/unknown 的重试才复用。切勿把 token/evidence 输出到日志。测试 A→B→A 和同 ID 失去响应重放应得到不同/相同的正确结果。

## P1：快照、来源和异常范围

- `src/app.ts:102,122-123` 的 read/ready 与 `authenticateWorker` 只比较 scope 字符串、输入列表，没有单调 scope revision；A→B→A 且输入快照未能反映修订时旧 read/异步操作可误通过。应对范围、停止、已关联输入变更维护 ticket 单调 revision，read/review/publish/final 事务校验。历史 `scope-revision` 是按 trigger 的记录，不能自动替代连续版本。
- 输入流在绑定后才注册：`journal-input-stream.ts:20-21` 未注册直接忽略；OSA `bin/osa.ts` 在绑定/服务启动后异步注册。首次启用和会话迁移之间的已提交输入无法靠新 stream 证明完整。主窗口正在实施迁移；必须明确可靠接管起点、注册前的历史标 unknown 并禁止静默宣称全量；如需覆盖迁移间隙应在原生入口先注册或可证明地回填。
- 当前服务对所有绑定来源做 barrier，且 ready 前只等待 OSA 读到源的部分事实；GitHub/飞书并行 15 秒轮询没有在 ready 返回已确认来源水位。应按计划明确“截至已确认水位”，不能说跨全部渠道全局原子。停止后的新输入是否恢复必须有明确恢复决定；审查时 `src/native-inputs.ts` 的新增 router-pause 路径仍在变化，需复查不得让任意普通 submission 自动解除明确暂停。
- 真实 worker 环境与 session proof 的传递、过期、Orca 重启、受管配置以及原生修改版本协商尚无端到端证据。`workerEvidence()` 缺少环境凭据时正确报错，但不能据此证明真实 Codex/structured session、命令行与 UI 模式都有凭据。

## 实际隔离验证与证据

- 快照：在 `/tmp/osa-impl-review-IyG2mK` 复制当时 OSA 源码（不含 `.osa`、`.git`，只链接 node_modules），未运行生产服务或业务任务。源码哈希留在 `.osa/implementation-20261104/review-evidence/osa-snapshot.sha256`。并行实施继续进行，当前源码可能已有后续更改。
- 在临时副本现有 `tests/reliability.test.ts` 尾部追加三个需求断言，命令：`rtk proxy node node_modules/vitest/vitest.mjs run tests/reliability.test.ts -t REVIEW`。结果 **3 failed、9 skipped，exit 1**：unknown 来源可 ready、普通永久错误没有拒绝且阻塞后续、已撤回旧 trigger 仍可 accept。新增测试与完整输出分别在 `.osa/implementation-20261104/review-evidence/review-tests.append.ts.txt` 和 `osa-review-tests.log`。第二项以真实 Reports 消费器 + 模拟普通 Error 测试错误分类，具体 `required()` 真实调用路径另经源码核查；非真实 Orca/IPC canary。
- 上述 native 身份绑定、retry 入口和 reserve 崩溃为源码级反例/推论，未做真实原生 UI 或进程故障实验；应在隔离 Orca 测试中先复现、修后通过。没有重跑 352 项全量回归，也没有读写 `.osa/p4-live`、安装 Orca 或业务服务器。

建议主窗口优先处理 1、2、3、5、6、8，随后以 9、10 和真实来源/多渠道水位补齐完整闭环；按一个集成版本运行真实身份、面板 retry、输入撤回、双进程报告故障和 T1–T12 组合验收后再发布。

## 2026-11-04 跟进审查：受管启动与 structured worker

本节基于后续实施快照，**取代上面与本节冲突的旧描述**；上一节 findings 1/2/8/9/10 已由主窗口修改并新增测试，本次没有重新验收它们。当前结论：前置 fence 和首次 structured worker 的 at-rest 启动方向正确，但还不能认定重试恢复与进程 pin 闭环；两个隔离原生夹具反例需要修复。

### P0：已获准但未消费的 start intent 会绕过再次准入

隔离 Orca `src/main/runtime/orchestration/managed-run.ts:46-56` 发现当前 generation 有未消费 `start` intent 时直接返回；OSA `bin/osa.ts:69-71` 的 `authorizeNativeStart` 因此不会再次执行 barrier、范围版本、资源/前驱或 CAS。`consumeManagedStart`（81–88）只核对原生 generation、intent 和 predecessor，并不检查 OSA 的 `native-start-admission` 或其 `authority-revision`。

具体交错：一次回调完成并落 `native-start-admission`，但原生 start 在消费 intent 前失败/请求断线/进程崩溃；期间用户修改范围、暂停、或工作区资源条件变化；恢复后相同 start 前驱命中缓存 intent，直接启动，不再读取新条件。初次回调与其紧随的同步 dispatch 事务没有人为插入 await 的窗口；这里的反例依赖**未消费 intent 留存与下一次调用**，不是声称每次普通启动必现。

**隔离实测**：对真实 `fenceManagedRun` 连续请求同一未消费 start，期望第二次重新问 owner，实际 callback 数仍为 1。它直接证明缓存绕过，尚未用真实 UI 同时注入范围变化。`after:generation` 能区分已改变的 native 代际，但不能检测 OSA scope/输入/资源变化，所以不能单独解决该问题。

最小完整修法：分离“相同 fence ID 幂等关闭旧代”和“每次真正试图消费 start 前重新准入”。重放 fence 保持 generation 不变，但必须以最新 barrier/revision、当前依赖/资源、旧退出和 stop 状态再次获得有效 admission；失效时不消费 native intent。不能只给 admission 加有效期或单纯再次读 OSA：为防 callback 与真正 native insert 之间的新停止/范围变化，必须定义双方共享的消费顺序/fence，确保变更先关闭或使 start permit 失效；丢响应可按同 ID 对账，已创建 Dispatch 不可重复启动。增加真实进程重启 + grant 后修改 scope/stop + 重试原生 API 的测试。

### P0：已终态 Dispatch 的 structured 会话重新启动时 pin 直接跳过

`managed-run.ts:65-77` 的 `admitManagedProcess` 先用 `getActiveDispatchForTerminal(handle)`；该查询只查 `pending/dispatched`。旧 Dispatch 已 failed/settled 后此查询返回空，函数直接 return，既不检查 `managed_processes` 的 pin，也不请求 restart fence。`workspace-process-listing.ts:303-308` 调用它后，`structured-agent-launch-composition.ts:188-201` 继续创建子进程。

**隔离实测**：创建受管 Dispatch → attach 进程身份 → 首次 pin → native `failWorkerStart` → 同 handle、不同 spawnToken 调用 `admitManagedProcess`，调用成功返回而不是 fence/拒绝。对照：active Dispatch 的相同 pin 可重入，不同 spawnToken 会请求 restart fence 并拒绝，控制通过。此测试证明函数边界的漏洞；尚未证明特定真实 provider 在该 failed 状态必然自动重启或执行旧业务动作。`attestManagedWorker` 的 active Dispatch 校验仍会拒绝该新进程的 OSA 命令，但这**不能**阻止 provider 本身继续执行文件/网络工具。

最小修法：在启动前根据 session/handle 的**持久受管归属及最后 Dispatch/pin**判断，不能以“没有 active Dispatch”当作非受管；对受管历史状态中的复活，先可靠确认旧进程退出及业务 fence，拒绝直接恢复并要求通过同 Task retry，或明确提供原生可信的新代协议。普通从未受管聊天保持原行为。进程启动侧在 DB 不可用或归属无法验证时 fail-closed，显示恢复责任，而不是丢失身份。

### P0：Orca 重启时惰性 DB / 注册表丢失可能使 managed session 被当普通聊天

`workspace-process-listing.ts:303-308` 先调用 `getOrchestrationDbIfAvailable()`，然后 `resolveStructuredWorkerIdentityForSession(sessionId, db)`；若 identity 找不到就直接 return，`if (!db) throw` 仅发生在已找到 identity 之后。`workspace-selectors.ts:166-168` 返回 `_orchestrationDb`；`workspaces/persisted-surfaces/automation-operations.ts:22-24` 显示数据库可惰性打开。原生 `structured-worker-authority.ts` 先查进程内 registry，再依赖 DB 的 worker resource 行重建。若 Orca 进程重启后 registry 为空、DB 尚未打开就先恢复 session，此路径可在 pin 检查前返回。应注意 runtime 的其他启动服务**可能先打开 DB**，本轮未证明该调度顺序一定可达；这是代码可构造的 fail-open 路径，需按真实启动顺序验证。

修法：对 session launch 先确保已打开或可只读查询 orchestration DB，再以持久 worker 资源/clear lineage 判断是否受管；仅在确定不曾受管时跳过。DB 损坏或不可用对受管/来源未知身份保守停止，不静默变成普通聊天。不要为了检测普通聊天而把所有现有聊天永久阻塞：持久记录可在创建受管 session 时提供明确的受管标识。

### P1：callback 的超时与不可恢复路径需统一处理

`managed-run.ts:96-102` 的原生回调 socket 超时为 15 秒；OSA `authorizeNativeStart` 要先排空输入 barrier、workspace 验证、再做 `worker-show` 和分页 `run-list/worker-list`，单个 Orca 子进程的超时为 120 秒（`src/orca.ts:503-512`）。正常慢源/工作区就可能超过 15 秒：原生请求超时，但 OSA 已在 `acceptNativeFence` 关闭旧代，异步授权仍在继续，重放还可能并发再次进行相同准入。

本轮**未观察到确定性的循环等待死锁**：OSA 的 `authorizeNativeStart` 不等待自身 `working` lane，原生 operation executor 是按 request key 的 in-flight map；它执行的只读 RPC 不明显要求等原 `worker-start` 完成。也没有跑真实 RPC 复现，因此不能宣称没有其他运行时锁。问题是可确定的超时预算不匹配与取消/重放语义未闭环。

另外 `src/orca.ts:526-544` 将 CLI 非成功 response 存进 operation；若 transient fence timeout 作为普通错误响应落下，后续相同 operation 可能一直重放已缓存失败，初次 start 又没有可 retry 的旧 Dispatch。应实测错误分类和 request-show。最小修法：统一端到端 deadline、区分已关闭但 admission 未完成的持久状态与真正永久拒绝；允许同 ID 安全恢复，不因超时开启旧代/重复外部动作；单个 intent 的准入单飞或在最终 CAS 防止失序。测试 callback 超时前后、响应丢失、并发重放及 OSA 重启。

### 时序和宿主覆盖判断

- 首次标准 structured worker 的已读源码链：`createStartingWorkerDispatch` 先创建尚未分配 handle 的 Dispatch；`createStructuredWorkerSession` 先登记内存 identity，并以 `atRest:true`、无 firstMessage 创建会话（`orchestration-structured-worker-session.ts:98-132`）；`local-worker-start.ts:194-255` 然后调用 `prepareStartingWorkerAuthority` 绑定 handle/pane/incarnation；最后 260 行后发送 preamble，触发 provider launch 和 `admitManagedProcess`。`structured-agent-session-create.ts:197-230` 在无 firstMessage 时只提交 founding，因此**在这条标准 at-rest 路径上预期首次 pin 时 Dispatch 已绑定**。但已注册的宿主后台自动唤醒、错误路径或不同启动模式是否提前 spawn 仍须集成测试，不能把源码顺序当真实运行通过。
- `structured-agent-runtime-registrations.ts` 的 Codex、Claude 和 ACP 以及 `pi/rpc-runtime-registration.ts` 的默认 Pi 通过 `composeStructuredLaunch`，生产本机 host 在 `workspace-process-listing.ts` 注入 callback。Pi 有可替换 `deps.resolvePiLaunch` 分支，测试 host 可省略 callback；其他独立 host/远端及所有覆盖分支本轮未证明。首版应显式只承诺已验证的本机宿主，启动时能力协商并拒绝缺失 admission 的受管模式，而不是因 callback 是 optional 就静默降级。
- `/clear` 会出现 lineage successor；`attestManagedWorker` 明确对 `identity.sessionId !== evidence.sessionId` 拒绝，active Dispatch 的 pin 不同也触发 restart fence，属于**保守但会中断当前工作**的策略，不是透明继续。需要测试 fence 后旧任务最终如何进入 failed/stopped、旧 child 已退出、同 Task retry/恢复与待投报告转接，不能无限停在不可重新启动状态。
- 正常 idle sweep 会检查 `hasOpenDispatch`，按 `structured-agent-session-idle-sweep.ts:48-60` 本来应保留有未完成 Dispatch 的 provider，因此不能说正常空闲时一定重启。进程崩溃、宿主重启或持久 owner 状态不可用仍会触发恢复分支，应测试上述 fail-closed；成功完成后历史 session 重新唤醒不应变回旧业务写者。

### 隔离验证和版本

从当前 `.osa/implementation-20261104/orca` 复制到 `/tmp/orca-fence-review-ubSlWF`（排除 `.git`/`node_modules`，后者仅读链接），在临时 `managed-run.test.ts` 加三个测试，命令：

`rtk proxy env ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/runtime/orchestration/managed-run.test.ts -t REVIEW`

结果 **2 failed、1 passed、4 skipped**：start grant 未回调、failed Dispatch restart 返回成功、active 相同/变更 pin 控制通过。fixture 使用临时 SQLite 与本机 fake owner socket，未创建真实业务 worker。完整日志、追加测试和源码快照哈希在 `.osa/implementation-20261104/review-evidence/fence-followup-{tests.log,tests.append.ts.txt,snapshot.sha256}`。后续主窗口可能继续修改文件，最终应以 hash 对照并重跑；未修改生产代码、服务或原生用户工作树。


## 最新独立复核：启动边界与完整需求（2026-11-04，后续快照）

**本节优先于上面的旧快照。** 同 intent start 每次重调 owner、历史 Dispatch/pin 不复活和 launch 先打开 DB 均已见源码；主窗口报告对应测试通过，本次没有重跑。原生报告 RPC 的 schema 现在只允许 enqueue，分配序号、报告和 mailbox 同事务提交，旧 reserve 反例不再适用于此接口。terminal canary 的结果以主窗口实测为准，不能外推 structured 或完整业务恢复。

### P0：start 准入后仍有 stop/范围变化窗口

`src/orca.ts:40-67` callback 的 barrier 和 OSA CAS 成功后写 admission；`bin/osa.ts:69-75` 返回 generation；原生 `worker/local-worker-start.ts:144-145` 创建 Dispatch，随后 174–260 行多次 await 创建进程和 readiness，`worker-start-readiness-settlement.ts:56-73` 才投递包含 task spec 的 preamble。期间 `src/app.ts:228-241` 可以修改 scope revision，`worker-stop.ts:26-29` 可以另行 fence。当前 admission 没有在实际投递处验证；native Dispatch 事务也不能看到 OSA 的 scope revision。

反例：新 Dispatch 已创建、等待 agent readiness 时，owner 明确 stop 或收窄范围并已由 OSA 接受；旧 start 随后仍可能投递旧 spec。另一交错是 start callback 返回后、其 native 更新前 stop 已在 OSA 提交，但 native 尚未应用 stop，start 仍可能先消费旧 native 视图。身份检查可以拒绝 OSA API 写入，却不能撤回 agent 收到的任务或阻止它直接改文件、访问网络。异步窗口由源码可见；本轮没有运行这些真实交错，不能宣称已在 UI 重现。

**具体最小修法，复用已有 intent 和 authority：**

1. 原生为每个受管 Run 持久记录 control sequence 和 stop-pending，面板、CLI、自动 start/stop 统一进入 gate。stop 到达先事务登记 pending 和递增序列，再异步通知 OSA。OSA 离线时保留 pending/拒绝新启动；紧急物理停止仍允许，但不得开放新代。
2. start callback 返回与 `(run, intent, predecessor, generation, authorityRevision, inputWatermark, controlSequence)` 绑定的许可。每次消费都重新准入；原生 Dispatch 创建事务 CAS 序列、pending、predecessor、generation，失败保持关闭并留下可重试责任。
3. 在 `deliverWorkerDispatchPreamble` 的**实际 transport 接受边界**增加 finalize：与 OSA 的 scope/stop 更新按 ticket 排序，OSA 在最终事务重新检查 revision、输入、generation、assignment、未决外部效果并激活本 Dispatch；原生同一 Run gate 再检查 control sequence、stop pending 与当前 Dispatch，然后才向 PTY 或 structured 队列提交 preamble。可提前建无任务内容的 at-rest provider，但不能提前交付旧 spec。必须把检查放进实际 PTY 写入/structured 入队串行点；仅在外层 await 前多读一次仍有窗口。
4. 不假装两个数据库可原子提交：OSA 在答复变更“已生效”前，先持久记录变更并经 native gate 撤销尚未提交的启动；gate 不可用则变更显示待落实，阻止相关启动和业务提交。定义 transport 接受为开始线性化点；之后 stop 先 fence 再停进程并确认退出，已经发出的效果标 unknown 并对账。普通自然语言追加以原生 barrier 水位为界，之后的输入继续登记与投递；只有明确控制 stop 自动 fence，归属不明保留责任。
5. 崩溃按持久 intent/control 和原生 request receipt 对账：未激活 Dispatch 回收；投递结果未知按 operation ID 查询、标 unknown，不盲目重发或换代。不得在等待慢 I/O 的锁上阻止 stop pending 落盘；stop 必须可抢先登记并通知启动协程。已开始的不可撤销外部效果不可声称已取消。

这是推荐补丁协议，不是现有能力或同 UID 恶意进程安全隔离的声明。

### P0：旧 worker、报告和责任

`managed-methods.ts:11-48` 校验 terminal/session 证明、Dispatch 进程身份、pin 和 native generation；`src/app.ts:73` 再校验 OSA generation、Dispatch、scope revision。它可以限制旧进程的 OSA API 写入，不等于撤销其文件、shell、子进程或网络权限。新代必须等旧进程和子资源可信退出，并对账未决外部效果；不能仅凭 failed 或凭据失效重用工作区。当前准入已有旧 worker 和子资源检查，真实宿主与 unknown 情况仍需集成验证。

`src/reports.ts` 已按 ID/序号持久接管和消费，业务接受与消费位置同事务。其 `consume` 在切代后将尚未业务接受的旧代报告持久标 refused：因此 OSA 离线期间原生已 queued 的报告若在 OSA 接管前先切代，报告文本和拒绝仍在，但不能当作业务已补交。最小修法是在切代前优先 drain 旧代已排队报告并保存水位；无法确定时保留待审责任，过期报告公开拒绝原因，由 Router 据原证据转成交接或由新代补报，不直接以旧身份更新业务。旧凭据只应查询自己的历史 receipt，不得提交新业务写。原生 queued 后才承诺补交；Orca 不可用或提交响应丢失时返回失败/unknown，用持久原 ID 对账，不声称 queued。

### P1：准入失败、迁移与自动接续

`src/orca.ts:530-551` 仅在 `managed_admission_refused` 且 `request-show` 明确 absent 时清除 response/attempted，保留原 requestId；pending/completed/unknown 需对账，不可换 ID 盲重试。需要真实 native request 库证明 callback 拒绝后 absent 的语义、同 ID 并发幂等，以及超时后 callback 晚完成的处理；一次 absent 快照不能被误认为在途请求不可能再提交。`anchor` 和 `workspace` 的同样分支（约 628、713 行）在固定参数下不可达，可删去，统一保留 mutation 实现。

`src/orca.ts:373-411` 已有每 assignment 迁移记录、native adopt、旧 worker stop、child 释放和同 Task recovery；`bin/osa.ts:189-194` 先做 SQLite 快照。仍需验证 adopt/stop/retry 各中断点的幂等，以及旧来源身份和外部效果不明时保留责任。旧 worker 在 adopt 之前可能仍在直接工作，须关闭旧 OSA 写代、证明进程和子资源退出并对账外部效果后才启动新代；用户明确停止的工作不得自动恢复。

`src/orca.ts:248-262` 有条件自动 recovery；`src/router.ts:80-152` 有 structured Router 唤醒和持久 attention。预算耗尽或真实阻塞必须显示原因并保留责任，独立任务仍能执行和报告。Router 重启、lease 恢复、structured provider 停机唤醒及责任消费尚需真实集成；terminal Router 当前显示 migration-required，不能称为免手工重挂已完成。

### 最小验收矩阵

| 范围 | 必须通过 | 当前证据 |
|---|---|---|
| 输入 | 正常追加、编辑/撤回跨 epoch 留存；未知来源不升级授权；无关 ticket 独立推进 | input stream/barrier 源码可见；真实来源及跨 epoch 组合未复测 |
| 启动/停止 | 面板、CLI、自动入口；callback 后、Dispatch 后、PTY/structured 投递前注入 stop 和范围修订；未开始不得投递旧 spec | 当前源码存在窗口，需实现上述协议 |
| 真实身份 | terminal 和 structured 首次、同 Task retry、旧凭据、clear、provider 恢复；旧代不可写且资源退出后才复用 | terminal canary 由主窗口报告通过；structured 未证明 |
| 报告 | 真 worker enqueue 后杀 OSA；恢复按序业务接受；同 ID 重放；先切代再消费旧报告；ready/review 异步及永久拒绝 | 原子入队和消费源码可见；本轮未实测跨进程 |
| 恢复/迁移 | 准入拒绝 absent 同 ID 恢复；pending/completed/丢响应不重复；迁移各持久点崩溃；child 未退出不重启 | 有实现；跨进程组合未证明 |
| 对外结果 | Router 自动恢复责任、另一任务阻塞时独立报告；状态区分执行、业务 receipt、等待/unknown | 有 pulse/wake/状态投影；端到端未证明 |

实施顺序：统一 gate 与投递边界 → 报告跨代接管和迁移 → structured/Router 全链 canary → 隔离故障组合验收。不得以单测数量、投递成功或 terminal canary 代替业务结果。

本轮仅静态调用链审查，没有运行新测试或启动服务，不作新的跨进程通过声明。快照 SHA-256：`src/orca.ts` a99b61d320956a24823b27530e95ea62913a7f9f0b29f74cdf296e44594e8be5；`src/worker-authority.ts` baa7543a31f45783e1eed721561af7b461482871d758f97ced52bbebeac4f1b0；`src/reports.ts` e79678c1d5d065c3223ea28ab5ce099db278ad5b11174d119884b6c05cc08c75；native `managed-run.ts` b5c5b8dd45ef5cb9090927d169153a81dfa150b1398735bc50aa39da5fe30d14。只读命令包括 `rtk proxy sed -n '140,310p' .osa/implementation-20261104/orca/src/main/runtime/rpc/methods/orchestration/worker/local-worker-start.ts` 和 `rtk proxy shasum -a 256 src/orca.ts src/worker-authority.ts src/reports.ts`。并行修改可能令行号变化；未改实现、服务或业务库。


## 最新复核：managed delivery、离线 stop 与报告交接（2026-11-04）

**本节覆盖此前对 delivery 尚未实现的旧描述。** 新代码已有 native control sequence、stop-pending、final activate、持久提交状态和 OSA pending control；NativeInputs barrier 已只等待相关 source；被拒报告现在有不可由 notice ack 消掉的持久责任。这些是实质进展，但以下问题仍影响需求。主窗口并行修改时请按下列快照哈希重新核对。

### P0：撤销发生在 transport 接受前，仍可投递旧任务

`orca/src/main/runtime/orchestration/managed-delivery.ts:43-115` 在 callback 后 `assertCurrent()`，随后写 submitting 并 `await send()`。`deliver-worker-dispatch-preamble.ts:52-130` 的 send 继续异步调用 PTY `sendTerminalAgentPrompt` 或 structured `host.send`；其进入函数并不等于底层已实际写入或持久接受。`revokeManagedPermit` 同时落 control sequence/stop pending，`drainManagedDelivery` 仅等待整个 send 完成，不向 send 传取消信号，也不在实际接受处复查。因此 revoke 落盘后、实际接受前，send 仍可接受旧 preamble；对于明确 stop，这个等待期间 worker 可能先得到旧 spec 并行动。对于 scope 变更，等待 drain 后才对外宣称生效，能提供一种“已发动作在变更生效之前”的顺序解释，但不能声称 revoke 后阻止了尚未接受的提交，也不能把 send 的调用入口当作底层接受线性化点。structured pending 还可能持久排队并稍后运行。

**隔离实测**：复制当前原生源码至临时目录，基于真实 managed-run fixture 添加一个模拟慢 transport：进入 send → 暂停、原生 revoke(stop) → 放行 transport；断言接受标志仍 false，结果 actual true，断言失败。此夹具证明托管 wrapper 对此交错不阻止接受；它不是说真实 PTY/structured 宿主已被实测重现。另一个离线 stop 控制测试通过。运行 `rtk proxy env ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/runtime/orchestration/managed-run.test.ts -t REVIEW`；结果 1 failed、4 passed、7 skipped（过滤器同时匹配原有 REVIEW 测试）。测试追加片段与日志在 `.osa/implementation-20261104/review-evidence/control-followup-test.ts.txt`、`control-followup-tests.log`；临时复制不影响实现。

**最小完整修法**：`deliverManaged` 提供带 `(run, dispatch, generation, sequence)` 的 abort/check，传到终端 `beforeWrite` 和 structured journal 接受队列的实际提交点；同一原生事务或无 await 的串行区核查 current/sequence/stop pending 后提交，明确拒绝或撤销未接收的待提交任务。stop-pending 先落盘、触发 abort；drain 等待**真正已接受的提交**达到可观察状态，不能等待无界 agent readiness。structured 已接受但尚未被 provider 取用的 submission 要取消或使出队时校验同一 fence；若不可撤销，应停止/销毁该 session 并对账，不能只关闭 OSA API。提交 outcome unknown 时持久保留并对账，不可重发旧内容。扩展两个真实 transport 的阻塞点测试：revoke 在实际接受之前与之后各一次、进程崩溃和丢响应。若平台不能提供可撤销边界，则必须明确 stop 只能在 transport 提交开始之后生效、保留真实 unknown，而不能承诺已阻止接受。

### P0：运行中 scope 替换只撤销待发送许可，旧 worker 仍可按旧范围做直接动作

`src/orca.ts:71-79` 的 `revokePendingStart` 仅调用 native revoke；`managed-methods.ts:151-158` 以 `revokeManagedPermit(..., false)` 清 permit 并等待 delivery，没有关闭 active generation 或终止现有进程。随后 `src/app.ts:284` 附近 route attach 更新 scope/revision，控制变更即可成功返回。反例：worker 已在运行并掌握旧的“可以操作 A”，owner 改为“不要操作 A”，scope 变更成功后旧 worker 继续直接用 shell 或网络操作 A。OSA revision 检查只约束经 OSA 的操作，不约束 worker 自主工具；worker 后续重新发 API 请求也能按当前 scope 重新认证，不能证明已读新范围。这里不预设每次 scope 更改都有害；反例是授权明确被收窄或撤回。

修法：对于可能收窄授权的替换，保守地把现有 active Dispatch 同步 fence 并请求停止；记录 pending，等待真实退出/子资源与在途效果对账后才确认变更生效或启动新代。若日后提供不中断变更优化，必须有可证明的 worker 协作暂停和确认，不能只靠提示词。无业务副作用的原生进程停止可继续，unknown 效果保留可见责任，不阻塞无关 ticket。

### P0/P1：OSA 离线 stop 虽保留 fence，却既未停止进程也无自动完成链

`worker-stop-flight.ts:20-29` 必须先 await `fenceManagedRun` 才进入真实 stop；`managed-run.ts:120-169` 先落 stop-pending 与 native closed，再请求 OSA；OSA 不可用则抛 `managed_admission_refused`，因此不会执行 `worker-stop.ts` 的实际关闭流程。围栏保护了 native 身份和新 start，但正在运行的旧进程仍可直接操作工作区/网络。源码范围内 `stop_pending` 只有再次调用 stop 才能进入 `finishStop`；未见服务恢复后扫描该原生 pending 并主动重试的路径，start 反而明确拒绝 pending。隔离控制测试证明 offline 时 pending/closed 留存且后续 start 被拒；没有启动真实 worker，未实测其实际存活时间。

修法：把原生 pending stop 当持久责任，保存明确的 run/dispatch/intent 与请求状态；本机对 owned 进程可先安全执行物理停止、记录 stopped/unknown，同时保持写围栏；恢复时自动幂等重放 owner fence 并协调 drain、子资源和外部效果后才清 pending。非 owned/无法确认时保留 unknown，禁止新代并醒目展示；不得仅因 OSA 恢复就清 pending。覆盖 OSA 离线→面板 stop→Orca/OSA 各自重启→自动完成，不要求人工再点 stop。

### P1：控制请求排队后 lease 变化会被当最终拒绝

`src/app.ts:93-124` 在 queueControl 验证 lease 并持久化请求；revoke 完成后通过 `handle(request)` 重走 `execute` 的 `authorizeRouter`（`src/app.ts:198`）。若 outage 期间原 lease 过期，新 Router 合法接管并更换 token，恢复的旧请求会被拒，catch 删除 pending，仅写 refusal notice。原 owner 的 stop/更改虽曾可靠接管，却没有自动转为仍需处理的业务责任；普通 notice 可被 ack。应在最初登记时固化已认证的控制意图及其 owner 输入证据，恢复事务校验输入修订和是否被后续控制明确替代，不依赖过期 Router lease；若确须新 Router 复核，保留不可由 ack 清除的待归属责任。测试先登记→离线→lease 换代→恢复，以及显式撤回/后续更正。

### P1：旧报告 handoff 已登记，但尚无执行消费证明

`src/store.ts:72` 根据 refused 未 reconciliation 折叠出持久责任；`src/app.ts:239-255` 的 handoff 在事务内 `engine.note` 并立即标 reconciliation。DSH `tickets.ts:234-247,395-400` 确实将 note 放进 ticket inputs/undelivered 并尝试派送，这是已有能力，应复用；但在 handoff 时即消掉报告责任，只证明 note 已登记，不证明新 worker 已接收、理解并处理。`src/app.ts:165-177` ready 只强制处理 human trigger，note 不在强制消费列表。反例：旧 ready 含未确认效果/下一步，Router handoff 后 worker 读到 ticket 即报告 ready，未对该 note 处理，报告责任已不再出现。拒绝报告原文保留，但其 next-step、evidence、question 等不能仅靠 summary 的 note 代表已处理。

最小修法：原 refused report 和 handoff note 建立可查询映射；handoff 表示“已转交”，不表示“已消费”。复用现有输入投递和 `report --inputs` 记录 note 的处理结果/证据；对关联未解决效果或交接，在 ready/相同外部效果执行前检查该处理记录。无需新队列或逐条推送；discard 记录证据/原因并保留原报告，不能把 discarded 等同业务成功。对已结束原 ticket 提供明确 continuation/对账归属，不能靠字符串路径自称已核实。测试重启、ack、交接后直接 ready、被处理后 ready 和异步 review。

### 其他核对与验收边界

NativeInputs 现仅等待 `sourceMayAffect` 的 draining，修复了上一轮全局等待的问题；仍需多源跨 epoch、真实来源与 source 归属集成测试。`src/orca-session.ts` 的 RPC 固定 15 秒，revoke 却等待整个 transport，structured send 可等待更久：超时后的 native drain 仍可能继续，OSA pending 每轮重试，应按幂等请求与稳定 receipt 对账，并将 pending 保持可见；实际超时恢复尚未实测。近期 terminal canary 和单测不证明 structured、用户界面或跨服务故障已通过。

建议验收顺序：先修 transport 边界和 running scope fence；再打通离线 stop 自动恢复、已授权 control 的 lease 换代；最后验证报告 handoff 的消费证据及两种宿主的真实崩溃组合。每项验证含正反控制，区分 queued、业务 accepted、handoff 已登记和业务已处理。

本次快照 SHA-256：`src/orca.ts` fd2009639131c26b4f863fd9f85100a60a44f82a2b37fd2bee7e925930fac84a；`src/app.ts` 1434a0315ec53a77b0bbc69e2c9a8bad30607ff15e75f6cc5fbe3e998be46d22；`src/reports.ts` d32a95a847d2a80586a86dc65fd748b649030d7e08e21bdd40c6457e6ed1e4e4；`src/native-inputs.ts` f960d3b0ad26852f10f922252f77c4d0948e90efe6d4a51acc4fe1798a1fd970；native `managed-delivery.ts` 700fb25c624164e7306a3d0d959e0d41414fbadb5fddeb466208ffb8656b845e；`managed-run.ts` 1bd5d4e100c1adf8707f7ad33647404f4671a0cbdf24a40578c384f1baa3bc83。未修改生产源码、配置、服务或业务库。


## 最新复核：实际提交围栏与停止恢复（2026-11-04，后续修订）

**本节覆盖上一节已修复的结论。** 当前源码已把 managed AbortSignal 和 assertCurrent 接到 PTY beforeWrite；structured 路径把 beforeRun 传至 journal appendSubmission 的实际 SQLite write 回调。stop 的 native fence 与物理 stop 已并发；OSA 能读取 stopPending 并尝试补 stop。scope 变更先 revoke、stop、检查资源/外部效果，成功后有 scope-recovery。已认证控制恢复不再依赖旧 Router lease。被拒报告 handoff 保存 note inputId，ready 检查 input-resolution。上述均为源码核对，主窗口报告的宿主回归通过未由本窗口重跑；不能再把上一节这些机制描述为完全未实现。

### P0：启动中的 worker 不能物理停止，暂时拒绝可能永久阻塞控制

原生 `worker-stop-flight.ts:20-40` fence 和 stop 并发，但 `orchestration/db/worker-dispatch/worker-dispatch-stop.ts:46-91` 的 `beginWorkerStop` 只允许 ready、start_unknown 或旧 runtime 遗留 stopping；当前 runtime 的 `starting` 明确抛 `dispatch_inactive`。可达交错：managed Dispatch 已创建、provider/setup/readiness 仍在等待时，用户要求 stop 或更新 scope；此刻即使围栏关闭且进程已创建，物理 stop 不能进入正常关闭路径。稍后启动路径可能自己失败或退出，但不能假定它必然立即结束、物理进程必然退出。

**隔离实测**：在当前隔离原生源码复制品中，用现有 managed fixture 创建 starting Dispatch、原生 revoke(stop)，调用真实 `beginWorkerStop`；应允许安全 stop 的断言失败，实际 `Dispatch ... cannot stop from starting`。命令 `rtk proxy env ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/runtime/orchestration/managed-run.test.ts -t 'REVIEW starting managed worker'`，结果 1 failed、12 skipped。片段和日志：`.osa/implementation-20261104/review-evidence/starting-stop-test.ts.txt`、`starting-stop-test.log`。本夹具没有创建真实 provider，仅证明状态机拒绝；未声称真实进程存活已复现。

扩大到 OSA 的静态反例：`src/orca.ts:71-90` scope control 对 `control-stop:<control id>:<dispatch>` 调用 mutation；`src/orca.ts:573-595` 将错误 response 持久缓存，只有 worker-start 的 managed_admission_refused 有清理分支。因此该次 worker-stop 若得到 `dispatch_inactive`，即使启动路径随后安全终态，同 control 重放仍读缓存错误，pending 可能永久不落 scope；这段跨进程交错尚未实测。`Promise.all([stop(), fence])` 在 stop 抛错时提前拒绝，fence 仍异步完成，也必须对账其结果，不能将错误当作没有写入。

**最小修法**：在原生统一 stop 处理 starting：先写 pending fence，向 start/setup/transport 发取消；若 handle 已绑定则按所有权物理关闭，未创建则保证后续 placement/绑定前再检查 stop；按确定退出/未创建/unknown 写持久结果，避免 stop 与 startup failure 双重结算。对不能即时终止者返回可重试 pending 而非永久 dispatch_inactive。OSA 对明确无效果的暂时拒绝先查 native request receipt 与当前 Dispatch，再使用同 ID 安全重放或以新操作对账，绝不对结果 unknown 盲目重发。测试在创建前、placement 中、beforeWrite、structured journal commit 前、readiness 后分别注入 stop，断言无新 prompt、旧进程退出或明确 unknown、控制自动恢复。

### P1：无效或过期的范围控制可以停止旧执行后丢失自动续跑责任

`src/app.ts:93-124` 先持久登记未经领域完整验证的控制，再 await `revokePendingStart`；后者现在会停止原执行。之后 `execute(request, true)` 才检查 trigger 是否当前、scope 非空、目标可 attach 等（`src/app.ts:270-315`）。如果领域检查拒绝，catch 删除 pending，保存 refusal notice，但不建立 `scope-recovery`；`src/orca.ts:294-304` 对 closed/lastAction=stop 仅在 scope-recovery revision 匹配时自动 retry。反例：空 scope、已撤回 trigger 或输入在停进程期间被更新，旧执行已经关闭，原有效 mandate 仍在，用户未要求终止原工作，却没有自动续跑标记。notice 可解释但单靠纠正输入不满足持续推进；上一轮测试的假 revoke 不会真的停止进程，不能覆盖这个后果。

修法：在任何可撤销动作前做可纯验证的请求检查；且在 stop 已发生后的拒绝/崩溃路径，同事务记录“原 mandate 仍需恢复”的持久责任，重新检查最新输入和明确 owner stop 后按原 Task 恢复，不能在 stale/withdrawn 意图下恢复旧范围。控制被用户明确 stop 取代时不重启。测试无效 scope、触发消息在 revoke 期间撤回、service 在 stop 后及拒绝前后重启。

### P1：正常多次范围修订消耗全局两次恢复预算

`src/orca.ts:122` 把每个 assignment 的所有 `orca-recovery` 计入两次上限；`scope-recovery` 在 `pulse` 通过同一 `retryTicket` 路径恢复，完成记录仍保留。两次正常 owner 追加导致的 stop/retry 后，第三次合法范围修订即使旧进程与资源确认退出，也会抛 `Recovery limit reached`、只留 notice，无法自动继续。这不是说应移除原生失败熔断：主因是把正常控制的延续算成技术故障预算。应给 recovery 持久记录原因/上一代结果，仅连续异常失败消耗自动恢复预算；范围修订的受控停止复用原 Task/native 熔断但不消耗 OSA 故障预算，并对重复同一 revision 幂等。测试至少三次 scope 变更与真正连续故障组合；尚未实测 native circuit breaker 与此路径的完整组合。

### P1：handoff 已读取不等于事项已处理

新的 inputId 映射和 ready 检查已经堵住“仅登记 note 即 ready”的旧反例。仍有一个状态语义缺口：`src/app.ts:171-176` 对任意 report 状态的 `--inputs` 都写 input-resolution，`src/store.ts:72` 只检查此记录存在。worker 可以用 `report waiting` 或 `report blocked` 表示该 handoff 尚未处理、请求等待，然后对应 reconciliation notice 即消失；后续 ready 因已存在 input-resolution 也不再检查该 handoff。应区分处理完成/明确替代与等待/阻塞：后者保留可见责任及下一步，允许如实报告等待但不视为已解决；依据实际语义而非仅 report 状态判定。无需新增队列，可扩展现有 resolution 字段，并在 ready 检查仍未解决的 handoff。还需覆盖报告已属于已结束 ticket 时的 continuation 归属；当前 handoff 要求原 ticket open。

### 关于死锁与未完成验证

本轮未找到能由静态链条证明的永久同步互锁：OSA 调 revoke 等 native delivery drain；activation 的输入 barrier 不等待对应 control 完成，pending control 会使 activation 准入失败，delivery 的 finally 释放 lane。实际 provider、socket 超时或 transport 不响应仍可能导致长时间 pending；`sessionRpc` 15 秒与原生 owner 45 秒预算不同，必须以故障注入实证，而非声称没有死锁。还需复核 stop 在 native pending 已清、物理 stop 未确认时的恢复责任，以及 journal 已接收但 provider 未消费的 stop 后处置。现有隔离 canary 正在由主窗口执行，本轮不重复启动业务或对其结果作预判。

验收优先级：先闭合 starting stop 与失败 receipt 重试；再覆盖拒绝控制后的续跑、三次以上 scope 修订；最后测 blocked/waiting handoff、真实 PTY/structured stop 与 OSA/Orca 分别重启。无关 ticket 必须继续执行与汇报。

本轮读取快照 SHA-256：`src/orca.ts` bc1aba9290a4c8b3b0c6147c64950321fd721d6560f8e346278978c1443bccf5；`src/app.ts` 5dd6511654390cc28fd3d846422aa57201b2aff85e1edcfacc9eac7b7c61f69f；`src/store.ts` fe459c65eac4a64f8a04fead47e42af9a8395ee2ae405bfab6f0b18c2586a33a；原生 `managed-delivery.ts` 7350d542e81898181330932d109bdbd007e20fd7db1516a8be8675fa292bd8de；`worker-stop-flight.ts` 9a5304f9e2cdae4ed2d9ca329ba4f63794b5eb98135838664fc1b85896ef9d03；`worker-dispatch-stop.ts` 191c8c9619bbb4d7b1c1472cadb09f6e8727cf961beedd741f476ea9bd04e50c。并行修改可能已变化；未修改实现、生产状态或服务。
