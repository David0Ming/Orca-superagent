# OSA 可靠性方案独立技术审查

2026-11-03。结论：**现方案是有方向的提案，不能作为需求已实现或已验收；A4 和 C 存在尚未证明的原生能力门槛，D 尚缺可执行的责任转移协议。** A1 的一个窄复现可修，但并不能推出 A2–A4 或其他需求成立。未操作业务服务、运行库、配置或真实任务；未部署、发消息或重挂 watcher。原生历史协议未作实机查询，因此以下“未证明”不等于断言该能力不存在。

## 按原需求验收

| 需求 | 结论 | 证据与缺口 |
| --- | --- | --- |
| 补充及新要求不被忽略 | **Fail** | `src/app.ts:150-158` 的 intake 由 Router 主动提交且直接赋 human/owner；`src/router.ts:39` 只用历史尾页验证绑定。未登记的消息不进入输入门禁。`src/app.ts:106-111` 的 ready 门禁只覆盖已登记内容。方案 C 依赖未证实的来源和游标。 |
| 持续推进、真实阻塞可解释 | **Fail** | `src/store.ts:70-84` 产生提醒，`src/projects.ts:201-205` 保存文本 handoff；二者没有强制下一动作的持久执行与完成协议。通知已确认不代表接续完成。依赖、容量、权限和证据不确定时需要各自明确责任与解阻事件。 |
| 无关任务独立运行和汇报 | **Conditional** | `src/orca.ts:194-205` 按 assignment 并行；`bin/osa.ts:176-185` 独立调度来源。不等于无限容量：`canStart`、工作区和资源冲突会有合理共享限制。`retry` 只等待目标 lane，但 `tick` 会等待所有当前 lane；独立对外汇报仍依赖 Router 消费。尚无 A 等用户、B 完成、C 依赖 B 的端到端验收。 |
| 不靠不断手工重挂 | **Fail** | 已有持久 RouterWake 和 notice，但送达/ack 不产生业务完成证明；Router 不运行时语义决策也不发生。须以持久未完成义务和到期升级替代手动 re-arm，且先验证服务确实接管监督，再调整 `skills/super-agent-router/SKILL.md`。 |
| 状态反映当前执行与业务进度 | **Fail** | `src/app.ts:167-175` 返回当前 assignment 报告和 execution.nativeState，但缺当前身份对账、证据新鲜度、报告待交、责任与等待条件；历史报告可能与新 attempt 混淆。ready/终端存在不证明推进。恢复覆盖错误已复现。 |
| 服务中断后报告补交 | **Fail** | `bin/osa.ts:29-42,193-205` 连接失败即退出，每次新 UUID，无本地 report outbox；worker_done 不等于业务报告。B 仍是提案。 |

## A：执行身份和恢复

1. **A1 必要但不足。** `src/orca.ts:112-160` recovery 将新 dispatch 写入 binding，`runAssignment` 在 273–300 随后继续处理未完成 start；`launch` 603–617 从缓存回执无条件覆盖。下述隔离试验验证 ready 成功后在同事务终结旧 start 可修给定复现。失败、unknown、已提交但结果不明的 recovery 仍须保留并对账，不能把它们一律标成功。单个补丁没有处理现有分叉和旧写者。
2. **A2 方案需改为事务内重新读取，而不是比较闭包快照。** recover 在异步 mutation 前读取 `binding`，其 136–145 的事务直接写旧对象。提交时重新读取当前 binding，验证 task/run 和前驱 dispatch；等于本回执才允许幂等，否则保留回执并进入 reconciliation_required。`launch` 在任何保存前作同样前驱检查；检查之外的旧 `poll/observe/cancel` 异步返回与 catch 的 `save(binding)` 也必须审计（例如 299–304、312–324），不能只 grep launch。身份变更后的旧 lane 不得提交旧快照、释放资源或投递。
3. **A3 不能由 worker-show 旧 ID 推定当前执行。** 需要原生 task 的当前 dispatch、原回执和 run/worktree/retry 链交叉证明；不唯一则停止重试、投递与释放并显示 unknown。`src/review.ts:123-124` 已有 `dispatch-show --task` 的可复用只读模式，但其可用性及跨崩溃一致性尚未证明。受影响现存状态应备份后输出清单，不在本审查中改库。
4. **A4 尚无可信同 assignment 新 attempt 方案。** `src/orca.ts:165-168,477-489,603-604` 为 assignment 生成一个 token 并嵌入首次 spec；`recover` 129–130 以原 Task `--retry-of` 启动，并无新 token 参数。`src/app.ts:58-60,86-130` 只校验最新 assignment + token：旧 worker 即使报告自称新 dispatch，仍可 read/ack/report/memo/handback 等；`bin/osa.ts:93-110` 的 review/pr 同样依赖此认证。只在 read 时用旧共享 token 发新 token，旧 worker 也能领取；只有调用者自报 dispatch 或相同 UID/工作区也不能证明身份。启动回执尚未落库时抢先 read 也不能绕过认证。

