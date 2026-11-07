# OSA 消息处理与持续推进：技术方案 v1

状态：待独立窗口审查；这是实现提案，不是已完成的修复。

更新：独立审查已完成，未通过完整需求验收。后续决策以 [v2 修订方案](architecture-reliability-plan-v2-20261103.md) 为准；尤其替代本文 A4、C、D 中尚未闭合的选择。本文保留作审查基线。

## 1. 用户需求与验收边界

原始问题：补充消息和新要求会被忽略；任务无故停止；无关任务等在一起汇报；反复手工重挂监督。最新会话又暴露状态显示与实际执行不一致。用户要求先提出技术方案，再开独立窗口验证是否真正能满足需求。

成功必须同时满足：

1. 已提交到绑定聊天的所有者消息，有可追踪的登记与处理去向；仅已读、唤醒成功或通知已确认不算处理。
2. 当前执行身份不能被历史回执覆盖；旧执行的迟到报告不能改变新执行的业务状态。
3. 服务短暂中断不丢业务报告，重复投递不重复产生领域效果。
4. 每个未完成任务均可解释下一步、责任方及等待条件；已授权且可执行的步骤自动接续；无关任务独立推进和汇报。
5. running/ready/终端存在不能被展示为业务正在推进；汇报有当前执行身份、证据来源及时间。

不承诺 LLM 必然正确理解所有自然语言。系统必须保证漏处理可见、来源可查、阻塞可解释；遇到真实信息缺失或新增外部写权限仍保留人工决策。

## 2. 已有机制与已确认缺口

复用现有 SQLite `Store.atomic`/records、`orca-job`、`orca-operation`、`orca-recovery`、`execution-attempt`、`scope-revision`、`input-resolution`、handoff、task-plan、RouterWake。保留 Orca 作为原生执行生命周期来源；不引入第二个 worker 调度框架、外部队列或新依赖。

| 位置 | 已有机制 | 缺口 |
| --- | --- | --- |
| src/orca.ts recover/runAssignment/launch | 持久操作回执与按 assignment 执行通道 | 恢复后旧 start 作业重放，覆盖新 Dispatch；已有隔离复现 |
| src/app.ts executorTicket | 当前 assignment + capability token | retry 沿用 assignment，尚不能隔离同 assignment 的不同 Dispatch |
| bin/osa.ts rpc/serve | socket RPC、领域事务、ready 的异步审查 | 断线即失败；每次 CLI 生成新请求 ID；没有报告补交与业务幂等回执 |
| src/router.ts | 持久通知与绑定原生 session | 提醒 Router，不采集所有者输入，也不证明处理完成 |
| src/app.ts intake/read/report | 人工登记、范围修订、输入处理门禁 | Router 在调用 intake 之前仍可能漏接；同一 scope 字符串不能表达 ABA 修订 |
| src/projects.ts / src/store.ts | 依赖、资源、handoff.nextStep、通知 | nextStep 是自由文本；通知 ack 可与业务接续脱节 |

证据见 architecture-followup-20261103.md。恢复复现存于 `.osa/architecture-fix-20261103/recovery-investigation.test.ts.txt`；它断言错误行为存在，不能当作修复后的通过测试。

## 3. 实现方案

### A. 当前执行身份及迟到事件隔离（先做）

**A1：在恢复成功事务中终结旧启动作业。** `recover` 保存新 binding、execution-attempt 和 recovery.done 时，把该 assignment 的旧 start job 标记完成并记载 supersededBy。失败/不确定 recovery 必须保留待对账语义，不按 ready 处理。保留旧 operation 回执用于审计。

**A2：所有覆盖 binding 的路径检查预期前驱。** `recover` 在提交前校验数据库中的 dispatch 仍等于 recovery.previous，或已等于此次回执 dispatch（幂等重放）。`launch` 发现存在已完成恢复、或当前绑定与初始回执身份不一致时，禁止覆盖并转入对账。不要复用现有 binding.generation 作为尝试版本：它目前用于 anchor 创建。

