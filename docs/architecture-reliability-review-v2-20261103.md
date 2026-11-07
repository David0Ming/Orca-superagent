# OSA 可靠性方案 v2：第二轮独立审查

2026-11-03。范围为 v1/v2、首轮审查、当前 OSA、指定 Orca 源码与固定版 DSH 上游；未改生产代码或运行状态。

## 总体结论

**有可实施路线，但 v2 还不是足以保证全部需求的完整设计。** 新 assignment 是已证明的应用层可靠性隔离候选，报告 outbox 加领域回执可实现短暂停服恢复，按任务并行与持久接续也可在现有框架上实现。它们需要明确并验证原生资源收尾、幂等边界和状态迁移，尚无端到端验收。

两个具体设计缺口需要先补：第一，Orca history 是可重置、可能压缩的投影，v2 只提出来源和游标，没有保证 OSA 离线期间每个已提交事件仍可找回；第二，v2 的九态义务可能与 DSH Ticket/Assignment/report/attention 重复并产生矛盾，必须指定唯一权威、原子事件和恢复规则，优先做差量责任记录而不是第二个完整生命周期。另有新 Task 改变原生熔断、旧任务回收和外部效果对账等必要约束。**尚未编码本身不是上述判断的原因。**

证据标签：**设计可行**＝有具体实现与边界，不表示已实现；**有条件**＝有明确路径但依赖契约或决策；**缺口**＝现有方案存在可构造反例；**已验证**仅限所列实验。自然语言意图仍需解释，无法保证模型必然正确；系统可以保证原文、未决责任、失败及证据不被静默丢弃。

## 逐条需求与端到端路径

