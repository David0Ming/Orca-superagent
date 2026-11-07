# 2026-11-04 宪章三项待办交付记录

按根目录 AGENTS.md 末尾顺序完成本地源码修改。没有恢复已回退的可靠性实施线，没有修改 Orca、patches 或 vendor/dsh-core；没有读写 .osa/p4-live 数据库、变更或重启业务服务，没有推送远端。

## 1. 初次启动作业不得覆盖恢复后的绑定

`launch` 发现当前派工已有完成的 recovery 时，终结旧 start job，不再应用初次启动的缓存回执。

在 `tests/orca.test.ts` 新增复现：初次启动返回 outcome_unknown，确认旧执行停止后恢复到 dispatch-2，再 tick。修复前实际退回 dispatch-1；修复后保持 dispatch-2。测试还重建旧版本遗留的未完成 start job，重开数据库和 Executor 后再次检查，绑定与 execution 均保持新 Dispatch，未多建 worker。

第一项完成时 Orca 适配层 71 项测试通过。未修正已有业务数据库中的历史分叉。

## 2. OSA 中断时通过原生信箱交报告

新派发提示提供 `report --report-to run:ID --terminal WORKER_HANDLE --cli ORCA_CLI`。客户端直接使用 Orca 原有 send，OSA socket 不可用时仍可交给 Orca；`queued: true, accepted: false` 只确认运输接收。精确重试同一报告使用稳定 `--id`。发送失败显式报错，错误文本不输出包含能力令牌的完整 argv。

OSA 从已有 Run inbox 消费报告，核对 Run、发送者和当前工单/派工，使用与 socket 共用的业务接受路径及原有 ready 审查校验。业务变更与 report-receipt 在同一 Store 事务提交后，才确认原生 delivery。相同 ID/内容重放返回已存结果，ID 内容冲突报错。消费失败保留消息并生成 poll 通知。状态接口返回接受回执，保留原报告内容。

验证：

- App 测试验证事务回滚时业务结果和回执均不留下，重复接受只产生一条结果消息，同 ID 不同内容拒绝。
- Orca 适配测试验证提交前、提交后确认前、确认后重开可恢复，以及不同发送者的报告不被确认。
- `tests/report.test.ts` 在 OSA 不运行、无 socket 时，通过实际 CLI 子进程发送报告；消费进程分别在领域提交前、提交后确认前、确认后三处真实 SIGKILL，再用新 Node 进程重开。三个场景最终均只有一个回执、一条结果出站消息，信箱为空；确认时检查数据库已有回执。
- 进程实验的 Orca 信箱由持久测试 CLI 模拟，不是安装版 Orca 的真实联调。原生信箱能力依据仍是 architecture-native-experiments-20261103.md 第 3 节；该历史文档的其他实施建议未恢复。

第二项完成时相关 4 个测试文件共 96 项通过，类型检查通过。没有实现 Orca 也不可用时的第二套本地队列；没有自动改写已运行 Executor 的旧提示。旧的无 report-to 命令继续使用 socket。

## 3. Router 只澄清结果与定位、路由、忠实转达

重写 super-agent-router skill，删除 Router 制定技术步骤、依赖和门禁的职责。Executor 提示明确双方平级、技术规划与调试归 Executor，以及前提不成立时停下说明证据和可能归属。

`route accept` 直接采用所有者原始 trigger.text；`route attach` 按顺序追加所有者补充原文与来源，仍保存 scope-revision。兼容旧调用中的 scope/note 参数，但不让它们重写范围或添加执行指令。初次派工提示不再插入可被 Router 改写的 execution.assignment。现有技术能力、审查和发布校验保持原流程；Router skill 不再要求它自行制定额外执行路线。

测试验证 Router 传入的改写 scope/note 不进入派工，原文、补充及幂等重放保留；无 scope 参数也能接单；生成的提示包含定位、平级职责和前提失败规则；后续进展覆盖当前报告后，status.reportReceipts 仍能取回原始拒绝。

## 集成验证与生效边界

