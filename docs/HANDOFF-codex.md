> 2026-11-04 开发方向已重新确认，先读仓库根目录 AGENTS.md（开发宪章）。11-03/04 的可靠性实施线已回退，相关架构文档只作历史记录。

> 2026-11-03 13:12 持续工作线、工程备忘录与后台消息代码已加载，334 项测试和类型检查通过，三处独立审查发现均修复并复查通过。正式 Router 已于 13:13 绑定原生聊天 `claude_4015f879_c4ff_4ad9_a049_740a1c56b0ba`，标题“OSA Router（聊天入口）”；旧终端保留为历史。用户明确先做聊天页无干扰交互，终端后台通道后续增强。看门狗已安装事件队列适配。22 个工单、37 条派工完整保留，备份及限制见 [持续工作验收](p4/CONTINUOUS-WORK-IMPLEMENTATION.md)、[当前入口](p4/RUNBOOK.md)。下方日期记录是历史，不代表当前入口或未实现状态。仍未提交/推送、未安装 Orca 应用补丁、未删除业务工作区。

> 2026-11-03 全量审查修复已加载至 `.osa/p4-live`：322 项测试（`--maxWorkers=2`）及类型检查通过；gpt-5.6-sol 辅助验证、Claude Code 独立审查与补修复核完成。21 张工单、26 条派工身份保留，SQLite 完整，Router connected。新增问答、跨 await 审查校验、来源隔离、按 assignment 并行监督、显式目录续接/只读复用、受控清理及启动状态修复；详情见 [修复验收](p4/AUDIT-FIXES.md)。未提交/推送，未安装 Orca 应用补丁或删除历史业务目录。用户最新提出：长期工作区与简短备忘录应归项目/工作区而非智能体；Router 原生提示和看门狗占用输入栏，需要后台系统事件通道。这两项目前只有诊断/设计记录，不能声称已实现。

# 交接给 Codex：Orca Super-agent

2026-11-03 日常运行修复：Router 空闲超过 60 秒但无人接替时，原 token 下一条命令自动续租，实际接替后旧 token 仍失效；不靠延长租约或新建续租进程。`status.executionBindings[].holdsExecutorSlot` 明确真实占槽，避免把已释放执行资源的 `blocked` 业务工单误判为调度堵塞。74 项相关测试和类型检查通过，已加载到当前服务，原 14 张工单及派工身份保留。详情和未补齐的唤醒处理确认边界见 [运行复盘](p4/ROUTER-OPERATIONS-REVIEW.md)。

2026-11-03 用户授权补齐本机随 Orca 启停：新增 `scripts/osa-supervisor.mjs`，独立 LaunchAgent，复用原启动器，不修改信箱看门狗。配置 `.osa/p4-live/supervisor-config.json`，安装/暂停与恢复见 [运行手册](p4/RUNBOOK.md)。这属于本机运行保障，不是 P5 跨机器接管。旧服务因磁盘耗尽异常退出，恢复前 SQLite `integrity_check` 为 `ok`；当前 Router 终端身份与原绑定一致。服务重启不等于重跑工单，Orca 重启也不自动绕过 Router 重新绑定检查。

2026-11-02 最新决定：人工操作后的任务窗口关闭策略要做成可选项，配套修改版默认允许。已实现“设置 → 编排 → 允许智能体关闭人工操作过的任务窗口”，开关在执行主机统一控制，键盘/粘贴/手机/聊天也适用；关闭偏好可持久保存，worker 不可通过 RPC 修改此选项。补丁已纳入 [配套 Orca 修改](../patches/README.md)，197 项相关测试、Node/Web 类型检查、代码质量与 main/preload/renderer 构建通过。尚未安装新应用包或做真实窗口端到端验收，历史人工接管标记未清除。整体仍为 P4 可用原型的发布前收尾，自动工作树回收、独立 Router 目录、免费助手自动调度和正式安装发布未完成，P5 未开始。