| 需求 | v2 设计判断与反例 / 必要补充 | 当前实现 | 尚需验证 |
| --- | --- | --- | --- |
| 补充、新要求不漏接 | **有条件，当前设计有缺口。** 原生提交→持久来源与不可丢提交记录→OSA 消费/登记→授权→Router 归属→投递→read/处理回执。`source=user` 不可信；若 OSA 离线时 epoch 被替换，旧 journal 行删除，单靠新游标/快照不能证明每条事件、尤其修订或已删内容完整。需 Orca 持久 submission 事件保留直到消费者确认或可验证补扫，包含撤回/编辑次序、来源及不可恢复 gap 告警；若快照保证所有已提交消息和修订且可证明，优先复用快照而非加日志。登记与游标原子化，未知来源不升级授权，意图拆分保留原文与关系。 | Router 手工 `intake`；`App` 已保存 trigger、scope/input resolution，但未采集原生聊天；history 查询确有 nextCursor。 | 关机跨 epoch/压缩、重放、编辑/撤回、草稿、重复页、系统事件与同账号自动化；UI 身份边界及远程客户端。 |
| 授权内持续推进，真实阻塞可解释 | **有条件。** 受理→当前授权和 scope revision→计划/依赖→派工→执行报告→未完成目标→持久下一步。v2 的 runnable 仅适用事先可确定的结构化动作；现有 handoff 是自由文本，无法自动转出授权动作。未有可确定动作时须持久 needs-decision，指定 Router/用户及等待事件；真正缺信息只阻塞有关步骤。必须持久消费决定并与续派去重事务联动，且启动和外部写前再次检查停止/撤销、外部效果不确定时对账。 | DSH retry、输入重投、attention 和 OSA handoff/pulse 已存在；业务目标与自动下一动作尚无完整闭环。 | waiting→用户答复→路由→续派、失败恢复、先暂停再排队、反复 tick 不空转、外部副作用不重复。 |
| 无关任务独立运行、独立报告 | **可行，有容量与共享资源限制。** 按实际依赖与工作区/资源独立排程；每个报告经领域接受后分别进入持久对外队列，不等待其他任务或 Router 汇总。发送成功和业务完成分别记录。全局处理循环、慢 review、同目标资源占用和订阅传输需要可见且不能无关阻塞。 | `src/orca.ts:194-205,232-245` 每 assignment lane、容量/资源门禁；`src/app.ts:33-38` 已有业务出站 outbox；Router 通知需要消费，不能据此证明即时对外送达。 | A 等用户、B 独立完成并投递、C 只依赖 B；Router 忙/离线、容量不足/恢复、不同任务慢 review。 |
| 不再手工重挂 | **可行但有条件。** OSA supervisor/pulse 与 Orca 监督和持久回执配合，可由服务持续持有接续责任；需要实际处理完成证据、重启恢复和 Router 不可用的升级，不以唤醒/ack 关义务。Orca coordinator 本身不是无人值守的业务决策器。 | RouterWake 持久操作与重放、定时 pulse、supervisor 已有；技能仍含 watcher 行为，通知仍可与业务接续脱节。 | 服务及 Router 不同故障窗口、lease 恢复、责任超时升级与唯一监督者；集成通过后才改 skill。 |
| 当前执行和业务进展真实 | **可行。** 从 DSH 最新 assignment/report、Orca 当前 Task/Dispatch、worker/fleet、报告 receipt 和义务差量分别派生；附来源/时间，过期记 unknown，终端/ready/心跳仅为执行存活或启动证据，不是业务推进。旧异步回执按前驱/版本 fence，不写当前投影。 | `src/app.ts:167-175` 有部分投影；`src/orca.ts:312-324` 保存观察；旧 start 可回写错误身份。 | 慢观察与重试交错、原生完成但报告未提交、活着无进展、旧 terminal 与新 dispatch、服务/Router 离线。 |
| 服务中断报告不丢 | **可行，限 worker 可访问持久本地 state 且成功入队。** report→独立本地队列固定 ID/顺序→共同处理路径→receipt 与领域变更同事务→deliver 确认→领域出站消息→业务接续。主库停机时原生 inbox 或 DSH 出站 outbox 不能自动替代该提交保证；双库不能原子提交，靠业务 receipt 重放。永久拒绝必须显式待处理，不能静默当成功。 | CLI socket 断线失败；尚无 report 入站 outbox/领域 receipt。`App.handle` 使用 SQLite 事务；出站 outbox 与此方向不同。 | CLI/worker 退出、服务和系统崩溃各提交点、重复/乱序、磁盘满与 WAL/SHM 权限、旧主体确认、review 并发；远程不共享目录单列不支持。 |

## 执行恢复：复用与必要取舍

`vendor/dsh-core/src/tickets.ts:168-179` 的 `retryTicket` 结束旧 assignment、重投未取输入、生成新 assignment、调用 executor.stop/start；`src/orca.ts:165-168` 每 assignment 创建 capability。隔离重跑验证旧 token 无法通过 `App` 的 read/ack/report/memo/handback/thread/acknowledge，换新 assignment 后 token 仍不匹配，重开 Store 保持隔离（见实验）。这是对无恶意同 UID 旧 worker 的**可靠性 fence**，不是抵御可读取共享文件/数据库的新 token 的安全沙箱。`review`/`pr` 真实 socket 和异步期间替换尚未覆盖。

新 assignment **不是逻辑必然**：Orca 在每次 preamble 注入 task/dispatch ID（`src/main/runtime/orchestration/preamble.ts`），并在原生层有 launch-token hash、consumer generation 和 assignee identity（`db/worker-dispatch/worker-dispatch-authority.ts`）。但这不自动成为 OSA socket 的不可伪造调用者凭据；自报 dispatch、从共享旧 token 兑换新 token 都不够。若版本匹配的原生调用者身份/带凭据报告通道能证明当前 dispatch，适配后可保留同一 Orca Task 和原生 retry；是否可从 OSA 安全验证和处理启动回执前的 read 尚未证明。不要假定内部 launchToken 是对外公开可用 API。现阶段新 assignment 是低侵入、已部分证明的候选，不应宣称唯一可行或一定最充分复用 Orca。