- `npm test`：18 个文件、361 项通过（110.50 秒）。
- 全量启动后补充了报告发送失败时隐藏 argv 的处理，并单独重跑 `tests/report.test.ts`，3 项通过。
- 随后新增拒绝原文留存断言，重跑 `tests/app.test.ts`，18 项通过。
- 最终 `npm run typecheck` 通过。

变更尚未部署。没有迁移旧工单范围、修复业务库历史数据或给运行中 Executor 注入新提示；现有业务服务继续运行旧进程中的代码。未做安装版 Orca 的真实收发联调，也未声称用户界面恰好显示一次或 Orca 不可用时仍能排队。语义上忠实转达拒绝还依赖 Router 遵循 skill；程序保存的原文可供核查。

## 部署前检查：因未结算业务执行而停止（2026-11-04 12:14，新加坡时间）

所有者已授权部署当前源码到 `.osa/p4-live` 并进行安装版 Orca 的真实报告联调，同时要求先确认重启不会损害执行中的业务任务，若有则先停下回报。本次停在这一前提检查，未部署、未重启或停止任何业务服务，未执行报告联调，也未推送。

已读取当前源码并确认保留所有者审查后的三处改动：信箱拒绝报告不再永久挡住后续消息（外来/旧执行者报告直接拒绝通知，其他接受失败在第 3 次后拒绝通知）；报告先直连 OSA，仅 ENOENT/ECONNREFUSED 回退 Orca 信箱；派发提示保留 `Target: 任务标题`。没有修改这些源码。所有者报告的 362 项测试和类型检查通过属于本次接手时已有结果，本次未重跑。

只读查询业务库发现 34 张工单中有 6 张业务未结束，其中 2 个 binding 尚未 finished；其余 4 张开放工单的 binding 已结束，不能仅凭工单 state=running 判为活跃执行。未完成的两个 binding 为：

| 业务任务 | Ticket | 当前 Dispatch | 原生观察 |
| --- | --- | --- | --- |
| 恢复日报常态运行：部署兼容镜像并重新启用定时器 | `0f89af6d522352cf1657e83df0f90bf1` | `ctx_4ab0c1b84fd0` | `dispatched` / `ready`；精确 worker 观察为 `live`；资源 owned，未申请释放 |
| 按所有者裁决收敛旧分支 | `2ba355337f766de4edd1e407a6001ba6` | `ctx_36322ff205d1` | `dispatched` / `ready`；精确 worker 观察为 `live`；资源 owned，未申请释放 |

使用安装版 `/Applications/Orca.app/Contents/Resources/bin/orca` 的真实 `worker-show` 与 `worker-list --include-remote --full` 核对了上述 Task/Dispatch/Run。两次 worker-show 的 `observation` 均为 `{status: live, exactWorker: true}`，terminal connected，terminalResource.releaseState=not_requested。projection.liveness 同时为 stale_status/unverifiable；这既不能证明它们已经退出，也不能把终端存活说成当前轮正在处理任务。屏幕摘要显示两者停在输入提示处，但均没有原生完成结算，不能据此宣称可以安全停服。

这些执行者由旧服务派发，无法证明它们已经采用新报告回退路径。此时停 OSA 进行离线联调，仍可能遇到旧执行者在停机窗口提交 socket 报告而失败的已知路径。因此没有建立“重启不会影响当前业务执行”的前提，按所有者要求停止；未擅自取消、恢复、通知或接管这两张业务工单，也未改业务库中的状态。

证据保存在 `.osa/deployment-check-20261104/`：`preflight.json` 含检查时间、源文件 SHA256 和停止决定；`ctx_4ab0c1b84fd0.json`、`ctx_36322ff205d1.json` 是两份安装版 Orca 原始 worker-show 响应，采集时间约 04:14:31 UTC（12:14:31 新加坡时间）。业务库使用 DatabaseSync 的 readOnly 模式查询，未创建 Router lease。后续仍须在安全条件成立后部署，并实证在线直连接受、停机入信箱、恢复后只接受一次；本次没有把这些未执行项目记为通过。

## 已部署及安装版真实报告联调（2026-11-04 12:18–12:27，新加坡时间）

所有者随后确认两个终端已经空闲、不会在无人推动时提交报告，明确授权继续重启，并要求回读两张业务工单、如实记录服务行为，本次不处理它们的业务问题。本节是后续执行结果；前节的“未部署”只描述当时停止的状态。