2026-11-02 补充：用户明确默认 Router 为 Claude Code，沿用现有模型配置。已切换到 `OSA Router Claude`，终端 `term_6231f374-a326-4fe2-9d78-dce61b155474`，原生 Run `run_3b5c78a6a55f`；旧 Codex Router 已退出值守，历史保留。状态目录仍为 `.osa/p4-live`。见 [当前入口](p4/RUNBOOK.md)、[智能体与免费额度调查](AGENT-SCHEDULING-SURVEY.md)。注意本机 Claude Code 的默认模型别名映射到 Command Code 转接的 DeepSeek，不能把客户端身份等同于 Anthropic 模型。独立 Router 目录仅为建议，尚未迁移。用户另要求修改 Orca 普通点击自动人工接管行为，并完善临时资源清理，见 [生命周期方案与待办](ORCA-RESOURCE-LIFECYCLE.md)。已用 REA/定向包读取定位鼠标被误报为用户接管，并实际检查设置页，未找到相关开关。官方对应版本源码已下载到 `/Users/mzg/workspace/orca-resource-lifecycle`，源码修改与验证已完成，结果见上方最新决定；未替换运行中的应用或删除历史资源。

> 2026-11-02：P3 已通过真实飞书闭环及受控监督恢复验收，258 项测试与类型检查通过。用户手动发送目标，不需要等待代发权限。详见 `docs/p3/RESUME.md` 与 `docs/p3/VERIFICATION.md`，不要重复建群或重启已完成派工。

后续用户已选择一套服务统一管理 SoulShift、Super-agent-orca 和智能客服（含面板、报表、Hermes 核心），要求双入口接续与项目管理。P4 第一版已实现，审查修复后 293 项测试与类型检查通过，真实主要验收见 `docs/p4/VERIFICATION.md`，当前入口/重启见 `docs/p4/RUNBOOK.md`；设计见 `docs/P4-MULTIPROJECT-PLAN.md`。当前服务 `.osa/p4-live` 和指定 `OSA Router Claude` 窗口运行中，旧 `.osa/p3-live` 停止，不要同时监听同一飞书群。第一版远程操作优先由本机 Orca Executor 使用 SSH；直接修改远程代码仍需相应审查证据。

以上项目只是首批样本，用户明确要求通用项目管理，不得硬编码本机或特定项目；优先级允许其他就绪任务并行，需要避免低优先级长期饥饿。项目知识、任务状态与模型上下文分开管理。用户明确「5 作为下一阶段目标，先实现 1–4」：P5 再处理跨机器常驻/多机接管；11-03 补充授权的本机随 Orca 启停不属该延期范围。

原始交接时项目刚完成方案设计和 P0 技术验证。目前 P1、P2、P3 已完成，各阶段验收记录在对应 `docs/p*/VERIFICATION.md`，使用方式见 `README.md`。既定决定继续适用。请按顺序读：

1. `docs/PLAN.md`：已经拍板的决定、整体结构、模块来源、Router 窗口设计、分阶段验收，以及 P0 结论表（第 6 节）
2. `docs/p0/A-external-driver.md`：外部程序怎样驱动 Orca，可用命令序列就在这份文档里，以它为准
3. `docs/p0/D-core-standalone.md`：复用上游核心层的方法，以及我们要实现的 6 个接口签名
4. `docs/p0/B-nested-depth.md`、`docs/p0/C-followup-delivery.md`：两层执行和补发后续消息

上游参考：`deepseek-ai/dsh-superagent-prototype`（提交 `6337fc8`，MIT）。本机有一份浅克隆在 `/tmp/dsh-ref/dsh-superagent-prototype`，`/tmp` 下的东西可能已被清理，没了就重新 clone 并 checkout 这个提交。P0-D 的验证项目在 `/tmp/p0-d/`。

## 不要推翻的决定（用户已签字）

