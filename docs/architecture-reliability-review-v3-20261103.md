# OSA 可靠性第三轮独立审查与收敛方案

2026-11-03。**建议一次按下述整体契约实现、分阶段在隔离环境验证、最后统一集成发布。** 目前可以给出完整工程路线，但不能声称生产已满足，也不能承诺模型或主机不可用时仍能自行完成语义决策。方案针对当前本机 Orca + OSA、单用户正常聊天和 OSA 服务短暂停机；所有已接收输入、报告和责任必须持久可追踪。真实外部动作结果未知时保留责任并对账。

首选：**Orca 保存并认证输入与执行事实，复用同 Task retry 和 mailbox；DSH 原样负责业务领域；OSA 在两个边界补可靠接管、业务 receipt、责任差量和状态投影。** 不另造业务调度器、九态业务状态机、完整聊天副本或默认本地报告 spool；首版保证 Orca 已可靠接收后的 OSA 服务中断补交。为避免多任务共享 mailbox 的批次被慢审查卡死，OSA 在 ack 前将原生批次可靠接管到已有 Store 的报告记录，之后逐任务消费；这是一条有界的责任交接记录，不是重新发送给另一个通用消息系统。

## 二次复核后的明确决定

1. **不默认建设 spool。** 首版以 Orca mailbox 已持久接收为可靠补交边界；Orca 不可达时返回失败或 unknown，并保持待核查责任。未被任何持久介质接收的正文不可保证找回；未来如要求该情况下 worker 退出后仍自动补交，才扩大范围建设 spool。
2. **面板、CLI、自动重试及停止全部走原生前置 generation fence。** OSA 离线时排队或拒绝；紧急停止可先停进程，但新代不能获得写权。不能把面板 retry 排除为异常。
3. **选择一个原生受限证明 + OSA 共用认证入口。** 现有内部 launch secret 不等于公开证明；原生赋主体，OSA 最终事务检查 generation、assignment、revision 和停止标记。报告复用原生 mailbox，其他命令继续 RPC。
4. **barrier 在线性化位置承诺截至本会话该 barrier 的提交。** barrier 后消息即使早于 ready 领域提交，已登记则阻止旧 ready，尚未登记则进入新一轮并可靠续接；原生明确停止先走 fence。GitHub/飞书分别按确认水位表述，不声明跨来源全局原子。

以上是设计选择，**不是实现证明**。尤其原生受限证明、所有入口前置 fence、可留存 submission 和 barrier、Router 恢复均需实现及真实隔离 canary；已有 mailbox SIGKILL 实验仅覆盖原生已接收后的受控路径。

## 一、对现有尝试的判断

| 尝试 | 判断与决定 |
| --- | --- |
| 原始旧 start 修补 | **根因，保留**。恢复后持久旧 start 重放覆盖 binding；只给 ready 分支加一行不能处理异步旧快照、第二次恢复及资源/停止竞态。所有 binding 写入和外部调用返回都要作前驱条件检查。 |
| 默认新 assignment/新 Task | **不作为首选**。其应用层 token fence 测试成立，但新 Task 会丢 Orca retry 链、熔断累计及部分资源收尾；同 Task retry 原语已有隔离证明。新 assignment 与原生 Task 不是一一绑定，必要时可新 assignment 继续同 Task；是否需要新 assignment 由 DSH 业务生命周期决定，不能为取得新身份强制重建 Task。 |
| 同 Task + 原生身份 | **选定实现路径，接口须补**。原生 fixture 证明 retryOf、不同 hash/incarnation、失败继承与熔断；并不证明真实进程端到端可向 OSA 证明身份。普通 status 能自报另一 dispatch，禁止用它认证；不能把 progress 伪装成 worker_done。 |
| history 作为用户输入账本 | **放弃作为无损入口**。epoch rollover 已实测删除离线未消费 submission；after 游标只是渲染投影。需要一个跨 epoch 的最小 submission 事件留存契约，优先复用已有更长寿命原生存储，不先复制完整聊天。 |
| 单靠 mailbox + receipt | **必要但不足**。三个 SIGKILL 点只证明已写入原生 mailbox、fixture 主体、未启用 review 的崩溃重放；没有证明认证、顺序、批次内任务独立或 Orca 同时不可用。领域 receipt 必须保留。 |
| 每个任务九态、另起调度器 | **删除**。DSH ticketStage/attention/assignment/report 与 Orca task/dispatch 已覆盖主要事实；仅补不能派生的责任、授权依据和消费结果。 |
| 所有 progress 逐条推送 | **不作为需求**。独立任务应有独立待报告责任；同一任务可合并进度，持久记录覆盖范围、最终包含未解决阻塞与最新证据，不能只覆盖 latest 然后无痕丢失待汇报责任。 |

