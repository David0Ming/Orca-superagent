# Orca Super-agent

产品文档 000–008 已按原版 dsh 逐章写齐，见 [完整目录与状态说明](docs/OSA-CORE.md)。新增 [007 架构](docs/007-architecture.md) 和 [008 实践指南](docs/008-cookbook.md)。文档完成不代表实现或验收完成；下文原有版本的实现说明不能替代新版约定。

本机 Router / GitHub / 飞书 → SQLite 工单 → Orca Codex Executor → 独立 Claude 审查 → PR 与持久回复。上游核心保留在 `vendor/dsh-core`，没有修改源码。

当前处于 **P4 第一版可用、发布前收尾**：P0–P3 已验收，P4 多项目管理与双入口已有本地联合验收；还不是一键安装的正式发行版。Router 已切换为 Claude Code；独立管理目录迁移、免费助手自动调度、临时工作树定时自动回收尚未启用（现提供显式审查与安全删除接口），P5 多机常驻/接管尚未开始。阶段证据见 `docs/p4/VERIFICATION.md`。

配套 Orca 的“允许智能体关闭人工操作过的任务窗口”可选开关已实现，配套修改版默认开启，见 [补丁、验证与安装边界](patches/README.md)。当前运行的已安装 Orca 尚未替换；本项目的 `npm install` 不会自动改写应用包。

要求 Node 22.13+、运行中的 Orca，以及已注册的 Git 仓库。Orca 设置里的嵌套深度维持 ≥ 2。GitHub 模式还需要已登录本人的 `gh`。

```sh
npm install --legacy-peer-deps
npm test
npm run typecheck
npm run osa -- --state /absolute/path/osa-state serve --repository /absolute/path/repository
```

另一个 Agent 窗口加载 `skills/super-agent-router/SKILL.md`。例如：

```sh
npm run osa -- --state /absolute/path/osa-state router attach
# 将返回的 token 作为下面的 TOKEN
npm run osa -- --state /absolute/path/osa-state intake --lease TOKEN --id request-001 --text '创建 hello.txt，内容为 hello' --thread demo
npm run osa -- --state /absolute/path/osa-state router wait --lease TOKEN
npm run osa -- --state /absolute/path/osa-state route accept --lease TOKEN --trigger request-001 --title 'Hello 文件' --name hello-file
npm run osa -- --state /absolute/path/osa-state router wait --lease TOKEN
npm run osa -- --state /absolute/path/osa-state router ack --lease TOKEN --message MESSAGE_ID
```

`router wait` 默认等待最多 30 秒，轮询时续租；租约闲置 60 秒后可被新窗口接手。只要未被其他窗口实际接替，原 token 的下一条命令会自动续租，不因思考或等待用户超过一分钟而拒绝登记/派工；实际接替后旧 token 永久失效，不允许自动抢回。输入 ID 由调用方提供，同一消息重试复用原 ID。服务状态目录仅当前系统用户可访问，Unix socket 不监听网络；Router 的本人身份来自当前系统账号，GitHub 和飞书分别绑定已验证的账号。

Executor 使用 `read`、`acknowledge`、`ack`、`report ready|blocked|failed|dropped|progress`、`thread follow|unrelated`、`handback`，每次必须带工单、当前派工和能力令牌。`ack` 是 Executor 明确的已读确认，运输层送达不等于已读。正常结果报告后，仍须按 Orca preamble 发出 `worker_done`，服务校验后先 release 再 ack。

新派发的报告命令通过 `--report-to run:ID --terminal WORKER_HANDLE --cli ORCA_CLI` 投递 Orca 原有信箱，OSA 停机期间也可投递；`queued: true, accepted: false` 仅表示 Orca 已接收。重复发送同一报告使用相同 `--id`。OSA 恢复后沿用 socket 报告的业务/审查校验，在同一 SQLite 事务保存业务结果与 `report-receipt`，再确认信箱 delivery。校验失败会保留未确认消息并显示 poll 通知，不能把入信箱当成业务成功。未带 `--report-to` 的旧命令仍使用 socket；已运行的执行者不会自动获得新提示。此路径不保证 Orca 本身不可用时仍可投递。

停止服务可用 Ctrl-C；也可以杀掉进程后用完全相同的 state 和 repository 重新启动。服务接管已有 Run，不以服务重启作为重新派工的理由。不确定的外部调用保留记录并显示通知，不能盲目重试。工单 worktree 和分支保留供检查，不自动提交、合并或发布。

