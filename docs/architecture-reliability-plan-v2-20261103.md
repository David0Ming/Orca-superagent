# OSA 可靠性方案 v2：独立审查后的收敛

状态：修订方案及可行性证据，不是生产实现。本文优先于 v1 的 A4、C、D 决策；v1 的报告事务、T1–T12 和迁移要求继续适用。独立审查的 Fail/Conditional 保持有效，直到对应完整场景验收。

## 第二轮审查后的收敛决定（v2.1）

以下决定优先于本文后续历史提案，尤其替代第 5 节“持久保存九态义务”的设计，以及第 2 节“默认新 assignment 导致新原生 Task”的倾向。第二轮审查报告为 `architecture-reliability-review-v2-20261103.md`。本节是实施约束，不表示已实现或通过验收。

### 唯一权威与最小责任记录

- DSH core 原样保留：Ticket/Mandate/Assignment/report/attention 是业务事实，`ticketStage` 派生业务阶段；不修改 vendor，不再持久维护另一套 running/waiting/paused/closed 状态。
- Orca 是 Task/Dispatch、操作回执、mailbox、worker 结算、存活与资源的事实来源。OSA 不复制其执行状态机，不以本地 finished 替代原生退役证明。
- OSA 只在既有 handoff/task-plan 上保存无法派生的差量：责任方、具体等待对象或条件、已授权下一动作及其依据、关联的 scope/decision revision，以及该动作被消费后生成的 assignment/job/report receipt ID。不要额外保存一个可独立改变的业务阶段。
- 状态展示从上述事实派生。awaiting_report/reconcile 是适配层待办及投影标记，不能自行改变 DSH 业务结果；暂停/撤销沿用明确的领域决定及生效版本，不能仅写 handoff 字段就宣称已暂停。
- 消费下一动作时，在同一 `Store.atomic` 中重新核对当前 assignment、授权版本和依赖，写 successor/job 与动作消费回执。重复 tick/崩溃重放返回同一回执。对原生的异步操作仍用 Orca 原生幂等请求和结果对账；跨库、跨服务不假称原子。
- Router 被唤醒、通知被 ack 均不构成动作消费。只有具体决定已落库并产生下一责任/等待依据，或明确的领域结束事件，才能消除待办。

### 消息留存与确认契约

history 的 epoch/sequence 只用于读取投影，不作为“全部用户提交已无损接收”的证明。入口能力必须满足以下契约，优先复用并扩展 Orca 已有持久 submission 存储；若现有存储不满足，才增加最小提交事件账本，不另建完整聊天历史。

1. 已承诺接收的提交、修订和撤回具有稳定事件 ID、独立于渲染 epoch 的单调顺序、可信来源类别和原文/变更引用。提交持久化失败必须返回失败或明确未确认，不能静默返回可靠接收。草稿不算提交，撤回不会抹掉已经发生的历史事实。
2. 给 OSA 分配稳定 consumer 身份与持久确认水位；在该 consumer 确认之前，事件不得因渲染压缩、epoch rollover 或普通保留期被回收。最大容量达到时必须显式背压或告警，不允许无声丢未确认事件。消费范围从明确启用位置开始；无法追溯的旧历史标 unknown，不能声称已补全。
3. OSA 在同一领域事务中保存原始事件、去重身份、待路由登记和连续消费位置；事务提交后再向 Orca 确认连续水位。确认丢失则重读去重，不能先 ack 后入库。这个 ack 仅代表 OSA 已承担持久保存责任，不代表 Router 已处理用户要求。
4. 读取返回明确的 stream 身份、可读下界、当前 head 和 gap/reset 信息。不得用新的 tail cursor 跳过缺口。若发生已确认数据备份回退、主动数据删除或不可恢复损坏，显示缺失区间与受影响会话；历史缺口未被补回或得到明确处置前，阻止依赖该区间完整授权/输入的自动续派与 ready。无关会话/任务继续推进。gap 告警不能被计为“不丢消息”验收通过。
5. 来源由 Orca 的真实提交通道记录：human UI、automation、system、imported/unknown。普通 RPC 请求自报的 role/source/clientKind 不得提升为人工授权。对同 UID 可访问全部本地文件的恶意进程不声称安全隔离；可靠性分类与安全认证的保证分别写明。程序 bootstrap 与系统唤醒必须从入口准确标记，而不是消费侧黑名单猜测。