**最小可落地候选**：若 Orca 能提供不可由旧进程伪造的当前 dispatch 身份证明，受认证握手绑定新 attempt 凭据，回执未提交前返回可重试的 pending，提交事务再 fence；必须先隔离 canary 验证来源和启动竞态。否则考虑在确认旧执行及子资源退出后创建新的 assignment、旋转现有 capability，使 `latestAssignment` 自然 fence 旧 token；保留原工作区及前驱证据，核实新 Task 会改变原生 retry 链和熔断语义，且验证旧 token 无法访问所有修改入口。该候选也尚未证明引擎可以安全创建续派，不能当作已实现。外部动作已发生但未确认时先对账，不能因新 assignment 重做。历史报告确认要单独保留旧凭据摘要与受限回执接口；不允许旧 token 重新获得修改权。

只读 `orca orchestration worker-start --help` 显示 `--task | --spec`、`--retry-of` 需已有 Task、placement 不继承，未展示 attempt 凭据或可信调用者身份注入。它不能证明 retry 的实际 spec 或环境内容；不能据此宣称可用握手。

## B：报告可靠投递

`bin/osa.ts:93-110` 的 ready 在 `app.handle` 前异步 `review.guard/assertReady/unchanged`；`src/review.ts:21-43,123-124` 已校验当前 binding 和审查快照。重用这条路径，不能让补交直接调用 `App.handle` 绕过 review。`App.handle` 在 `src/app.ts:64-67` 使用 `Store.atomic`，`Store` 采用 WAL、FULL、事务（`src/store.ts:8-45`），适合将 report receipt、输入处理、领域变更与结果 outbox 放同一事务。现有 `ticket.ended` + 同 summary 的特判（`src/app.ts:104-105`）不是一般幂等：progress 重复、同内容不同参数及已结束前重放均不能安全去重。

必须补足的协议：

- 本地入队在 socket 前持久提交固定 ID、完整 payload、单 attempt 单调序号和认证材料，明确“已入队”不是已接受。SQLite WAL 和 sidecar 的权限、创建时 umask、并发写入、磁盘满和崩溃必须测试；不要仅 chmod 主 db。state 必须存在且 worker 可写；远程不共享目录时不能承诺。敏感 token 的保存和日志脱敏需评估；禁止把共享 outbox 中的自报 attempt 当认证。
- 服务以稳定 reportId + canonical payload hash 与原主体摘要绑定。先验证回执的原主体，再返回已接受结果，**不以当前 assignment/attempt 检查挡住合法旧报告的确认**；同 ID 异 payload 拒绝。保留凭据摘要的生命周期与迁移策略，避免以 reportId 单独查询泄露。未接受的旧报告仅保存历史证据，不产生当前领域副作用。
- 同 ID 并发 ready 可单飞降低重复审查，但正确性依赖最终事务再次检查 receipt、当前 attempt、scope revision 和顺序；已接受回执应在任何异步 review 前返回。领域事务提交后、响应丢失的重放不可再 reply。审查期间 scope/attempt 变化必须拒绝；不能把历史已接受结果重新解释为当前成功。
- 同 attempt 分配持久且并发安全的序号，服务持久记录高水位；需定义缺号、拒绝、跳号及 progress/ready 乱序如何处理，不能让一个永久业务拒绝卡住后续或其他任务。服务恢复与在线 RPC 走共同处理函数；发送端锁只是节流，不是幂等保证。原生 worker_done 展示 report_pending，不能自动从自由文本宣告 ready。

潜在过度设计：当前只需 report 可靠投递，不需要通用消息总线。独立 SQLite 可复用现有 Store，但 **主库与 outbox 跨库没有原子事务**；用“先领域提交和 receipt，再标 delivered”，崩溃后靠幂等重放，不可假定双库原子提交。异步 review 可能长时间占用处理，应按 attempt 串行而非全局串行。

## C：输入来源与修订

`src/router.ts:26-42` 仅 `history {direction: tail, limit: 1}` 检查 sessionId/runtimeId；`tests/orca-session.test.ts` 只模拟 RPC，不验证消息协议。没有证据证明稳定游标、跨分页一致快照、不变消息 ID、修订、删除/截断、已提交状态或可信 human/system 来源。`bin/osa-router-chat.ts:24-29` 的程序 bootstrap 明确以 `role:user` 创建，因此 role=user **不是** 人类授权；wake、工具、引用和草稿也必须从可信入口分类。纯文本或模型判断不可补足信任边界。

先只读获取版本匹配协议及隔离 canary：跨页追加、重启与重放、编辑和删除、空页与过期游标，核验提交态、来源以及 bootstrap/wake/工具/引用/草稿。若协议缺可信来源或无损增量，应改 Orca 入口提供带认证来源、稳定事件 ID、单调游标及修订/删除语义的提交事件；否则 C 不通过。采集与游标推进同事务，保留原始事件和拆分意图之间的映射。intake 现有手工 ID 与自动登记必须去重并冲突检测；不要把所有 role=user 自动升级成 owner。