**A3：对账先于释放、投递和再次重试。** 使用原生当前 Task/Dispatch 与已保存 recovery 回执核对 Task、Run、workspace 及 retry 链。仅在身份链能唯一证明时修复绑定；找不到唯一当前执行时保持 unknown/reconciliation_required，禁止重复启动和资源释放。worker-show(旧 ID) 证明旧执行状态，不证明它仍是当前执行。现存分叉在备份后按相同逻辑修复，不能直接修改数据库猜测当前 ID。

**A4：隔离同 assignment 的不同尝试。** 报告和修改型 executor 命令新增 attempt 身份校验，事件携带 Dispatch 身份及 attempt 凭据；旧尝试允许补交历史证据，但不能修改当前 report、输入处理记录或结束工单。

关键实现门槛：核查 Orca worker-start retry 的真实启动上下文是否能可靠传递新尝试身份与凭据。不能假定某个环境变量存在，也不能只把任意 --dispatch 字符串当认证。优先利用原生绑定身份；若 retry 只能继承旧 spec，需在受认证的启动/read 握手中发放新凭据，或调整为受控的新 assignment。必须由独立审查验证一个具体可用路径，再选最小实现。启动回执落库前 worker 提前 read 的竞态也必须覆盖。

作用范围：src/orca.ts、src/app.ts、bin/osa.ts 参数与认证、prompt、tests/orca.test.ts、app/CLI 相关测试；必须 rg 所有 binding 写入及 executorTicket 调用方，包括 review/pr/memo/ack。

### B. 报告持久投递及幂等接受

只为 `report` 增加可靠投递，不把所有 RPC 重新封装成通用消息总线。

**B1：提交前本地持久化。** CLI 在连接前，把固定 reportId、完整命令有效载荷、ticket/assignment/attempt、输入快照版本和提交顺序保存到 state 下独立 `report-outbox.db`。复用 Store；目录 0700、文件 0600；不输出 capability。使用独立数据库使主服务和主库不可用时仍可保存。入队失败必须明确报错；“已入队待交付”和“服务已接受”使用不同返回状态，不把排队当业务完成。

CLI 与服务可同时遇到同一条报告，服务端幂等是正确性保障，发送端锁只负责节流。默认只覆盖现有本地共享 state 运行方式；远程 worker 不能访问该目录时，必须有原生持久传输或明确报告不支持，不能声称已可靠交付。

**B2：服务恢复后逐任务补交。** 主循环加载 outbox，通过与在线 socket 报告相同的处理路径处理；同一 attempt 按保存顺序串行，不同任务独立。服务接受后再标记 delivered。网络错误保留待重试；输入无效/授权失效/过期 scope 等业务拒绝进入 rejected/superseded 并产生明确待办，不能无限重试同一错误或静默删除。

**B3：幂等回执与领域修改同事务。** 固定 reportId 对应 payload hash 和结果；相同 ID 同 payload 重放返回原结果，不再 engine.report/reply；同 ID 不同 payload 拒绝。先认证回执所属主体，再返回已提交结果；合法的旧报告确认查询不要求它仍是当前 assignment。保存必要的凭据摘要/主体绑定，避免凭 ID 读取其他任务结果。

`report ready` 当前先执行异步 ReviewGate，再进入 App.handle。在线请求与 outbox 必须经过同一条校验路径；已有提交回执应在重新审查前返回，避免“已提交但回复丢失”在第二次校验时变成失败。并发重复请求需共享同 ID 处理或在最终事务中再次查回执。审查后保留现有 unchanged 校验和最终当前 scope/attempt 检查。

顺序保护：旧 attempt 的迟到报告只入历史；同 attempt 的旧序号不能覆盖新报告。`ready` 因新输入/范围变化被拒绝时，通知执行者重新读取处理，不能自动重新声明成功。

**B4：worker_done 与业务结束分开。** 原生结算只证明该次执行结束；业务报告未被接受时展示 report_pending 并推动补交。历史 worker_report 可以作为核查证据，不能凭自由文本自动将工单标为 ready。worker 允许在报告已经持久入队后结束原生轮次，后续交付由服务负责；工单成功仍等待报告接受及验收。