新增实验的两条接续失败从不同层证明同一个根因：通知 ack 可抹掉唯一可见责任，不是两种独立架构问题。报告旧进度回写是另一个根因，固定 ID 幂等不足以解决；强进度逐条失败只要求明确合并语义，不要求逐句发送。本轮独立复跑归档测试得到 3 pass / 3 fail，与报告一致，详见末尾。

## 二、唯一权威与最小持久事实

| 权威 | 拥有的事实 | 边界 |
| --- | --- | --- |
| Orca | 提交事件来源/持久性、Task/Dispatch/retry 链、真实 caller、mailbox、资源和观察、原生请求回执 | 原生 message accepted/worker_done 不证明 OSA 业务完成。新增来源/认证接口必须由 Orca 在服务端派生。 |
| DSH core（保持 vendor 原样） | Trigger、Mandate、Ticket、Assignment、report、attention、线程与终结 | DSH 的 waiting 或 ready 不等于原生进程活跃；`ticketStage` 是业务投影，不写第二份权威状态。 |
| OSA | 连接上述事实：输入登记与 scope revision、原生报告接管/业务 receipt、尚未消费的下一责任、现有 outbox、跨服务对账与展示 | 原生观察缓存必须带 dispatch、generation 和时间；不是新的原生状态机。 |

最少的持久增量，使用现有 `Store` records 而不是新增服务：

1. `ingress-event`：`(stream,eventId,seq,kind,source,contentOrRef,revision)` 和 stream 的连续 `cursor`；复用现有 Trigger/Disposition 保存处理归属。输入事务同时写事件、待路由记录与 cursor。
2. 现有 ticket 附加单调 `scopeRevision`（包括输入、范围、暂停/撤销的有效变更；保留每条依据）；`executor-read` 包含 revision + input snapshot。
3. `report` 接管记录 keyed `reportId`：`payloadHash, ticketId, assignmentId, taskId, dispatchId, nativeMessageId, nativeOrder, senderProofRef, revision, payload, disposition, result`。`disposition` 只区分待处理/已接受/永久拒绝/历史，记录是传输与 receipt，**不是业务 Ticket 状态**；按 native dispatch 的持久顺序维护消费高水位。凭据不进入日志或普通 payload。
4. 一个当前责任版本 `continuation`，存 `ticketId, predecessor, scopeRevision, decisionId, responsible, waitCondition, authorizedAction, consumedBy`（附证据及可选到期时间）。其是否待决由消费结果与领域事实派生；历史可沿已有记录归档，不复制九个阶段。
5. 复用 `outbox` 按 ticket、conversation 保存待投递摘要及 `coveredReportIds` 或连续覆盖水位；已有普通 result 回复继续使用 DSH Replies。显示与投递 receipt 分开；同一外部显示至多一次无法跨崩溃保证。

这些记录不是要求新的数据库表层级；字段命名可跟现有类型一致，不能以省字段为由丢授权、因果或恢复信息。`report` 的原生 order 需要由原生已认证 enqueue 事务赋予，每个 dispatch 独立、连续并持久；如果并发客户端允许乱序发出，调用端必须串行等待同一请求的接受或明确终止；结果不明时先查原生请求回执，不能让后续报告越过，避免把“先发送、后接受”的业务顺序误当接受顺序。真正发出前崩溃不等于已可靠提交，返回 unknown/失败并保留调用者责任。

## 三、输入：从用户提交到处理与授权