如果已有 submission ledger 能证明以上契约，可只补读取/确认接口；否则需 Orca 侧的兼容改动，OSA 单独改动不能完成这项需求。原生输入契约验收增加：消费者离线期间提交/编辑/撤回→epoch 更换→压缩→消费者恢复，所有事件按序恢复；分别注入领域提交前崩溃、提交后 ack 前崩溃、水位确认后崩溃，以及容量满和不可恢复 gap。

### 恢复优先保留原生 Task 与 retry 语义

先实现旧 start 的终结与全部异步写入的前驱校验，不以此为由立即把每次恢复改成新 Task。DSH assignment 与 Orca Task 是不同层的身份；更换 assignment 不应未经验证就推导为必须更换原生 Task。

优先验证原生同 Task retry 能否通过原生 dispatch/assignee 绑定的消息或调用者身份，为新 assignment 交付可核验的上下文。保留 retryOf、failure_count、circuit_broken、原生资源回收及操作回执。不得把内部 launchToken 假定为公开 API，不得用旧共享 token + 自报 dispatch 兑换新写权限。验证失败才采用新 Task 路径，并明确这是兼容取舍。

新 Task 回退路径必须在排队 successor 前核实旧 dispatch/host/incarnation 已退役、子资源已解决、归档和保留所有权状态明确；因为 core retry 同事务排队 stop/start，不保证原生 stop 先完成。start 前再核对前驱与停止/授权版本。跨 Task 必须保留失败链、原生拒绝理由和恢复预算；任何 circuit_broken/权限拒绝都不得靠换 Task 绕过。无法证明安全接续则保持待核查，不能静默重置次数。

### 运输复用与领域回执分层

优先验证用 Orca 持久 mailbox 承运 worker→OSA 报告：固定 reportId/主体/顺序，领域提交并保存 receipt 后才 ack 原生 delivery，按 assignment 独立处理，复用既有 consumer generation 和重放。这可覆盖 OSA 服务停机而 Orca 可接受消息的场景，需在隔离环境验证，不预先承诺其认证与时序已满足。

OSA 必须保留 report 领域接受回执，与输入处理、engine.report 和结果出站消息同事务；原生投递回执不能替代。对外结果继续复用现有 DSH Replies 与 OSA outbox，扩展任务级进度和投递，不另建竞争队列。

若验收范围要求 Orca 与 OSA 同时不可用时 worker 仍能可靠排队，或原生 mailbox 无法满足主体/排序/可恢复性，再保留 v1 B 的窄本地 report outbox；该需求不能在实施时悄悄删除。两种运输都必须使用同一领域接受路径和固定 ID，不能相互重复产生业务效果。最终传输选择须由对应故障测试给出证据，再删除不需要的代码。

### DSH 关系及实施门禁

本地 vendor 与固定上游 `6337fc823ce20251c8de8085948165c81aaa701e` 的 src/core 逐字节一致。OSA 是复用领域核心并重写外层适配，不是完整移植 DSH 应用。复用上游 effect generation、防旧回包覆盖、按 ticket/conversation 排序和来源区分的成熟做法，但不整套复制 DSH executor 或宿主监督。第二轮上游版本比较与实验以该报告为准。

进入正式实现前，只需闭合以下具体决策，不再扩展框架：①原生 submission 的保留/确认/provenance 契约；②同 Task retry 身份交付可行性及受控回退；③报告原生运输在约定故障边界内是否足够。其余 A 的前驱保护、领域 receipt、派生状态和责任差量可在隔离实现中推进。最终以 T1–T12 加上述跨 epoch/压缩测试逐项验收；任何单项能力存在或局部测试通过都不等于全需求交付。