回复按固定 ID 只入库一次；未确认消息会重放，Router 应按 ID 去重后确认。任意外部聊天窗口的显示和数据库确认无法构成原子事务，因此这里只保证持久消息不重复创建，不承诺崩溃瞬间的视觉显示恰好一次。

## P2 GitHub 与独立审查

```sh
npm run osa -- --state /absolute/path/osa-github serve --repository /absolute/path/repository --github OWNER/REPO
```

`--github` 自动启用两层执行；本地 Router 单独验证可使用 `--two-layer true`。未启用 GitHub、飞书或 `--two-layer true` 时保留 P1 单层模式。服务从 `gh api user` 获取本人数字账号 ID，并将身份和仓库绑定到状态目录；重启不允许悄悄切换账号、仓库或关闭审查。

来源只接收激活后的本人 Issue 和评论，初次启动不会批量派发历史 Issue。每 15 秒轮询所选仓库；PR 普通评论、行内评论与 review 无需再次 @。他人消息不能发起工作，CI 仅作为已有工单上下文。自己的发件箱回复带消息标记，避免重新当作本人请求。

Router 接受需要发布 PR 的目标时，在 `route accept` 上加 `--publish true`，授权原文中须写清允许提交和发布的范围。未授权的工单不能通过发布命令推送。Executor 先提交获准的改动，再派同工作区的 Claude 子 worker 独立审查；服务验证派工归属、真实完成记录和当前文件/输入版本。最多两轮审查，仍未通过则回报 blocked。

Executor 使用 `osa review snapshot` 和 `osa review record --dispatch ID` 记录审查，通过后用 `osa pr publish --title TITLE --body BODY` 推送当前已审查提交并创建或找到同一分支的 PR。这些命令都需携带当前工单、派工与令牌。程序负责发布和回复；Executor 不直接发 GitHub 评论。发布不合并 PR，不部署，不强推。

PR 在合并/关闭前保持订阅。原 Executor 已完成回收后收到后续评论，会在同工单、同分支和同工作区创建下一次派工；服务单纯重启不会重新派工。审查不支持子模块，超大 Git 输出会明确失败。

macOS 的 `/tmp` 是路径别名，注册 Orca 项目时应使用真实路径（如 `/private/tmp/...`）。服务会将仓库路径规范化；`repo add` 后仍须确认 `orca worktree list` 能列出该工作区。用户已有的信箱看门狗保持独立；osa 使用下述 macOS 系统托管。

## P3 飞书与工单监督

```sh
npm run osa -- --state /absolute/path/osa-feishu serve --repository /absolute/path/repository --feishu-chat oc_CHAT_ID
```

先用 `lark-cli auth status --json --verify` 验证本人和机器人身份，机器人需在所选群内并具备读消息、发消息权限。`--feishu-chat` 只接收该群中本人的文字与富文本消息，自动启用独立审查；账号、应用、机器人和群绑定状态目录，重启不得静默替换。程序以机器人身份回原话题，Router 不代发。附件不自动下载。

来源每 15 秒轮询，失败保留进度；网络轮询不会阻塞 Orca 收件确认。回复附固定消息标记，重试前核对原话题；若发送结果不明、超过 55 分钟仍找不到标记，保留待发送并要求检查，不盲目重发。为发现旧话题里的新回复，当前每轮扫描所选群和话题的完整历史，面向个人规模；暂未实现大群索引或归档。

`status --lease TOKEN` 包含当前执行和各次 Dispatch 的模型、结果及存活观察。默认执行超过 30 分钟会出现核查通知；测试可用 `--stall-ms` 缩短阈值（至少 1000 毫秒）。该阈值是提醒，不是强制执行期限，正常长任务也可能收到提醒。失联、静默、空输出均不等于退出。

`status.executionBindings[].holdsExecutorSlot` 明确该派工是否仍占 Executor 名额，与调度器的 `!finished` 规则一致。领域工单可以保持未结、报告 `blocked`，但执行资源已释放；不要仅凭领域 assignment 的 `running` 判断占槽，更不要为了释放已经空出的名额而取消业务工单。原生 `retained` 也不等于窗口已删除。

确认原执行失败或停止，且子 worker 资源已处理后，Router 可执行 `route retry --ticket ID --lease TOKEN`。程序复用原 Task 的 `--retry-of`，保留工作区、追加恢复上下文，并限制同一派工最多两次恢复；不绕过 Orca 自身熔断。单纯重启服务只恢复记录和观察，不自动重跑工作。用户明确指定模型时，可用 `--executor-model MODEL_ID` 覆盖本服务的 Codex 派工；默认继承 Orca 设置，不改全局配置。