1. **Orca 入口改动（必需或证明已有等价存储）**：在真正的提交/修订/撤回被确认的同一原生持久事务中写入稳定 `streamId,eventId,sequence,submissionId,revision,operation,content/ref,provenance`。草稿不产生 submitted 事件；bootstrap、程序 RPC、系统唤醒、导入各有明确来源。renderer 的人类 UI 路径与普通自动化 RPC 需由 host 可区分的可信调用通道赋值，不接受参数自报 `source=user`；沿用现有本机登录用户/会话绑定的授权模型。若普通 RPC 与 UI 实际使用同一无法区分通道，就必须改 IPC/host 接口，而不是换字段名。此分类防止偶发误归类，不声称防御拥有同 UID 全部本地文件和 IPC 权限的恶意进程。
2. 事件按独立于渲染 epoch 的单调序列保留；为 OSA 会话登记稳定 consumer 与连续确认水位。在 ack 前不因 epoch、压缩或普通保留期删除；容量不足对提交明确背压或给出未确认失败，不静默丢弃。消费从明确启用位置开始，旧历史标 unknown。读取返回 head、floor、cursor 和 gap。不可恢复损坏/备份回退时显式 gap，阻止**可能依赖该区间**的授权续派或 ready；不相关且可证明独立的工作继续。不得宣称 gap 告警等于完整接收。
3. OSA 定期读取：同一事务写原文/引用、去重、待路由、范围版本和连续 cursor，提交后再 ack Orca。崩溃重放通过 eventId 去重。同事件多意图时保留原事件→子意图映射；Router 决定 attach/new/answer/context/clarify 并保存目标和依据。不得由采集器把含糊文本直接扩大权限。UI 接收与业务处理分别展示；撤回/暂停先改变版本并阻止排队的旧动作，已提交的外部操作仍需对账。
4. 原有 GitHub/飞书来源继续用其已有身份与游标，不将原生 UI 标签套在其他来源；来源共用 DSH intake 的事件身份和明确归属。对于无法证明归属的补充，形成未决路由责任，不能因无 ticketId 就悄悄略过。
5. **barrier 的线性化位置**：Orca 在与提交事件相同的 stream 持久事务序列中写 barrier，barrier 的排序位置就是该次完成所涵盖原生聊天输入的截止点。OSA 消费至 barrier 并完成相关路由后，在领域事务中重查 scope revision、待处理输入和 fence，再提交 ready；若 barrier 后的新提交恰好在 ready 领域提交前已进入 OSA，则 revision/未决输入检查使本次 ready 失效或重试。若它尚未进入 OSA，则它按排序属于下一批输入：必须可靠登记、显示未处理并触发对已结束 ticket 的合法重开或新接续；不能被先前结果吞掉，也不能将结果描述为已覆盖该消息。barrier 前归属不明的消息保留 Router 归属责任，只阻止它可能影响的完成；能够证明无关的其他 ticket 继续，无法排除关联时暂缓受影响完成并显示原因，而不是永久锁住所有工作。对外结果说明覆盖的各来源水位，不能宣称覆盖之后的消息。
6. **停止优先**：原生面板上的明确取消/暂停控制事件应在接收时走下面的受管 Task generation fence，不先等 Router 的语义判断；同 stream barrier 后的显式控制事件只要在领域提交前已登记，也必须使旧 ready/续派失败。自然语言“停止”仍先可靠登记，Router/确定性显式命令识别后立即 fence；未判断前按可能相关的未决输入保守处理，不能假称任意自然语言都被机器无误识别。GitHub/飞书没有此原生 barrier：使用各来源已有持久 source watermark，分别排空到已确认的水位，并在结果中表述“截至该水位”；源不可用或 gap 对受影响任务显示未知。不能虚构所有来源间的全局原子时刻。

**源码/实验已证**：原生 after/epoch/revision 形状，bootstrap 是 `client/user`，rollover 会丢未消费事件。**尚未实现**：跨 epoch 保留、UI 来源可信通道和消费者水位。需真实隔离 UI/自动化 canary 证明；来源只是可靠性信任边界，不能把同 UID 程序隔离说成安全沙箱。

## 四、执行身份：同 Task retry，具体握手及并发栅栏