### 部署与保留修改

通过现有 LaunchAgent `com.orca-super-agent.osa` 和原有 supervisor 配置，优雅停止并重新启动 `.osa/p4-live`，没有更换启动参数或安装新的托管机制。服务直接从本仓库 `bin/osa.ts` 加载 TypeScript，无需额外构建或复制产物。

所有者审查后的三处修改全部保留：拒绝报告的有限重试与通知、在线直连而仅连接失败时回退信箱、派发中的 Target 标题。本次没有修改应用源码，部署前后 src/bin/scripts/skills 和 package 文件的 SHA256 全部一致。重启前保存了 SQLite 一致性备份 `live-integration/before-state.db`（私有目录及权限），未恢复或覆盖业务数据。

实际发生三次优雅重启：首次加载源码；第一次离线试验因测试调用被 Orca 拒绝后恢复服务；第二次离线试验成功后恢复服务。服务日志记录旧进程退出码 0。最终 supervisor PID `34231`、业务子进程 PID `34285`，服务 startedAt=`2026-11-04T04:22:38.525Z`，服务和 supervisor 均为 running。进程命令确认运行的是本仓库 `bin/osa.ts serve --state .../.osa/p4-live`。

部署前重新执行 `npm run typecheck` 和 `npm test -- tests/report.test.ts`，类型检查及 3 项测试通过；没有改源码，因此未重复所有者已经完成的全量 362 项回归。

### 真实收发与去重结果

使用安装版 `/Applications/Orca.app/Contents/Resources/bin/orca` **1.4.247**，不是旧实验的 1.4.227，也不是测试替身。联调在实际 `.osa/p4-live` 服务中使用一张独立测试工单。原生 Run=`run_b91dbf1a7e9e`、Task=`task_92b5b401fc37`、Dispatch=`ctx_61773252c9d7`；发送者和协调者是本次创建的两个 `/bin/cat` 终端，Task 通过原生 dispatch 绑定、不注入指令。测试驱动通过真实 OSA CLI/socket、安装版 Orca CLI/信箱和业务库完成收发，没有启动额外模型或操作两张业务工单。

| 场景 | 实际证据 | 结果 |
| --- | --- | --- |
| OSA 在线直连 | `04:20:59.787Z` 接受 `osa-live-online-20261104`，CLI 返回工单报告而非 queued；数据库对应回执数 1 | 通过 |
| OSA 停机时投递 | `reportId=91175bd3-2696-40b1-a738-88916653ca00`，CLI 返回 `queued:true, accepted:false`，原生 message=`msg_d4e43d546cf3`；停机期间原生 peek 看见未读消息 | 通过 |
| 恢复后接受并去重 | 停机期间另发一条不同 message=`msg_d086f1b4f578`，内容为完全相同的领域请求；恢复后两条原生消息均被 OSA 处理，业务回执只有 1 个，接受时间 `04:22:39.784Z`，原生未读变为 0 | 通过 |
| 延迟再次重放 | `04:23:39Z` 第三条原生 message=`msg_87913757e7ba` 仍携带相同请求；OSA 处理后回执数仍为 1，整个回执对象和 handoff 对象均与首次接受时相等，时间未刷新 | 通过，证明未再次应用领域报告 |

测试使用 `report progress` 验证报告传输、业务接受与去重，没有伪造独立审查来提交 ready，也没有宣称通过了两张业务任务的验收。测试结束后，仅测试工单以“联调完成”原因关闭；原生 worker_done 成功结算测试 Task，OSA 完成 binding 收尾，两个测试终端均关闭。保留测试工单、回执和原生历史作为证据。

联调中实际遇到并消化的技术问题：