现有 `~/.orca/watchdog/orca-mailbox-watchdog.sh` 负责未读报告、未上报和残留信箱提醒，不托管 osa、不重启 worker。P3 不修改该看门狗。

## P4 通用多项目管理

一个服务保存所有业务项目、组件、执行位置与任务。名称和目录都是登记数据，支持任意项目；一个项目可以包含多个仓库。旧状态第一次启动前自动生成 `before-p4-*.db` SQLite 快照，再映射为 `legacy` 项目，保留原工单、Run、游标、回执与令牌。运行中的旧任务因目标加入审查指纹，可能需要重新审查；不会沿用已经不匹配的批准。

```sh
node scripts/osa-service.mjs start --state /absolute/state --repository /absolute/service-home --two-layer true --executor-model gpt-6.1-sol --max-executors 2
node scripts/osa-service.mjs status --state /absolute/state
node scripts/osa-service.mjs stop --state /absolute/state
```

上述启动器是手动模式，不修改启动项。需要随 Orca 启停时，准备配置文件（所有路径必须为绝对路径，`serveArgs` 沿用手动启动参数，不含 `--state`）：

```json
{
  "state": "/absolute/state",
  "runtimeFile": "/Users/you/Library/Application Support/orca/orca-runtime.json",
  "orcaExecutable": "/Applications/Orca.app/Contents/MacOS/Orca",
  "serveArgs": ["--repository", "/absolute/service-home", "--two-layer", "true", "--executor-model", "gpt-6.1-sol", "--max-executors", "2"]
}
```

执行 `node scripts/osa-supervisor.mjs install --config /absolute/config.json`，安装本用户的 `com.orca-super-agent.osa` LaunchAgent；每个用户只装一份。安装时记录 Node、脚本绝对路径和 PATH，移动项目或升级后移除旧 Node 路径时须重新安装。配置勿存凭据。系统托管进程每 5 秒核对 Orca PID、可执行文件和启动时间，Orca 运行时启动 osa、退出时安全停止 osa；轻量监测进程留在登录会话中等待 Orca 再启动。退出不关闭业务窗口、不自动重跑失败工单。已有服务和孤儿子进程仍按精确身份处理，避免重复实例。

异常重启按 15/30/60/120/240/300 秒退避，连续正常运行 60 秒后重置。状态盘可用空间低于 512 MiB 时暂停 osa，空间恢复后自动尝试启动；这只能降低磁盘满风险，不能保证突发耗尽时所有写入成功。监督状态与日志在状态目录的 `supervisor.json`、`supervisor.log` 和 `supervisor.err.log`，服务日志仍为 `service.log`。

托管期间手动 `osa-service stop` 会被视为服务退出并重新拉起。需要持续停止时，执行 `node scripts/osa-supervisor.mjs uninstall --config /absolute/config.json`，卸载托管并停止 osa，保留数据库和日志。恢复使用原配置执行 install。Orca 重启后 Router 身份变化仍须重新绑定，见 [运行手册](docs/p4/RUNBOOK.md)。主机休眠、关机或用户未登录时不保证接单；跨机器常驻与自动接管仍属 P5。

以下命令都通过 `npm run osa -- --state /absolute/state ... --lease TOKEN` 调用：

```text
project sync
project discovery
project add --id product-a --name 产品A
component add --id api-a --project product-a --name API
location add --id laptop-api-a --component api-a --name MacBook --host local --repository /absolute/repo --repo-id ORCA_REPO_ID --base-branch main
project list
status --project product-a
project update --id product-a --name 新名称
project pause --id product-a
project resume --id product-a
project archive --id product-a
router bind --terminal EXACT_ORCA_HANDLE
router status
```

`project sync` 只发现 Orca 项目、仓库和 worktree，不自动授权执行；快照带观察时间、截断标志和主机覆盖范围。组件、位置也支持 `add|update|list|show|archive`。`show` 使用 `--id`；登记、位置选择和 `status --project` 支持稳定 ID，执行目标歧义时拒绝派工。远程位置可以登记，当前直接派工只接受本机 Git 仓库；普通文件夹和远程代码独立审查尚未实现。仓库必须有可用基线提交才能创建隔离 worktree。