在 Orca 扩展一个窄的**已认证 worker 命令/报告入口**：沿用现有 `verifyOrchestrationCompatibilityCaller`/当前 `isDispatchProcessCurrent` 等权威检查，在 Orca handler 内核验当前 Task/Dispatch、pane/session、host、incarnation 和现有 launch 证据后，以服务器生成的不可由普通 status 自写的主体与消息 ID 写入 mailbox。真实可用性及 structured-session 模式须 canary；现有 launch token 的实验只证明模拟 PTY 注入，不能假定所有 agent 都能取得。原生返回或持久信封应包含 task/dispatch/incarnation/原生 order、固定 reportId 和 payload hash；不把 secret 放到 mailbox、参数日志或普通 status。旧 caller 即使携带旧 assignment token 或声明新 dispatch，也不能通过此入口。

**唯一首选身份接口**：新增 Orca `attestOsaWorker`（名字为拟议接口），通过当前原生 RPC caller 认证及上述进程/session 校验，返回受限、短时的原生证明；证明由 Orca 赋予 `issuer/runtimeId, taskId, dispatchId, hostId, incarnation/session identity, generation, subject, expiry`，并通过可信本机 RPC 发给当前 worker。内部 `ORCA_AGENT_LAUNCH_TOKEN` 和只读 hash **不是现成的公开 OSA 证明**，不得直接当此接口使用或放进日志。OSA 统一认证入口验证 Orca 证明的真实性、受众和期限，绑定本地 ticket/assignment/task，再比对持久 generation；worker 在启动回执未落库时得到 `pending` 而非旧 token 放行。`read/ack/acknowledge/thread/handback/memo/review/pr/report` 都经过这一入口；read/review/pr 保持现有异步 RPC，不为它们再造 mailbox 总线。report 经认证原生 enqueue 后，原生为消息写不可由发送者自报的同一主体和顺序元数据。已接受的旧报告按保留的主体绑定只读确认，不能借此取得当前写权。

**全入口前置 fence（明确采用）**：Orca 将受管 Task 的面板 retry/stop、CLI 和自动 retry/stop 全部接入同一个变更门禁，任何创建新 Dispatch、变更执行权或放开新代写权限之前，必须先请求 OSA 持久 fence 当前 generation，并等待 OSA 已进入临界区的写事务结束。OSA 在 `Store.atomic` 中关闭旧 generation、保存变更 intent；该提交是旧凭据的业务失效点，此后所有最终业务事务同样检查 generation、assignment、scope revision 和停止标记。原生收到持久 fence 确认后才执行对应 mutation；新回执经前驱 CAS 落库才开放新 generation。慢 review 在事务外，最终提交重新检查；发布等外部操作在发出前重查，已经发出的写只能对账。已发放的旧证明即使未过期也会被 OSA generation 拒绝。

OSA 离线时，Orca 将普通受管 retry/stop 请求持久排队，或明确拒绝并显示等待 OSA；不能先创建新代再事后对账。紧急物理停止允许先中断进程，但原生必须持久记 pending fence/stop，禁止新代获得业务写权，OSA 恢复后优先完成 fence、对账和后续处置；它不能撤销已经提交的旧领域或外部效果。重启恢复通过相同 request ID、request-show 和 dispatch-show 对账，绝不因为锁租约超时放行未知写者。面板操作是正常支持路径；未经该门禁的外部绕过必须由 Orca 阻止。这个原生门禁是需要新增并证明的接口，不是现有实现已具备的保证。

`src/orca.ts` 的 start/recover/launch、sendInputs、poll、observe、cancel、release、异步错误回写所有 `save(binding)` 使用期望 `(assignment, task, dispatch, generation)` 条件更新。恢复成功事务终结被取代的 start，留旧回执；未知回执保留 pending/reconcile，不当成 ready 或盲目重试。retry 前确认旧进程退出、子资源处理/保留状态和 workspace；保留 Orca failure_count、熔断及 retryOf；外部效果未明先核查。`canRetry` 不适用于所有 waiting，按真实领域语义选择当前 assignment 继续、合法 DSH retry 或持久 Router 决策，不伪造 deliveryFailed。资源已确认退休不等于业务目标已完成。

## 五、报告：本地调用、原生接管与业务接受