## 1. 本次新增证据

### 应用层执行隔离已有可复用路径

在独立临时副本运行 `npm test -- tests/capability-fence.test.ts`，1 项通过（2026-11-03 19:42，UTC+8）。测试使用现有 `Engine.retryTicket`：

- 旧 assignment 报告 failed 后，retry 创建不同 assignment，现有 OrcaExecutor.start 生成不同 capability。
- ticket 和 execution.directory 不变；旧 assignment 结束，新的 start job 已入队。
- 旧凭据不能 read、ack、report progress/ready、memo、handback、thread follow、acknowledge，也不能把 assignment 字段改成新 ID 后复用旧 token。
- Store 关闭重开后，隔离仍生效，新凭据有效。

代码依据：`vendor/dsh-core/src/tickets.ts` 的 retry、`src/orca.ts` 的 start、`src/app.ts` 的 executorTicket。测试是应用层隔离证明，不是原生资源退出、review/pr 异步竞态或完整恢复证明。尤其 `canRetry` 只允许已阻塞/失败或投递失败的开放任务，不能把这项测试外推到所有 native stopped 状态。

### 原生 history 确有分页，但不能证明人工来源

只读查询实际绑定的 Router session：tail、after(sequence=0)、下一页均成功，游标从 0→4→8，返回 epoch、itemId、revision 和 submission。无需再把“是否有分页”留作纯猜测；崩溃、压缩、游标过期和删除仍需完整测试。

查询到第一条 submission 的 clientMessageId 与 `.osa/p4-live/router-chat-create.json` 中程序 bootstrap 完全相同，却带有 `origin=client`、`source.kind=user`。本地 Orca 对应源码 `structured-agent-session-create.ts` 也直接写入这两个值。`structured-agent-session-send-compatibility.ts` 对客户端 RPC 统一传 `userSend: true`。

所以现有字段可以辅助分类，却不能单独证明人工授权。仅排除已知 bootstrap ID 也不够：其他程序 RPC 仍可能同样标记。历史 item.sequence 还可能包含补充投影，实测返回 item 的 sequence 可大于本页 nextCursor；消费者必须使用 window.nextCursor，不能取 items 的最大 sequence 自制游标。

上述 live 查询只读，没有发送消息、重启服务或修改业务库。脱敏形状证据为 `.osa/architecture-fix-20261103/independent-review-evidence/native-history-shape.json`。

## 2. 执行恢复：选择新 assignment，缩小证明范围

v1 的“同 assignment 内发新 attempt 凭据”不作为默认实现路径。优先复用新 assignment 和现有 capability 隔离，一个 assignment 只对应一代执行权限；同一代内仅重放同一启动操作以解决未知结果，不借重放创建另一代。

恢复顺序：

1. 对账原生当前 Task/Dispatch、启动/恢复回执和 workspace。未知或分叉先进入 reconciliation_required，不再启动。
2. 确认旧执行停止/退出、子资源已解决，核查外部效果和待补交报告。不能只依赖原生 failed 字段，更不能因超时推断退出。
3. 在数据库事务内重读当前 assignment、scope revision、暂停状态及前驱；结束旧 assignment，创建新 assignment 与独立 capability，保存前驱关联和恢复计数，关闭旧启动/投递义务。事务完成后异步派工。
4. 启动与后续投递、观察、取消、释放均校验所属 assignment 和预期绑定；旧异步结果仅归档到历史，不能写当前投影或释放新资源。审计所有 save(binding)，不只 launch/recover。