接单加 `--project ID --component ID --location ID`（唯一候选可省略后两项），目标在接单时冻结。`--priority N`、`--resources db,deploy-target`、`--depends-on TICKET,TICKET`、`--goal ID` 可随接单指定；`task plan --ticket ID` 可修改尚未启动任务的计划，运行后仅允许改优先级。负优先级写作 `--priority=-10`。默认两个 Executor 并行，按项目轮转、项目内优先级及等待时间调度；共享资源冲突和未成功的依赖会明确阻塞。暂停只阻止后续启动，不中止现有工作。子 worker 和 reviewer 仍占用额外进程资源，Executor 数量不是模型进程总数。

跨组件需求先 `goal add --id G --name 目标 --projects P1,P2`，将子工单关联 `--goal G`，再创建有明确依赖的独立联合验收任务，通过 `goal update --id G --acceptance-ticket T` 关联。`goal show --id G` 只有在子任务和联合验收均有成功结算、所需审查证据时才显示 `accepted`。

`knowledge add --name 规则 --project P --source 来源 --version 版本 --text 内容` 保存已确认决定；`knowledge supersede --id OLD ...` 保留旧版本并标记替代。共享规则必须显式给出 `--projects '*'`。Executor 的 `read` 只返回自身目标、相关知识和明确关联目标的证据；模型聊天不是项目记忆的权威来源。

双入口补充先明确任务编号，`route attach --ticket T --trigger MESSAGE` 沿用原工单，不另派重复任务；重放保持幂等。未归属任务的管理查询可 `reply --trigger MESSAGE --text 答复` 回原入口，再 `route ignore` 结束判断，不创建开发任务。已经进入 Executor 的问题保留上游答复规则。任务最终结果仍回原始话题，不自动广播全部入口。

`--github OWNER/REPO,OWNER/OTHER` 可监听多个已验证账号下的仓库。组件登记 GitHub 关联须同时提供 `--github-repository`、`--github-owner-id`、`--github-owner-login`；发布还必须逐工单授权。启动参数只允许添加来源，不能悄悄移除旧来源或换账号。工单目标、工作区 Git 身份、审查指纹、发布授权和实际 Publisher 必须一致。

## 全量审查修复后的任务接续与回收

来源读取按话题隔离故障，失败话题保留错误和重试进度；有效的其他话题继续接收。Router 的 `router status` 区分保存的提醒回执与 `health` 中的绑定观察。执行器按 assignment 独立处理外部操作，同一 assignment 保持串行；慢启动不再挡住其他工单的监督。

Executor 用 `acknowledge --trigger ID --text TEXT` 回原请求确认；`report waiting --question TEXT --asked-by TRIGGER` 请求人工决定；`report progress --answers TRIGGER --summary TEXT` 授权答复追问；`--question ''` 清除已解决问题。以上均带当前 ticket/assignment/token。Router 从 `router wait` 的 attention/answer 通知取得原文，分别通过 `reply --purpose attention --ticket ID --question TEXT --text TEXT` 或 `reply --trigger ID --text TEXT` 回原入口。稳定消息 ID 负责去重，清除问题会撤回尚未发送的旧提问。

没有工作线归属的新任务默认使用隔离 worktree；显式 `--goal ID` 的后续阶段在同一精确 location 下，存在唯一已完成前驱目录时默认续用。开放任务优先 `route attach`，独立并行工作显式 `--workspace isolated`，多个候选目录显式选择 `--continue-from TICKET`。明确的只读调查可指定 `--workspace inspect`，使用登记仓库，不创建分支；这是行为约定，不是文件系统沙箱。续接要求同组件、同仓库、同执行位置、前次资源已结束且没有遗留终端；保持分支与文件，工单和 Run 独立。该方式不开放程序化 PR 发布，发布仍要求本工单自有隔离分支。

`read` 会包含显式 depends-on 和 continue-from 关联的目标、目录、报告、执行和审查证据。不需要为了读取前置成果而把无关项目知识全部装进上下文。模型历史不会自动迁移；新会话按持久交接记录续接。

以下命令使用 Router lease，先检查，再以检查返回的 fingerprint 删除：

```text
cleanup inspect --ticket TICKET
cleanup references --ticket TICKET --fingerprint REFERENCE_HASH --evidence /absolute/assessment.json
cleanup inspect --ticket TICKET
cleanup remove --ticket TICKET --fingerprint HASH
```

仅清理框架自建、业务已结束、执行资源已收尾、无目录引用、无遗留终端、无修改/未跟踪/忽略文件且 HEAD 等于创建基线的工作树。超出这些条件保留并说明原因；历史目录缺少基线也保留，不自动补造证据。调用原生 worktree rm，不使用 force；Orca 可能同时删除临时分支，原生删除回执留档。响应丢失时检查磁盘、Git 和 Orca 三方清单，不重复删除。它不是按时间批量删除历史目录的任务。