作用范围：bin/osa.ts 共享报告处理路径及循环、src/app.ts 原子回执、Store 使用、必要时一个局部 report-outbox 模块、prompt 与服务集成测试。测试必须跨真实 CLI/服务进程，不只 mock rpc。

### C. 所有者消息先登记，再交给 Router 解释

在绑定的原生 session 上，复用 sessionRpc 读取带稳定身份的消息，持久保存消费游标与消息登记结果；事务成功后才推进游标。用 sessionId + messageId + revision 去重，保留原文和来源。Router 的手工 intake 关联同一原始消息，不再生成另一条无关输入。

**能力门槛：** 当前代码仅证明 agentSession.history 可读取历史；尚未证明它能稳定分页、提供不变消息 ID、修订及可信 human/system 来源。独立窗口必须只读核查协议或代码，并证明：系统唤醒、bootstrap 的 user-role 消息、工具输出、引用内容、草稿不会被冒充为所有者授权。若能力不足，这一项就是需要 Orca 入口改动的明确依赖，不以“继续提示 Router 记得 intake”冒充解决。

采集只登记事实，不自行推断授权或任务归属。Router 将每条消息处置为 attach/new/answer/context/superseded/needs-clarification，并保存理由及目标；未处置消息持续可见，router ack 不能关闭它。范围修订采用单调 revision，read 保存 revision + 输入快照；ready 对照当前 revision，防止 A→B→A 字符串相同导致过期读取通过。停止/暂停与恢复也按修订顺序处理，旧待办不可越过后来的停止意图。

作用范围：src/router.ts/session 入口适配、src/app.ts intake/route/read/report、Store 登记游标、skill 协议与消息分页/重放测试；不直接解析任意历史 JSONL 作为生产授权入口。

### D. 未完成目标的接续责任及独立汇报

复用 task-plan、handoff 和现有调度器，扩展 handoff 的结构化接续信息：下一动作、责任方（当前执行/Router/用户）、原因、关联 scopeRevision、等待的具体 ticket/input 或授权依据。自由文本 nextStep 保留作说明，不能单独触发外部动作。

1. 当前执行仍有效：投递补充并检查其处理结果；没有新进展时发超时核查，不凭计时器判定执行死亡。
2. 已结算且有明确授权下一步：使用现有资源/依赖/工作区检查创建接续；一次接续用前驱 attempt + 接续修订去重，防止重启重复派工。
3. 等待依赖：只绑定实际依赖；依赖满足时重算可运行性，不等待全部无关任务完成。
4. 等待用户：必须记录缺少的具体信息及阻塞的动作；其他可执行任务继续。答复登记后重新路由，沿用已有授权。
5. 没有下一步或执行身份未知：持久产生需 Router 决策的义务。提醒被确认不等于义务完成；只有实际路由/续派/明确等待/验收结束才能关闭。Router 不可用时显示明确责任缺口，不能承诺模型不运行也能作语义决策。

防止空转：相同 scope、相同证据与相同阻塞不得自动反复生成诊断执行；要求新的输入/证据/明确接续决定。停止或撤销优先于排队接续。后台技术恢复与业务外部动作分别去重，不因换 worker 重做已发生的部署/写入。

status.taskProgress 按当前 attempt 组合：businessState、attemptState、liveness、observedAt、lastProgressAt、pendingReport、pendingInputIds、nextAction、waitingOn、responsibleParty。ready 只表示启动状态；缺最新证据则 unknown。Router 每条进展独立生成/投递，不以一次总汇报作为关单条件；对外汇报引用该投影的身份和时间。

作用范围：src/projects.ts handoff/task-plan、src/orca.ts 调度及结算、src/store.ts routerNotices、src/app.ts status/路由记录、src/router.ts 唤醒、skill；保留现有 dependency/resource/子执行释放保护。

## 4. 必须通过的验收场景