新 assignment 按现有 `launch` 的 `--spec` 通常建新 Task；Orca `worker-dispatch-start.ts` 把 retry 串 `retryOf` 上的 `failure_count` 继承、在 circuit_broken 时拒绝，阈值 `dispatch-circuit-breaker.ts` 为 3。新 Task 因而绕开原生跨 retry 计数与拒绝；仅做 OSA 自己的“最多 N 次”并不等价于保留原生拒绝理由。`retried-worker-terminal-release.ts` 只在 retry-of 的特定条件异步请求回收旧 terminal，且不等待成功；新 Task 不走该分支。明确先以旧 dispatch/host/incarnation、子 Run、输出归档和 user-owned/retained 情况核实停止与资源退出，再允许新工作；预算按工作线持久化并包含已发生原生失败、明确承接 circuit_broken/权限拒绝，禁止换 Task 绕过；不确定外部效果阻断相关动作。`canStart` 仅以 binding.finished 和目录/资源冲突判断，不能单凭 finished 证明原生资源退出。

实际 `Engine.retryTicket` 同事务排队 stop 和 start，不是先完成停止；不同 assignment lane 可并行。v2 步骤必须在**排队 successor 之前**具备可靠退役证明，且在 start 前再次检查，不依赖调用顺序。`src/orca.ts:651-663` 已经在已结算/已 finished 且有迟到输入时调用 `deliveryFailed` + core retry；这是现有实现的特定路径，不应泛化为可以为任意失败伪造 deliveryFailed。旧 `launch/observe/poll/cancel` 异步回包必须使用预期 binding 条件更新；PR publish 的 `assertCurrent`（`src/publish.ts:74-95`）可复用，但其检查到 push 之间仍有不可原子化的外部操作窗口，需持久 intent 和变更后对账，不能承诺彻底取消已开始的 push。

## Orca 能力盘点与 v2 去重

安装 CLI/应用版本 1.4.227，`/Applications/Orca.app/Contents/Resources/orca-local-build.json` 的 build commit 为 `7c19f712f77ba9fa629ccf0abb9a50503c8c3750`，等于 `/Users/mzg/workspace/orca-resource-lifecycle` HEAD。该源码 `package.json` 标 1.4.224，构建元数据标 1.4.227；不能只用 package 版本判断。工作树有他人未提交修改，尤其 `worker-release.ts`，因此修改过的文件不能当作已安装实现；其余下述源码位置均在该 commit 路径内且本轮检查未改动。`patches/README.md` 明确配套资源政策补丁尚未安装；不能把补丁能力归于运行版。只读加载版本匹配 `orca skills get orca-cli --json` 和 `orca skills get orchestration --json`；本轮不启动或控制工作任务。