有合法 failed/blocked/delivery 状态时复用 Engine.retryTicket。其他“原生确认退出、领域仍 progress/waiting”的情况，必须先确定其真实语义：等待用户的不得自动重试；确有执行错误可使用核心已有 Executor failed 报告语义，并保留上一业务报告与原生证据。不得伪造 deliveryFailed 让 canRetry 放行。如果现有入口无法忠实表达，则增加窄的、带预期 assignment 的执行替换入口及测试，不能直接乱改核心状态。

新 assignment 通常导致新的原生 Task，必须补偿这一语义变化：恢复预算挂 ticket/工作线而非 assignment；显式关联 predecessorTask/Dispatch；原生 circuit breaker/权限拒绝不得通过换 Task 绕过。只有旧资源已核实结束、授权允许且恢复预算未用尽时才准入。外部动作的幂等及结果核查跨 assignment 保留。

隔离目标是防止旧执行凭已有凭据继续写入，不承诺抵抗具有同 UID 任意文件访问能力的恶意进程。当前环境中的 worker 可读共享文件，token 本身不是操作系统安全沙箱；不能宣称“任何旧进程都无法窃取新凭据”。处理真实旧进程仍需退出核验和资源管理。

验收加项：旧 token 不能调用 review/pr 真实 socket 路径；异步 review 等待期间换 assignment 必须拒绝；旧观察返回晚于新 assignment 时不能覆盖新投影。把停止与未知恢复、启动前 read、恢复预算和外部效果不明加入 T1–T3。

## 3. 消息入口：区分“记录完整”与“授权可信”

OSA 可以立即实现绑定会话历史的持久采集与去重，用于显示尚未归属的消息事实；但不能把所有 role=user/source=user 自动当 owner 输入。

要满足“用户直接在原生聊天追加要求也不会漏接”，需要在 Orca 的实际提交入口保存服务器赋予的 provenance：人工 UI 提交、程序 RPC、原生系统事件、导入历史、来源未知。来源由可信调用通道决定，不能作为任意调用者可填写的请求字段；UI/远程客户端身份的信任条件必须核实，不能只相信客户端自报的 clientKind。

最小改动路径：复用现有 submission/journal，不再建一套历史系统；给已提交消息记录不可被普通程序 RPC 冒充的 provenance 及提交身份，通过 history 返回。bootstrap 和普通本地 RPC 默认 automation；原生 wake 为 system；旧历史缺 provenance 的保留 unknown，不自动提升权限。用户编辑、撤回、排队草稿和发送后的修订必须有独立语义，只有真正提交才形成待处理义务。

OSA 仅消费可信人工提交作为授权候选，按稳定 submission/item ID 与 revision 事务登记，再推进 cursor。未知来源可提示核查或由已有可信输入引用，但不能自动执行其指令。消息登记和任务归属分开，Router 决策仍保留原始消息映射。停止/暂停使用修订号并在实际执行边界重新检查。

这明确涉及 Orca 入口协议改动；在该能力上线前，原生聊天自动授权登记需求仍为未通过。不能以排除 bootstrap 的黑名单或模型分类替代。若短期只做 OSA，可展示未登记消息和人工核查队列，但必须明确只是过渡方案。

## 4. 报告补交：保留 v1 B，固定几个缺失决策

- 仅 report 使用本地持久 outbox；reportId 与完整 payload 在发送前写入，单 assignment 序号在同一入队事务分配。未成功持久化不得返回 queued。
- 领域事务保存报告回执和所有领域副作用，再更新另一数据库的 delivered。两库不做虚假的原子提交，崩溃后重放靠领域回执去重。
- 同 assignment 按序消费；已拒绝/已过期项目记录终态并允许下一序号；序号缺失保留 gap 诊断，不猜测丢失内容。不同 assignment 的报告独立运行，慢 review 不阻塞其他任务。
- 在线与补交共用一条报告处理函数；已接受回执在异步 review 前经原主体认证返回；新请求在最终事务里再次核对 receipt、最新 assignment、revision 及序号。
- 旧 assignment 未接受的报告只归档；旧主体仍可查询其已提交回执，不重新获得 current read/ack/report 权限。
- worker_done 与 report_pending 分开；入队成功可结束原生轮次，业务成功必须等报告接受及验收。