- 最初测试驱动继承当前聊天的 Orca session 身份，原生 CLI 拒绝从另一测试终端发送，明确未发请求。随后使用独立驱动环境，清除继承的 ORCA_*；没有改生产报告客户端的身份处理。
- 安装版要求 `--retry-request` 是 UUID。首次自定文字 report ID 在回退发送时被拒绝、未入信箱；改用稳定 UUID 后通过。当前 CLI 默认生成 UUID；手工提供的 `report --id` 若需支持信箱回退，也应使用 UUID。未把这一限制隐藏成成功。
- 成功发送及两条未读证据采集后，一次停机期间的 Python SQLite 只读查询报 `unable to open database file`，因此没有记录“停机时库内回执数为 0”的实测断言；已恢复服务，并通过绝对路径回读实际回执及消息处理记录。静态备份按 immutable 只读方式检查。停机入信箱的证据来自当时的服务 stopped 状态、queued 回执和原生未读 peek，不依赖失败的查询。
- 1.4.247 的 consuming check 契约为取回即标记 handled；本次通过 peek 检查未读，没有抢先消费服务的消息。这里实证的是停机入信箱、恢复接受和领域去重；没有对这个新版本重新注入“取消息后立即崩溃”的故障，也不把旧版本实验的原生 ack 时序结论直接套到新版本。

### 两张业务工单前后对照与服务实际行为

部署前 `before.json`、首次重启后 `after-deploy.json`、离线恢复后 `after-offline-recovery.json`、收尾后 `final.json` 均保留完整两张工单及相关记录。比较结果为：**两张 core.ticket 完全相等**，包括 mandate、assignment、已有报告、inputs、undelivered、updatedAt；当前 Dispatch 仍分别为 `ctx_4ab0c1b84fd0`、`ctx_36322ff205d1`。原生 worker-show 仍为 dispatched/ready、精确 worker live，没有新 Dispatch、没有自动恢复、没有取消或业务推进。没有向两个业务终端发送输入或报告。

服务实际改变的是观察和提示：

- 刷新两张 execution/execution-attempt 的 observedAt，以及 binding 的 nextPollAt/nextObservationAt；没有改变绑定身份或业务状态。
- 两条已有 supervision 提示从 `Executor observation unavailable ... Observation does not match Executor` 更新为 `Executor requires inspection: ready, liveness unverifiable. Timeout is not proof of exit...`。这是现有观察逻辑产出的提示，不是恢复任务。
- 两条原有 poll 通知中的 `Orca runtime_unavailable ... Could not read Orca runtime metadata ...` 文本仍保留，与部署前相同。它们是该任务通道保存的错误，不能据此声称此刻安装版 Orca 停止：本轮真实 CLI 和新测试 Run 收发已成功。本次没有清除错误回执或修复这些业务通道。
- RouterWake 继续尝试检查原有发送终端 `term_58fd0e3b-2e2d-48d6-aec6-5f2737e5fc96`，terminal show 失败，health 仍 unavailable；现有 wake 只刷新错误/重试时间，没有新成功通知回执。监督提示保存在 OSA 库内，不宣称已成功唤醒 Router 或被所有者阅读。没有重绑 Router、抢 lease 或推动两张业务工单。

日报待部署、分支收敛被隔离及其 consumer_fenced 背景均未处理，保持本次范围之外。

### 证据入口

全部证据位于 `.osa/deployment-check-20261104/live-integration/`：

- `comparison.json`：完整业务工单相等、观察字段变化、无新恢复、源码哈希一致、最终服务 running。
- `online-evidence.json`、`online-result.json`：在线直连接受。
- `offline-queued.json`、`offline-native-unread.json`、`offline-native-after.json`、`offline-after-restart.json`：真实停机入信箱及恢复处理。公开查看的信箱正文证据已遮盖测试 token。
- `delayed-replay-evidence.json`：一分钟后再次重放，整个领域回执与 handoff 不变。
- `before.json`、`after-deploy.json`、`after-offline-recovery.json`、`final.json` 及各阶段原生 worker-show JSON：两张业务工单前后证据。
- `router-observation-changes.json`：Router health/wake 的实际变化。
- `final-service.json`、`final-supervisor.json`、`final-process.txt`、`deployment-service-log.txt`：部署进程和日志。
- `canary-completion.json`、`canary-cleanup.json`：测试 Task 结算及资源收尾。

本次未改 Orca、vendor/dsh-core 或应用源码，未推送远端。业务服务已运行当前源码；并非旧执行者的既有提示也被自动更新。