**范围决定：首版不引入本地 spool。** 已认证原生 mailbox 成功接受后，报告能在 OSA 重启期间保存并重放，CLI 返回 `native_queued`，不声称业务接受；即使 worker 正常退出，原生未确认的报告仍是待 OSA 接管的持久责任。Orca 不可达时 CLI 明确失败；发送结果不明时返回 `unknown`，保留相同 reportId 和原生 requestId，以 request-show/同 ID 安全重试并暴露未决责任，绝不声称已排队或自动完成。此时不得静默发送成功的 worker_done 后消除责任：worker 保持待恢复，若已退出则由持久执行/未决报告义务驱动核查；尚未被原生或本地持久介质接收的报告正文无法承诺可找回，必须明确报告这个边界。原始复现是 OSA 中断且 Orca 可接收；没有证据要求 Orca 也不可用时 CLI 仍返回可靠 queued。若今后明确要求该更强故障边界，再增加仅限报告的本地持久 spool 和凭据保护/重放测试，不作为本轮默认实现。

固定 reportId 由客户端在首次提交前生成并贯穿重试；原生 requestId 同 payload 去重，并在接受事务记录认证身份与每 dispatch 连续 order。客户端超时先查询原生 request receipt 并使用同 ID 重放；同 ID 不同 hash 永久拒绝，不允许造新 ID 绕过不确定性。需要定义可恢复的 ID 来源；客户端在报告持久接收前崩溃不属于已可靠排队。

**避免 mailbox 批次阻塞**：OSA 收到原生 delivery 后验证信封格式和原生来源，在单个 `Store.atomic` 中逐项幂等写 `report` 接管记录及原生 delivery 对应关系，然后 ack 原生批次。该 ack 表示 OSA 已可靠接管，不表示 `engine.report` 成功；批次中非法消息记录为可见拒绝，不能阻止其他任务接管。OSA 接管记录按 ticket/dispatch 并行、同 dispatch 按 native order 串行消费，慢 review、gap 或永久拒绝不得阻塞其他 ticket。该选择比实验的“业务事务后再 ack”多一个持久中间接管阶段，必须新增崩溃点验收，不能把先前实验当成已有证明。

处理函数共用在线/补交路径：

- 先按原主体验证 receipt 查询，已接受的同 ID/同 hash 直接返回原结果，**在 review 前**；同 ID 异 hash 拒绝。此历史确认只读、绑定原主体，不能要求 assignment 仍为当前，也不能允许任意 ID 枚举。
- 尚未处理且顺序连续的报告，先对当前 fence/revision 做初查，ready 沿现有 `ReviewGate.guard/assertReady/unchanged`；然后 `Store.atomic` 再读取当前 generation、scope、输入处理及 report 顺序，调用 `App.handle/engine.report`、写 input-resolution、handoff、outbox 和业务 receipt，一起提交。并发相同 ID 最终再查 receipt；旧 dispatch 的未接受报告只保存历史证据，不能改当前状态。旧 receipt 本来已接受则按原结果确认。
- 同 dispatch 中后序等待缺口；永久非法、撤销、stale scope/attempt 明确记拒绝及可见后续责任，并可推进该序号，不得无限阻塞。已经终结/接受的高水位不能被低序号覆盖；保留原文与 disposition。ready 因新输入过期时要求当前执行重新读取处理，不自动将旧 ready 改成成功。
- 发生原生 worker_done 而报告仍未接受时显示 `report_pending` 并保持补交/核查责任；不得把自然语言 worker_report 当业务 ready。结果与进度复用现有 outbox，按任务发送或明确合并；原生入队、领域接受、对外显示是三个独立事实。

## 六、接续、Router 恢复、汇报与真实状态

`src/store.ts:routerNotices` 不再作为唯一责任来源；在报告接受、原生终结、用户输入/答复、依赖变化及定时扫描时，派生是否有未完成目标。若无在执行动作且无真实等待，持久产生 `continuation`，其责任方为当前 worker、服务、Router 或用户，等待条件必须指明具体对象/输入/证据。**Router 通知 ack 只处理通知投递；不会修改 continuation。** 具体 Router 决定必须同事务记授权依据和新责任；服务对明确结构化的已授权动作，在 `Store.atomic` 校验 `scopeRevision + predecessor + decisionId + 依赖 + stop`，写现有 assignment/job 与 `consumedBy`。一次决定重放返回原 job；调度依旧由 `OrcaExecutor.pulse`，不新建另一调度器。没有可确定动作、权限或证据时生成 `needs decision` 投影，不从自由文本猜部署等外部写。