| v2 要素 | 原生已有能力及证据 | 结论 |
| --- | --- | --- |
| Task/Dispatch/attempt、失败及 retry | `db/worker-dispatch/worker-dispatch-start.ts` 校验 task、最新前驱、已终态、失败次数；`worker-dispatch-outcome.ts` 累计失败。`preamble.ts` 注入新 dispatch/task。 | **直接复用**身份、链与熔断；新 assignment 跨 Task 需薄适配关联及预算，不复制原生状态机。 |
| 启动/停止/投递幂等 | `worker-dispatch-start.ts` 同事务保存 caller/requestId/method/payload hash 与 pending acceptance；`rpc/.../runs/mutation-request-show.ts` 查持久回执。OSA `src/orca.ts:420-439` 已保存 operation 并使用 retry-request/request-show。 | **直接复用** Orca 操作回执和未知结果对账；删除额外通用 RPC 重试框架想法。回执是 Orca 操作结果，不是 OSA report 领域提交。 |
| inbox/check/ack | `rpc/.../messaging/check-run-pending-mail.ts` 持久 delivery ID、消费 generation fencing；`check-worker.ts` 与 `db/messages` 保存 mailbox。OSA `orca-delivery` 关联 input，调用 check/ack。 | **薄适配**，按现有 delivery ID 重放并分清送达、读取、业务处置；不能把 ack 当 scope 已落实。 |
| worker_done/results | `db/dispatch-context/worker-report-settlement.ts` 对 task/dispatch 状态、重复报告及活跃冲突作事务校验；结果与 worker_report 归属保存在 Orca。 | **直接复用**原生结算证据。不是 DSH `engine.report` 的业务成功/输入处理证明；不能自动用自由文本结单。 |
| liveness/fleet/资源 | worker-show/list 和 `worker-observation.ts`；stop、release 及 `retried-worker-terminal-release.ts` 对资源和所有权处理；原生释放成功/retained 必须区分。 | **薄适配**采样及证据时间；不另造监控代理。观察是点时事实，expired/unknown 不代表死亡或进展。当前已修改的 `worker-release.ts` 工作树不可作为安装版证据。 |
| session submissions/history | `agent-session-journal/journal-cursor.ts` 有 epoch/sequence、compacted/ahead/epoch_changed reset；实际 shape 有 revision、itemId、window.nextCursor；`journal-epoch-rollover.ts` 删除旧 epoch 行。 | **薄适配**分页、去重及重置；**Orca 缺口待补/证明**：可信 provenance 和无丢提交事件保留/重扫契约。不要另建整套渲染历史。 |
| wake/自动接续 | Orca preamble 指示用户检查邮箱、报告及结束后停止轮询；Orca Task、mailbox 能协调执行，但未见其替 OSA 理解业务目标并创建授权接续。`RouterWake` 是受控提醒。 | **复用传输和生命周期**；OSA 增加持久决策/义务差量。不要把自动唤醒等同自动完成。 |
| report outbox | 原生 inbox 与 request receipt 持久，但发送需要 Orca 可用，且成功只证明原生接收；现有 OSA/DSH `Outbox` 是业务**出站**，不是 worker→OSA 的持久入站报告。 | **需要窄适配/缺口**：本地 outbox 解决 OSA 或 Orca 不可用时 CLI 成功持久入队；若目标仅 OSA 停机且 Orca 持久 inbox 可用，可在隔离实验确认认证、顺序及提交后 ack 后用 inbox 替代本地 SQLite，减少一套存储。不能宣称原生一定覆盖双服务同时停机或 worker 尚未完成发送崩溃。 |
| report 业务 receipt | 原生 receipt/worker_done 的事务位于 Orca；`src/app.ts:64-67` 与 `src/store.ts:31-45` 是 OSA 的领域事务。 | **确有缺口**：固定 reportId、payload hash、主体确认和领域结果同事务。不可因原生投递成功免除此层。 |
| 独立汇报 outbox | OSA `App` 已实现 `Outbox.send/status/withdraw`；DSH `Replies` 已生成固定 ID。 | **优先扩展/复用**现有出站 outbox，不另建第二条每任务报告投递表；补进度、排序和可见送达证据。外部显示恰好一次不可凭本地事务保证。 |
| 九态接续义务 | DSH `ticketStage`、attention、assignment、report、delivery 与 OSA jobs/notice/plan 已表达大部分状态。 | **应删除重复权威设计**：stage/running/closed/waiting-owner 从核心和现有记录派生，仅持久化无法派生的责任、具体等待、授权动作、版本和消费回执；用一个可审计 CAS 转移，避免两份状态不一致。 |

### 来源信任和历史重置

脱敏原始证据 `independent-review-evidence/native-history-shape.json` 的第一页返回 nextCursor 4，但有投影 item sequence 646；必须用 `window.nextCursor` 而非 item 最大 sequence。只读比对本地 bootstrap 创建记录，结果 `clientMessageId` 与首个 submission 相同；首条 `origin=client, source.kind=user, dispatchState=accepted`。对应源码 `src/main/native-chat/agent-session-wire/structured-agent-session-create.ts:206-207` 固定 client/user，`src/main/runtime/rpc/methods/structured-agent-session-send-compatibility.ts:24` 对 RPC 设置 `userSend:true`。因此不能以 role/source/origin 或仅排除已知 bootstrap 证明真人。要区分 UI 和程序还须证实 UI 到 host 的调用通道可认证：如果同 UID 可以调用同样 IPC，标签只是可靠性分类，不能称恶意进程防伪；需要更强可信边界才能声称安全认证。