外部服务/路径引用必须先实际调查并记录证据，未归档工作线、备忘录和交接证据仍引用的目录继续保留。删除前失败且原清单完整不变时可用 `cleanup reset --ticket TICKET --fingerprint SAVED_HASH` 解除锁定，再重新检查；它不会自行删除目录。证据格式、范围和限制见 [持续工作实现](docs/p4/CONTINUOUS-WORK-IMPLEMENTATION.md)。

工程记忆复用版本化 `knowledge`：Executor 用 `memo` 维护当前组件/执行位置/工作线范围内的事实，用 `report --next-step --evidence` 交接。`read` 返回自动生成的持久 `WORK.md` 路径，不依赖智能体私人聊天历史。

当前正式 Router 使用 Orca 原生聊天页，后台 orchestration 消息与人工输入分离；看门狗写持久事件队列，服务用 `--watchdog-events PATH` 消费。原生聊天创建使用 `bin/osa-router-chat.ts` 并持久保存创建意图。现有终端不自动改造为无干扰通道，Orca 身份变化后仍需核验和重绑。具体入口、备份与恢复见 [运行手册](docs/p4/RUNBOOK.md)。

服务启动器观察 15 秒后若初始化仍在进行，返回 `starting`；supervisor 给身份初始化最多 150 秒，总预算内不把 starting 当失败。`running` 仍须收到实际 ready。通过 status 查询最终状态。


## 消息归属与持续监督修复（2026-11-03）

Router `intake --thread` 现在仅指定回复会话；每条新输入使用独立的请求线程，先接受为新任务或显式 `route attach`，不会向同一聊天里的所有工单广播。已有输入重放沿用原身份；GitHub、飞书专属话题的订阅语义保持原样。

`route accept` 直接使用所有者原始消息作为范围；`route attach --ticket T --trigger MESSAGE` 按顺序追加所有者补充原文并保存来源和修订记录。兼容旧命令的 `--scope`、`--note` 不再用于改写派工范围或添加指令。Executor 的 `read` 返回原文和修订记录，由 Executor 根据所有者的更正解释当前授权；旧审查因范围变化失效。Executor 处理补充后使用 `report progress --inputs INPUT_IDS --summary '逐项如何处理'`；`ack` 仅确认读到。`ready` 要求读过最新范围/输入并对所有人工补充留下处理报告，可在最终 report 同时带 `--inputs`。

服务按任务生成进展和待续接提醒，Router 用既有 `router wait` 消费。等待但没有人工问题的任务不会因一次确认永久消失；五分钟后仍未推进会再提醒。相同待办的唤醒最多每五分钟重提，时间字段变化不再触发新事件。看门狗安装器升级到 v2：去除十五分钟时间桶，保留相同故障的稳定事件身份。旧安装运行一次安装器即可升级，有备份且重复执行不改文件。

结算对账先核对精确 Task/Dispatch/Run 和真实 worker_report，再检查子资源。若执行者误把父 Run 绑定为自己的协调 Run，只有确认其结算后才恢复服务消费；其他协调者持有的 Run 保留并报告冲突。已取消的 abandoned/stopped 执行只有明确退出且子任务结束才释放容量。不将超时、空邮箱或未知状态当成结束，不自动重跑未知外部动作。恢复命令只等待本工单的执行通道，不再等待无关工单。

Router skill 已改为确认唯一持久监督责任方；OSA 任务无需额外挂 /tmp 轮询和手工 re-arm。服务未覆盖的临时任务仍须有明确期限和交接。修复前快照位于 `.osa/architecture-fix-20261103/source-before.tar.gz`。

托管器每次重新启动服务都会重新验证并读取配置中的启动参数，避免容量和模型被旧进程缓存回退。状态目录、Orca 运行时文件和应用路径不能在托管进程内静默改变；需要更换这些身份路径时应重新启动托管器。取消或停止的执行，若列表只因本机状态缓存缺失而无法判定，可以使用精确本机执行观察的退出证明；远程失联和未知状态仍不能据此释放。

2026-11-04 开发宪章以根目录 AGENTS.md 为准。Router 只澄清结果与项目、路由所有者原话、忠实转达结果；技术规划和调试属于与 Router 平级的 Executor。前提不成立时 Executor 停下说明，Router 不得弱化拒绝或分歧。`status.reportReceipts` 可追溯经服务接受的报告原文。未迁移旧工单范围或改动已运行的服务。