首批进程级测试必须覆盖断线前/入队后/领域提交后/回执前/标 delivered 前的崩溃点，权限包含 WAL/SHM，磁盘满有明确失败。远程 worker 无共享 state 的能力暂不声称支持。

## 5. 接续义务：可执行状态转移，不止增加字段

沿用现有 handoff、task-plan 和 pulse，每个开放任务保存当前接续义务：`version, scopeRevision, predecessorAssignment, state, responsible, trigger, action, dueAt, evidence`。同一任务只有当前版本可消费；历史保留。通知 ack 不参与关闭业务义务。

| 状态 | 进入条件及责任 | 允许关闭/转移的事件 |
| --- | --- | --- |
| reconcile | 执行身份或外部效果未知；服务负责对账 | 唯一身份与结果证明，或明确人工处置 |
| awaiting_report | 原生轮次已结束，业务报告未接受；服务负责补交 | 已接受的报告回执；永久拒绝转 needs_decision |
| needs_decision | 无结构化合法下一步；Router 负责 | 持久路由决定，且给出授权依据、下一状态与责任方 |
| runnable | 下一动作已授权、可确定；服务负责派工 | 事务保存 successor assignment/start job；不是仅发送 wake |
| running | 已派工；当前执行负责 | 已接受的报告/结算、新输入或停止事件 |
| waiting_dependency | 等具体 ticket/input/resource；服务负责订阅变化 | 精确依赖满足且再次通过 scope/资源检查 |
| waiting_owner | 缺具体信息或授权；用户负责该决定 | 可信用户答复登记后转 needs_decision；其他任务照常推进 |
| paused | 当前有效用户停止/暂停；服务保持 | 更新版本的可信恢复指令；旧 wake 无权恢复 |
| closed | 目标已经验收或取消 | 不因迟到事件重开；新目标走新决定 |

状态转换事务核对当前义务版本和 scopeRevision。一次续派的去重键为 task + predecessorAssignment + revision + action；多次 tick/重启只产生一次 successor。runnable 的 action 必须是现有已授权计划动作，服务不从自由文本猜动作。相同证据与同一阻塞不得再次诊断空转。

到期时只触发对应责任方核查或升级，不把无响应当允许外部操作。Router 不在线要显示 needs_decision/责任缺口并持久重试，不能宣称全自动推进。不能把业务等待算成 CPU 执行槽占用：槽位释放仍以实际资源状态为准。最终统一发布可以依赖集成验收，但不能让独立实现与进度汇报互等。

独立汇报用每张任务的已接受报告生成持久投递项，投递成功只是该项送达，不结束业务义务；若原生聊天没有可靠的逐任务展示入口，状态面板至少即时显示每项，聊天投递保留明确 pending。验收须包含 Router 忙碌/离线，不能只测试调度器并行。

## 6. 实施与验收决定

1. 先做 OSA 内能验证的身份写入保护、现状对账、新 assignment 路径与报告补交，在隔离 state 通过 T1–T7；不逐补丁重启生产。
2. 并行设计并核查 Orca 可信提交入口，使用隔离原生会话验证 T8–T9。现有生产会话只读，不拿业务消息做写入试验。
3. 按上述转移表完成接续协议和独立投递，覆盖 T10–T12，再做组合崩溃、范围修订及停止优先级测试。
4. 所有场景逐项给出证据后集成发布；不能把“框架有接口”“单测通过”“新 worker 已启动”当成用户需求验收。

独立审查实验、补丁、新增 capability 测试及 live history 脱敏证据已归档到 `.osa/architecture-fix-20261103/independent-review-evidence/`，不再依赖 `/tmp` 留存。此次只改文档和隔离实验，生产源码、业务库、服务及 Orca 源码未修改。