- 个人使用。准入只认用户本人在各来源的账号。
- 目标入口：GitHub、飞书，以及一个「Router 窗口」。任何 Agent 都可以当 Router，但它只能判断、路由、回复：不读代码，不写实施计划。
- 前半段复用上游 `src/core`（15 个文件，约 2100 行，原样放进 `vendor/dsh-core/`，带上 LICENSE 和提交号），我们自己写存储、来源、Orca 执行器三类适配。
- 执行侧两层：Executor 是 Orca 协调者，可以拆子 worker（跨模型），交付前固定派另一个模型做独立审查。
- 去重、关联、派工记录、对外回复全部由程序完成，大模型只负责「接不接」的判断和执行本身。

## P0 得出的硬约束

- Orca 的每条命令都必须属于一个终端。osa 先 `orca terminal create` 开一个锚点终端，之后的命令都带 `--from <锚点>`，`check` 用 `--terminal <锚点>`。工作区写成 `path:<仓库路径>`，不要写 `current`。
- 一个锚点同一时间只能绑定一个 Run，所以每个活跃工单配一个锚点加一个 Run。重启后开新锚点，用 `run-use --id <run> --from <新锚点>` 接管原来的 Run。
- Orca 设置里的「嵌套工人深度」必须 ≥ 2，用户已经改好了，而且这个设置只能在界面里改。Executor 要先建自己的 Run，再起子 worker，否则会报 `consumer_fenced`。
- Orca 不提供「已读」信号。Executor 每处理完一条后续消息，要回一条带原消息编号的确认，osa 收到后才标为已读。
- 上游的存储接口是同步的，所以要用 Node 22+ 自带的 `node:sqlite`（`DatabaseSync`）。上游自带的内存版存储可以拿来做测试。
- 收尾顺序：先 `worker-release`，再 ack。只有收到有效的 worker_done 才能 release，不要用 terminal close 代替。
- 操作 Orca 编排前，先运行 `orca skills get orchestration`，读和当前版本匹配的说明（本机 CLI 版本是 1.4.227）。

## 已完成：P1 最小闭环

范围：存储、只认本人的准入、Router 窗口来源、Orca 执行器（单层）、发件箱（回复先只回到 Router 窗口）。

验收：在 Router 窗口提一个小目标 → 生成工单 → Orca worker 完成 → 回报就绪 → Router 窗口收到结果。中途杀掉 osa 再启动，不会重复派工，也不会重复回复。

## 已完成 P2、P3

P2 已接入 GitHub 来源、持久回复、精确分支 PR 关联和发布、两层执行及程序校验的独立 Claude 审查。217 项测试通过；私有验收仓库 `David0Ming/osa-p2-validation-20261102` 的 Issue #1 → PR #2 → 无 @ 评论 → 同工单第二次派工 → 更新同一 PR 已跑通。PR 留开，测试服务停止。主项目没有 commit/push；仅私有验收仓库按用户授权产生测试提交、Issue、评论和 PR。

P3 范围仍为飞书来源和监督策略。已绑定本人和新建私人验收群，详见 P3 恢复记录；不能扩到其他群。不重复实现 Orca 的进程监督。

## 本机运行环境补充（2026-11-02）

用户已为 Orca 配置一个随 Orca 启动、关闭的简单看门狗。已核对 `~/.orca/watchdog/orca-mailbox-watchdog.sh`：它提醒未读、未上报和残留信箱，不托管 osa、不重启 worker。该看门狗保持不变；11-03 起 osa 使用独立 LaunchAgent 托管，取代此前仅手动启动的方式。

用户的工作偏好：

- 尽量省 token。
- 目标和验收标准定了就持续推进，只有业务规则空白、影响大的取舍、成本显著、有安全风险、操作不可逆这几类情况才回来问；需要用户决策时用选择题，推荐项放第一。
- 能并行的子任务就并行，并且每个都要有独立的验收判据。
- 回复少用技术符号。
- 只有用户明确要求时才 commit。目前所有文件都没有提交。