`src/app.ts:90,106-107,189-199` 用 scope 字符串和 input ID 列表检查 read；scope A→B→A 在其他快照不变时无法仅由字符串识别。单调 revision 应在每次有效变更、暂停/撤销和输入登记时事务推进；read/review/report 比较版本。已有输入 ID 列表有一定防护，不能据此声称所有 ABA 都已被覆盖。停止应在实际派工及提交外部动作之前重读，不能只在队列时检查。

## D：责任转移、独立推进和状态

方案 D 的结构化字段本身不保证推进。最小闭环是每个未完成目标持久保存一项具有版本、责任方、具体等待对象、截止/触发条件和可验证关闭事件的义务；原子消费事件并去重续派（前驱 attempt + scope revision + action），重启可恢复。确定性规则只处理已经授权且可判定的动作；语义归属、矛盾授权及无法判断的步骤由 Router 决策，并在 Router 不可用时显示责任缺口、重试/升级。仅发送 wake 或确认 notice 不关闭义务。建立变更/取消优先级，在执行边界再次校验，防止等待期间新暂停被越过。相同证据不能反复触发诊断；真实外部动作的幂等或对账独立于 worker 重试。

不必先建立新的调度框架：沿用 `pulse`、现有 dependency/resource 检查和 task-plan，逐任务发现可运行义务。避免把共享容量视为全局依赖；分别定义业务等待、实际资源占用和最终集成发布的依赖。独立汇报应由每个任务的已接受进展生成可重放结果，避免 Router 仅做一次总汇报；报告投递状态与业务完成独立。投影中展示当前 dispatch、观察时间及来源、liveness、最近实质进展时间、report_pending、未处理输入、等待对象和责任方；过期/未知不可称正在推进。现有执行与 handoff 字段可以复用，不必另造第二份权威调度状态。

## 隔离实验与结果

隔离副本 `/tmp/osa-reliability-review-oQlJOU` 使用临时 SQLite、fake Orca 和临时 Git 仓库；依赖只通过符号链接读取原 `node_modules`。从指定复现复制测试并将错误断言改为 `dispatch-2`，增加 restart 后再次 tick 的断言。

- 修改前：`cd /tmp/osa-reliability-review-oQlJOU && npm test -- tests/recovery-review.test.ts` → **1 failed**，期望 dispatch-2，实际 dispatch-1；回执 dispatch-2、recovery done、旧 start pending。
- 修改副本 `src/orca.ts`：仅在 recovery 回执为 ready 时，同事务标记旧 start done。相同命令 → **1 passed**，含 restart 后 tick。diff 保存于 `/tmp/osa-reliability-review-oQlJOU/experiment.patch`，测试保存于 `/tmp/osa-reliability-review-oQlJOU/tests/recovery-review.test.ts`。此为一次性实验而非生产修复，也未覆盖未知回执、旧快照并发、旧 worker、恢复顺序和真实 Orca；临时目录可能被系统清理。
- `orca orchestration worker-start --help`：只读成功；结果和限制见 A4。未连接原生 session 历史或运行 canary。

## 方案 T1–T12 验收

| 场景 | 本次结果 |
| --- | --- |
| T1 | **Conditional**：隔离假原生成功路径改前失败、局部改后包括重启通过；正式实现、真实接口、其他状态未验。 |
| T2 | **Fail / 未实现**：无事务内前驱比较；未注入晚到回执。 |
| T3 | **Fail**：共享 assignment token，无 attempt fence；未做真实旧 worker 写入。 |
| T4–T7 | **Fail / 未实现**：无 report outbox 和原子 receipt；未运行跨进程断线、并发、乱序。 |
| T8–T9 | **Fail / 未证明**：无自动登记，原生历史契约及可信来源未核验；bootstrap 是 user role 的反例已见源码。 |
| T10 | **Conditional**：存在按 assignment 并行机制；完整业务场景和独立投递未验。 |
| T11–T12 | **Fail / 未实现**：无持久接续义务与完整状态投影；未运行组合场景。 |

## 实施结论与顺序

可以先实现并测试 A1/A2 的身份保存、过期异步写入 fencing 和未知状态对账；并行完成原生身份及 session 来源的只读协议核查和隔离 canary，再决定 A4 是可信握手还是新 assignment。A4 未解决前不能声称旧执行已隔离。随后实现 B 的端到端持久报告；C 依赖可信入口，缺失时明确列为 Orca 修改阻塞；D 先定义义务状态机、授权边界、停止优先级与关闭事件，再复用现有调度。最终以 T1–T12 的进程级和隔离原生测试逐条验收、迁移旧在途执行及报告，才能进入集成发布。当前不具备宣告全需求可实现或已经解决的证据。