`journal-cursor.ts` 对 epoch_changed、cursor_ahead、cursor_compacted 返回 reset；`journal-epoch-rollover.ts` 注释和事务直接删除 superseded epoch 行。reset 后快照可能足以恢复部分当前消息，但本次没有证明保留所有历史 submissions、编辑/撤回及顺序；v2 不得承诺无遗漏。最小先验证 Orca 是否已有持久 submission ledger/回放 API，若无则在提交入口提供带稳定 ID、provenance、保留与确认水位的事件，不另造第二个对话系统。无法追溯时必须显示 gap，而不是静默推进游标。

## DSH 上游：精确关系与职责

[固定 commit 6337fc8 的 README](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e) 和 [007 架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md) 标注为研究原型，README 明说部分研究方向尚未实现。实际 `git fetch` 固定 commit，`diff -qr vendor/dsh-core/src <pinned>/src/core` 退出 0：15 个核心文件逐字节相同；LICENSE 为原 MIT；`UPSTREAM.md` 标明核心直接复制、两份测试仅调整导入。仓库 `patches/` 是 **Orca** 配套补丁，不是 DSH vendor 修改。远端 HEAD 查询为 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`，与 6337fc8 为不同 commit，但两者 tree 均 `3efbb036e5a56183c6bf642e2e1856a1f64e7be3`，故本次源码内容相同；不能只用不同 SHA 推断代码已改变。

固定版 [000–004](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e/docs) 区分触发/授权/业务 Ticket 与 executor，明确 stop/retry、waiting、报告和 source；[003 执行](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md) 还描述持久 effect 和消息重试。已实际核对实现，不把文档目标一概视为已交付。

| 层 | 固定版 DSH 已实现 | OSA / Orca 分工与缺口 |
| --- | --- | --- |
| 领域规则 | `src/core/intake.ts` Trigger 去重与订阅 fan-out；`tickets.ts` attach、resume、retry、stop；`assignments.ts` 输入送达/读取、report、attention；`stage.ts` 投影；`replies.ts` 确认、答复、结果的 stable ID；同步 `Repositories.atomic`。 | **复用原样 vendor**，让核心保持 Ticket、Mandate、Assignment、attention、业务 report 的唯一权威。OSA 显式区分聊天回复地址与业务线程，避免所有目标 fan-out。 |
| 原型外层执行 | `src/executor/dsh.ts` 使用每 Ticket 的 DSH session/workspace、effect launch/delivery、host restart 恢复、有限 transient retry 和后台任务监督；`app/tools/executor.ts` 报告与 relay 在 Store 事务中完成。 | OSA 未复制 DSH Executor/Session，改接 Orca Executor、其任务和子资源；运行环境及重启语义不同，不能直接搬入 DSH 守护逻辑或把 DSH host restart 自动重派套在仍存活的 Orca worker 上。 |
| 原型外层消息与监督 | `app/effects.ts` 持久 effect、generation 防止旧执行删新工作、重试与健康；`app/outbox.ts` 回执及同 ticket/conversation 顺序；`app/delivery.ts` 持久 session 去重、`dsh-superagent` 来源标记；`app/notices.ts`/`passes.ts` 将通知与定时驱动接起来；`sources/` GitHub/Feishu 适配。 | OSA 自行实现 SQLite records、jobs、GitHub/飞书和 RouterWake：是**重新适配/移植核心**，不是完整上游 app fork。值得借鉴 effect generation、防旧结果覆盖、来源区分和按目标排序，但不需复制全套 DSH 依赖/队列；原型 outbox 是出站，不直接解决离线 OSA CLI 入站报告。 |
| 上游未保证的本需求 | DSH 模型可判断但不保证自然语言全正确；固定版没有 OSA 的 Orca dispatch 凭据跨 retry fence、原生聊天来源可靠授权、跨服务 report 双库 receipt、具体多目标持续接续和当前 Orca 资源对账。 | OSA 必须负责可信来源映射、输入修订、业务接受回执、授权续派与状态投影；Orca 负责真实执行、资源、通信与操作事实，绝不将两者复制成竞争调度器。 |

上游 `app/delivery.ts` 已使用 producer-specific source 来区分自己发送给 DSH Session 的消息，这是值得复用的设计原则；它不是当前 Orca history 的可信来源，也不是当前 OSA 已移植功能。上游 [007](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md) 提及 `inputsRead` 在 Session 接受步骤上的具体语义，OSA 当前是 Executor 显式 ack，不应把二者当同一种证据。

## 严重度排序与最小修订

1. **P0：输入 provenance 与可恢复性契约。** 无来源可信边界会把程序输入当授权；只有可重置 history 游标会漏掉离线期间已消失事件。优先证明现有提交存储与 UI 信任通道；否则改 Orca 的提交事件留存/认证并有 gap 标识。旧消息标 unknown。
2. **P0：恢复 fence 与外部动作。** A1/A2 修旧 start 覆盖，全部异步 binding 写入使用预期身份；在退役与子资源确认前不开始 successor。明确是否能利用原生身份保留 retry；否则跨 Task 持久熔断/权限/资源和副作用对账。review/pr 异步在提交前重校验；已发生外部写保留 unknown 并对账。
3. **P0：报告事务边界。** 短暂停服无丢报告可实现，但必须先有成功入队和 receipt；考虑 Orca inbox 满足单服务故障时可替代本地队列，双服务不可用或没有原生接收时仍需本地持久。共享 report 处理、异步 review 后最终 CAS、按 assignment 顺序、拒绝及旧主体确认。排队不等于领域接受。
4. **P1：消除双重业务状态机。** 明确从 Ticket/report/attention、assignment 和 Orca 操作派生哪些状态；持久只增“尚缺的责任/等待/可执行授权动作 + revision + 完成证据”。原子写 successor 与消费标记、暂停优先、重启恢复。自由文本禁止自行触发发布等外部操作。
5. **P1：对外结果与当前事实。** 复用既有 outbox，逐任务生成消息，记录接收/显示局限；状态以当前身份和观测时间投影，孤立未知与过期。固定每项依赖、共享资源及容量；不要将集成发布偏好扩成任务之间依赖。

## T1–T12：设计可行性与实现证据分列

| 场景 | 设计判断 | 当前实现/验证 |
| --- | --- | --- |
| T1 初始未知→恢复→tick→重启 | **可行**：A1/A2 前驱 CAS + 操作回执；若采用新 assignment，验收应断言旧 binding 不污染最新 assignment，而不强制同 Task 的 dispatch-2。 | 上轮 fake Orca 的局部 patch 对旧路径改前失败、改后重启通过；正式未实现。 |
| T2 旧 recovery 晚到 | **可行**：事务重读预期前驱，不匹配存对账而非覆盖。 | 当前 recover 写异步前快照；未注入。 |
| T3 旧 attempt 写 report/ack | **有条件**：新 assignment/token 可 fence 普通旧凭据；需要旧资源退出及所有异步操作审计；同 UID 恶意窃取不在可靠性保证内。 | 本轮新 assignment App 测试通过；真实 review/pr、native retry、旧 lane 未验。 |
| T4 停机 report 后退出 | **可行，限定成功入队**：独立本地 queue 或可证明适用的 Orca inbox。 | CLI 现无本地持久化；跨进程未验。 |
| T5 接受后响应断线 | **可行**：业务 receipt 与变更同事务、重放返回原结果；主体先验证。 | 未实现/未验；原生操作回执不能替代。 |
| T6 两个 ready 并发、scope 变更 | **可行**：共同 review、receipt 先查及最终事务 revision/assignment/序号复查。 | `ReviewGate.guard` 已存在，整个并发与业务 receipt 未验。 |
| T7 报告乱序/拒绝 | **有条件**：定义 durable 序号、gap、拒绝终态与过期处理；不可为了让后项通过而丢掉尚未处理的有效输入。 | 未实现/未验。 |
| T8 多条输入、重启 | **有条件**：可靠提交事件保留+可信来源+事务游标；当前 v2 未规定 reset 丢历史时如何保证。 | 有实际 history 分页 shape，尚无采集；未验崩溃与全量找回。 |
| T9 bootstrap/wake/草稿混合 | **有条件**：Orca 可信提交来源与身份边界需实现并验证。 | 真实 bootstrap 是 client/user，已证单凭字段不安全；未作写入 canary。 |
| T10 A 等人、B/C 独立 | **可行**：按真实依赖、资源及任务级 outbox 独立调度；共享容量不足可解释等待。 | 有 assignment 并发，完整服务/Router/结果投递未验。 |
| T11 诊断后修改范围/暂停 | **有条件**：持久可消费授权决策、revision 和 stop 优先；自由文本不自动执行。 | scope/输入记录与 handoff 部分存在；状态转移及外部操作竞态未验。 |
| T12 活着无进展/报告缺失/Router 离线 | **可行**：分离原生观察、业务报告、待交和责任，过期 unknown，离线责任可见。 | 有部分原生观察和通知；完整投影及故障组合未验。 |

## 实际验证和限制

1. 上游：`git clone https://github.com/deepseek-ai/dsh-superagent-prototype.git /tmp/dsh-upstream-review-v2`；`git fetch origin 6337fc823ce20251c8de8085948165c81aaa701e`；`git archive ... | tar -x -C /tmp/dsh-pinned-review-v2`；`diff -qr vendor/dsh-core/src /tmp/dsh-pinned-review-v2/src/core` → 退出 0，无差异，日志 `.osa/architecture-fix-20261103/review-v2-evidence/vendor-diff.log`。两个 commit 的 tree ID 相同；`git ls-remote ... HEAD` 返回 8c32a9d。
2. Orca：`orca --version` → 1.4.227；只读 build metadata commit 与源码 `git rev-parse HEAD` 均为 7c19f712；工作树非干净。版本匹配技能由安装 CLI 读取；源码引用的修改状态已核查。未启动/重启 Orca、未对业务 runtime 发写请求。
3. 在 `/tmp/osa-review-v2-7AuRZi` 复制仓库（排除 `.osa`、`.git`、`node_modules`；只读链接依赖），复制新增 `capability-fence.test.ts.txt` 为测试，`npm test -- tests/capability-fence.test.ts` → **1 test passed**，再次运行归档日志与测试至 `.osa/architecture-fix-20261103/review-v2-evidence/`。使用 fake Orca/临时 SQLite 和临时 Git，未改源码，无本轮补丁。测试并不启动新原生 worker，也不验证 socket review/pr、真实 stop、熔断、敌对同 UID 或 report outbox。
4. 只读比较 bootstrap 创建记录与脱敏 shape，输出匹配 True；第一页 nextCursor=4 而最大投影 sequence=646。未记录消息正文或新复制业务数据库；原有脱敏证据在 `independent-review-evidence/`。

建议顺序：先定义来源/保留契约并做无副作用原生 canary，同时实现隔离环境 A 的前驱 fence/退役验证；然后选定可复用的报告运输并实现领域 receipt，做崩溃进程测试；再以核心状态派生加最小责任记录完成 D 和独立汇报。最后在临时 state 跑 T1–T12 的组合与迁移，再讨论集成发布。**本轮未验证完整需求、原生跨重启 canary、网络通道到达、或真实业务任务；这些仍是交付前门槛。**