| 编号 | 注入场景 | 必须观察到 |
| --- | --- | --- |
| T1 | 初始 outcome_unknown → retry ready → 再 tick → 重启 | 始终绑定新 Dispatch；旧 start 不再覆盖 |
| T2 | 旧 recovery 回执晚于第二次恢复到达 | 不回退绑定，不重复创建 worker |
| T3 | 新 attempt 开始后旧 attempt 补交 progress/ready/ack | 保留历史证据；当前结果、输入状态不受污染 |
| T4 | 服务停机时提交 report，然后退出 CLI/worker | 报告已持久化；恢复后接受；工单期间显示待交付 |
| T5 | 服务提交报告后、返回响应前断线 | 重放只有一次领域修改及结果消息 |
| T6 | 两个重复 ready 并发，期间 scope 更新 | 最多一次合法提交；不绕过 review 或最新范围门禁 |
| T7 | progress/ready 乱序补交与业务拒绝 | 状态不倒退；拒绝可见，后续任务不被无限重试堵住 |
| T8 | 忙碌时连续两条补充，Router 暂未 intake，服务重启 | 每条只登记一次，保持原文/来源/顺序，有处理去向 |
| T9 | 系统唤醒、bootstrap、草稿与所有者消息混在历史分页中 | 只有可信已提交所有者消息进入授权流程 |
| T10 | A 等用户，B 可执行，C 仅依赖 B | B 独立完成汇报，C 接续；A 不阻塞它们 |
| T11 | 完成诊断但目标未完成；接着用户修改范围/暂停 | 有可追踪接续决定；旧范围不续跑，暂停不被唤醒覆盖 |
| T12 | 终端活着但无新进展；原生结算但报告丢失；Router 离线 | 三种状态明确区分；不宣称持续工作，不静默失去责任 |

单元测试验证身份与事务；进程级集成测试验证断线、崩溃和恢复；原生能力用隔离无副作用 canary 验证。测试材料不得触发真实业务重试/部署/消息发送。最终逐条给出通过证据，能力缺口标未通过；不能只报测试总数。

## 5. 交付顺序、迁移与回退

顺序 A → B → C/D；A/B 通过也不代表已解决消息漏接与持续推进全部需求。

先独立审查以上能力门槛和最小改动路径，再按主题实现。发布前备份 SQLite（包含 WAL 的一致快照），输出受影响任务及回执对账清单。在途旧执行没有 attempt 凭据：只读及历史补交可兼容，但修改型命令不得静默绕过新隔离；需要明确迁移/重新绑定策略，并测试不把真实结果丢掉。新旧 scope revision、outbox schema 与旧 CLI 兼容也须列明。

先在临时 state 演练服务升级与并发报告，再对生产采取暂停新派工、完成必要在途对账、升级并恢复的短窗口。暂停调度不强杀业务 worker。保留待交付报告与操作回执；回退代码不能回滚正在推进的整个业务数据库。旧版本不能读取新状态时，保持服务停止调度并恢复兼容版本，不能绕过 fencing。

不在方案阶段推送、部署或修改业务任务。统一集成验收后按用户偏好交付，避免逐个小改动反复重启。

## 6. 独立窗口的审查任务

独立阅读代码和原始证据，不把本方案当正确答案。重点找反例：A4 身份凭据怎样真正到达 retry worker；B 的 ready 异步审查、旧报告补交认证及顺序；C 的真实来源标记与游标能力；D 是否仍把“提醒”当“推进”。

输出到 `docs/architecture-reliability-review-20261103.md`：逐条需求 pass/conditional/fail、具体函数与反例、必要的最小改案、可运行验证结果、能力未验证项和最终可实施结论。允许在隔离临时目录做最小复现；不修改生产源码、运行库、配置或服务，不重试现有任务，不对外发送业务消息。若要验证接口，用只读查询和脱敏证据。

主窗口只编写方案；新窗口拥有审查文档和其隔离实验。双方不覆盖其他改动。只有方案通过独立审查并补齐阻塞项，才进入正式实现与集成验收。