对于可执行的授权内下一步，Router 记录具体动作后服务持续投递；正常等待用户则记录一个具体问题，其他 ticket 继续。闲置 Router 用现有 `RouterWake` 的原生结构化 session/message 唤醒，未消费责任按退避重复提示，直到决定持久化，唤醒回执和 notice ack 均不算完成。Router 进程/会话退出或 Orca 重启时，由现有 supervisor 持久恢复绑定：先查询 session/runtime incarnation 和当前 lease，能恢复原 session 则恢复并重新绑定；确证旧 Router 退出且 lease 已失效、无其他持有者后，可按已保存 bootstrap/创建操作 ID 启动一个替代 Router 并交接待办。身份未知或冲突时停止自动接管，明确显示责任缺口并重试/升级；不盲目启动第二 Router。此恢复/绑定流程目前是**需要实现和 canary 的新适配**，不是现有 RouterWake 已经保证的能力。Orca/主机关闭或模型服务长期不可用时只能持久等待并显示原因，不能承诺自动语义进展。

对外结果由现有 DSH Replies/OSA outbox 逐任务保存。允许在一次未发送的任务级消息中合并多个 progress，但要在原子事务记录被覆盖报告集合/水位、摘要包含尚未解决阻塞和最新证据，已发送的消息不能在本地伪装成已更新。断线前后使用现有消息 ID 去重与外部渠道回读；不能保证任意外部 UI 恰好一次。用户明确请求某次更新时不可用合并掩盖它未处理。

`status` 按最新 assignment + 当前 native dispatch 给出业务 report、可用的 liveness/时间/来源、lastProgressAt、report_pending、未处置输入及 continuation 的责任/等待。过期或无法对账为 unknown；终端存在、原生 ready、heartbeat 和旧报告不能推导当前业务有进展。对外消息引用来源时间；不得把本地 finished 作为唯一退役证明。

外部效果未知：在现有发布或授权动作之前持久化 intent（目标、scope revision、前驱、幂等键/指纹）；提交后查询外部系统与原生回执。只对具体动作进入 reconcile，其余独立任务继续；若无法唯一确认，保留责任并向 Router/用户提供所缺证据，禁止自动重复。`src/publish.ts` 的 intent/assertCurrent 可作为起点，但检查与远端 push/PR 创建不原子，必须承认检查后外部动作已发生的窗口；不能宣称暂停能撤销已发出的外部写。

## 七、迁移、边界与实施顺序

- 升级前以 SQLite 一致快照备份 OSA 和必要的原生记录，列出在途 task/dispatch、待交报告、未处理输入和不确定操作；暂停新派工但不强杀 worker。迁移固定 stream 起点，旧无 provenance 标 unknown；从旧 ticket 输入建立初始 revision，不能推断漏掉的历史。旧版 worker 的 assignment token 不再绕过新认证，能证身份的平滑握手，不能证的保留只读/待对账并安排受控接续；历史已接受 receipt 不丢。
- 新 Orca 实现与 OSA 协议能力先显式协商；缺少输入留存、caller 认证或 native order 时显示不支持、保留原数据并禁止依赖该能力的自动完成。保留原生消息和 OSA 接管/receipt；回退不能把正在推进的业务库还原成旧快照，旧二进制不懂 fence 时停止自动调度，使用兼容版本恢复。
- 实施按一个主题集成：① Orca 输入事件/已认证命令及 coordinator fence 契约；② OSA 旧回执 CAS、身份接入和报告接管/receipt；③ 输入路由与 revision、责任消费、Router 恢复及任务级汇报/状态；④ 原生与多进程组合验收。各阶段可本地提交，不逐步发布；最终统一验收后再部署。不要修改 DSH vendor；必要的新领域动作优先使用公开 Engine 方法，如语义无法真实表达才设计窄上游兼容入口，不能直接伪造状态。

## 八、有限最终验收矩阵

| 合并场景 | 覆盖 | 验收必须观察到 |
| --- | --- | --- |
| 输入留存及信任 | T8–T9 | 两条正常 UI 提交、程序 bootstrap/wake、草稿、修订/撤回；OSA 离线跨 epoch/压缩并崩溃在领域提交前、提交后 ack 前、ack 后，按源准确一次登记；满容量明确失败，gap 阻断相关自动完成。正常 UI 实测身份可信通道。 |
| 恢复与旧写 | T1–T3 | 初次 unknown→同 Task retry→多 tick/重启，原生链和失败预算保留；迟到旧 recovery/观察/旧 worker read、ack、report、review、pr 全拒绝当前写；启动回执前 read pending；面板、CLI 与自动 retry/stop 与 OSA 提交并发均先经持久 fence；OSA 离线时排队/拒绝，紧急停止不放开新代写，旧证明即使未过期也失效。 |
| 报告事务 + 并行 | T4–T7 | 两个独立 ticket 混同 mailbox 批次，一个 ready review 慢且 scope 改变；另一个仍完成。分别在原生接收、OSA 接管前/后、原生 ack 前/后、review 前后、领域提交后响应前 SIGKILL；固定 ID 重放一个领域结果，旧序/异 payload/永久拒绝可见；不重复外发。Orca 不可达时明确失败/unknown，不声称 queued，未决责任可见；若未来扩大保证才测试本地 spool。 |
| 持续责任与独立结果 | T10–T11 | A 等用户，B 独立完成且对外可见，C 只依赖 B 接续；通知 ack、Router 空闲/退出、OSA/Orca 重启不能丢责任；同任务 progress 合并有覆盖凭据。用户答复/暂停/范围更改与旧排队动作交错，旧动作不得执行；验证 barrier 前、barrier 后且 ready 前已登记、barrier 后尚未登记三种顺序及后续接续；面板停止先 fence；GitHub/飞书分别报告已确认水位。 |
| 事实投影与未知 | T12 | 终端存活无进展、原生结束但报告 pending、Router 离线、旧观察迟到和外部效果未明分别展示；不声称正在推进或已完成；对账后只恢复有证据的步骤。 |

每组同时保留现有失败复现与关键控制作为回归；有选择地跑相关单元、服务进程与一个隔离原生 canary，不要求对每句 progress 做逐条推送测试。最终验收要在目标版本真实 IPC/agent 中证明，不以 fake Orca、单测数量或送达成功代替用户可见业务结果。

## 九、实际核查与证据界限

- 阅读了指定新增报告、v2.1、两轮原审查及归档实验源码和日志。`mailbox-process.ts.txt` 实际直接使用原生数据库与 fixture token，领域 receipt 为实验增量，未使用真实 CLI/IPC 或 review；其三个真实 SIGKILL 结论仅限已原生入队后的崩溃。
- 将 `minimal-route-verification/isolated-source.tar.gz` 解到 `/tmp/osa-review-v3-6ak80M`，只链接仓库 node_modules；运行 `rtk proxy node node_modules/vitest/vitest.mjs run tests/minimal-route.test.ts` → **3 passed，3 failed，exit 1**，与原报告一致。日志 [recheck.log](../.osa/architecture-fix-20261103/review-v3-evidence/recheck.log)。失败原样保留；逐条进度失败是更强测试，不直接认定用户要求逐条推送。
- 复核原生实验的 source：retry 测试直接调用 `createStartingWorkerDispatch/prepareStartingWorkerAuthority/failWorkerStart`，status 反例通过 RPC 测试 harness；这两项均非真实 worker canary。`rpc/orchestration-legacy-authority.ts` 与 `messaging/send-point-to-point.ts` 展示已有 caller/process 核验可作为设计起点，但上述新认证接口、顺序分配及跨库 fence 均是**提案而非已实现事实**。
- 未运行新原生 UI/进程 canary，未修改生产源码、vendor、业务库、配置、服务、Orca 源码，未操作真实任务或对外发送消息。证据不证明断电持久性、真实认证、跨版本兼容或全部需求已经通过。
