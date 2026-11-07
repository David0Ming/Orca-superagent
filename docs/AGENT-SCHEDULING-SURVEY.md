# Router 归属与智能体调度调查

调查日期：2026-11-02。本机配置只读核对；官方免费政策按当日页面记录，实际可用性、余额和费用以账号为准。以下分工是建议，不是模型能力排名；未对所有工具做同题性能测试。

## Router 放在哪里

建议长期使用独立的管理目录，例如 `/Users/mzg/orca/router`，在 Orca 显示为“Super-agent 管理中心”。不需要为了值守新建 Git 分支：分支用于开发代码，不能隔离跨项目任务记录，也不能提供权限沙箱。

- Super-agent-orca 保留为框架源代码项目。
- Router 管理目录只放入口说明、Router 技能和状态位置说明，不复制业务项目源码或把各项目记忆拼成一份。
- 项目、组件、位置、任务和知识继续由现有数据库按 ID 隔离；Executor 进入工单冻结的目标 worktree。
- 这次先保留现有路径和 `.osa/p4-live`，不迁移数据库。当前 `src/router.ts` 将 Router 的真实工作目录与服务 repository 做精确比较，独立目录需要明确拆开 Router home 与 legacy repository，并验收重启、旧任务和唤醒；不能直接搬窗口或放宽成任意路径。

用户已确认默认 Router 使用 **Claude Code，沿用现有模型配置**。Orca 全局 `defaultTuiAgent` 已是 `claude`；此前 Router 是单独指定的 Codex。此偏好只针对 Router，不把 Executor 全局改成 Claude。

## 本机已配置什么

证据：Orca `account list`、只读 profile settings 白名单、各 CLI 的路径/版本、客户端配置中的模型与 provider 字段、`opencode models`，以及应用“智能体”设置页的安装检测。未保存认证密钥或完整账号配置。Orca 内置启动参数有某 agent，不代表其已安装。

| 工具 | 本机实际情况 | 适合承担的角色／限制 |
| --- | --- | --- |
| Claude Code | 2.1.316；Orca 全局默认；本项目没有 `.claude/settings*.json` 覆盖。用户级 Opus/Sonnet/Fable 别名均映射到 `ccs-claude-commandcode-3--deepseek/deepseek-v4.1-flash[1M]`，Haiku 对应同模型无 `[1M]` 名称 | 用户指定的 Router；现有独立 Reviewer 客户端。**这是配置声明，不是上游实际模型的独立证明**，不能把客户端名字当作 Anthropic 模型身份 |
| Codex | 0.166.0；Orca 可读到 Pro OAuth 用量；本地配置仍有 `gpt-5.5`、custom provider。OSA 本轮启动参数明确覆盖为 `gpt-6.1-sol` | 已验收的主 Executor，负责实施、检查、协调子任务。不能靠全局配置猜此次有效模型 |
| OpenCode | 2.0.29；配置 `kimi-cygame`，含 `kimi-for-coding`、`k3`、`k3-256k`、`kimi-for-coding-highspeed`；没有显式全局 model。实际列表可见多个 `opencode/*-free` 模型 | 优先尝试低成本文档助手。客户端支持多个 provider，费用与数据政策取决于具体 provider/model；现有 Kimi 配置不能视为免费 |
| Command Code | Orca 有 `command-code` 启动配置；当前 PATH 未找到独立 `cmd` / `command-code`，`.commandcode` 只有 skills。Claude 别名出现其转接名称 | 列为候选；经转接使用模型与已安装原生 CLI 是两件事，账号套餐和免费模型调用尚未实测 |
| Pi | 1.2.0；无默认 provider/model，auth 文件 provider 列表为空 | 可扩展、轻量的执行客户端；目前没有证据表明已接好免费推理，不优先新增集成 |
| Cursor Agent | `cursor-agent` 存在；Orca 报告已认证、free 计划、月用量比例 0% | 可试小范围阅读或审查；0% 不代表无限额度，也不保证此次 CLI 请求可用 |
| Grok / Hermes | PATH 可找到；Orca Grok 用量状态为未登录；Hermes 本轮未核对模型与计费 | 暂不纳入默认调度，仅记录存在，避免把安装状态当作可用性 |
| OpenCode 2 / Muse / Aider / Cline | Orca 设置页另检测到 `opencode2`、`muse`、`aider`、`cline`；本轮未核对各自 provider、认证和额度 | 纳入已有工具清单；不因安装成功就分派任务或认定有免费额度 |
| Gemini CLI / Qwen Code | 当前 PATH 未找到 `gemini` / `qwen`；Orca Gemini CLI OAuth 为关闭 | 候选工具，尚未安装或接入验收 |

Orca 托管账号列表为空不等于未登录：Codex 正在使用 system default 身份。调查时 Codex 周用量为 43%，但这是会变化的快照。Claude 订阅用量不可读，Orca 显示 API key billing；不能据此推算转接服务余额。

应用设置页共检测到 12 个启动入口：Claude、Claude Agent Teams、Codex、Grok、OpenCode 2、OpenCode、Muse、Pi、Aider、Cline、Cursor、Hermes；其中 Claude Agent Teams 是独立启动入口，不代表多了一家模型供应商。此清单比当前 shell 的有限 PATH 检索更完整。

Claude 的 alias 可以由环境变量重定向，因此审查记录应区分“独立进程”“不同客户端”和“不同实际模型”。现有程序强制独立 `claude` Dispatch，并不证明供应商身份或实际模型不同。[Claude 官方模型配置](https://code.claude.com/docs/en/model-config)

## 免费额度调查表

| 工具／服务 | 当日官方说明 | 调度建议 |
| --- | --- | --- |
| OpenCode Console（原 Zen） | 当前列出免费 DeepSeek V4.1 Flash、GLM-5.3-Flash 等，前两者注明供应商零保留、不用于训练；活动限时，未在该页承诺统一每日额度。免费聊天模型要求使用 OpenCode 客户端。[官方模型与政策](https://opencode.ai/v2/docs/console/models/) | 本机已有工具和模型目录，优先小规模验证这两个具体免费模型；先读公开资料，不把所有 OpenCode 模型统称免费 |
| Command Code | `laguna-s-2.1-free`、`glyph-cluster:free` 各每日最多 1,000 请求；开始会话需账号至少有 $1 credits。`beam:free` 活动期间无每日请求上限，也有余额门槛。Glyph 和 Beam 可能保留内容用于训练；活动可能结束。[官方定价与条款](https://commandcode.ai/docs/resources/pricing-limits) | 适合公开文档提取、简单分类；不默认传私有业务代码。每日请求数不等于完成任务数 |
| Command Code Provider API | 官方列出 Go 无 API access，其他指定计划可用；客户端免费模型和外部 API 使用资格要分别确认。[官方 API 说明](https://commandcode.ai/docs/provider) | 先确认当前账号/转接链路资格，不为了免费额度默认另买套餐 |
| Gemini CLI | Google 账号的个人 Code Assist 路径每日最多 1,000 请求；Gemini API key 免费路径列为每日 250，请求还受限速及供给影响。[官方额度](https://geminicli.com/docs/resources/quota-and-pricing/) | 作为第二批文档阅读候选；需安装、认证、核对该身份的数据条款与调度回执 |
| Qwen Code | 官方已公告 2026-04-15 关闭原 Qwen OAuth 免费入口；旧的“每天 1,000 次”不能继续采用。[官方公告](https://github.com/QwenLM/qwen-code/issues/3203) | 不因旧免费宣传接入；若已有其他 provider 配额，再单独评估 |
| Cursor | 官方存在免费计划，但没有可据此承诺给本项目的固定充足额度。[官方计划](https://prod.cursor.com/help/account-and-billing/pricing) | 利用现有账号做候选验证，不作为必须完成的后台任务唯一执行来源 |
| Pi | 是可扩展的 agent harness，需另接模型服务；工具本身不附带已核实的免费推理额度。[官方 README](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md) | 只有其接口确实比已有 Orca 客户端更适用时再接入 |

免费条款按 **服务 + 模型 + 账号** 记录。同名 Beam 在不同服务的保留/训练条款不同，不能互相套用。读取文档也会把内容发给推理供应商，“只读”不等于“不外传”。短期活动（如翌日到期的免费促销）不作为默认调度基础。

## 建议的最小调度方案

继续一套服务管理多个项目；不增加第二套任务数据库、通用选模平台或多个竞争 Router。

| 角色／工作 | 默认安排 | 输出与边界 |
| --- | --- | --- |
| Router | Claude Code，沿用用户现有模型配置 | 接收双入口、识别项目、查询管理状态、关联工单、转达。技术拆解留给 Executor |
| 确定性工作 | 现有 CLI、`rg`、Git、测试脚本 | 文件查找、统计、运行既定检查无需额外 LLM |
| 主 Executor | 已验收的 Codex `gpt-6.1-sol` | 实施与验证；对最终产物负责；继续按项目公平轮转及优先级并发 |
| 文档／资料子助手 | 先试 OpenCode 指定免费模型，再考虑 Command Code / Gemini | 在同一工单 Run 下由 Executor 派生独立 Dispatch；返回来源、定位、摘要、不确定项，由 Executor 复核 |
| 最终 Reviewer | 继续独立 Claude Code 子任务 | 检查实际 diff 和证据；文档助手输出不能替代独立审查或真实测试 |

“读一个文件”通常直接读更省。只有资料量大、任务可独立描述、摘要确实能减少主 Executor 上下文时才另派助手。先用少量代表性任务比较正确率、耗时、工具调用/回执稳定性，再决定是否扩大范围；本次没有依据声称某免费模型必然优于另一模型。

记忆仍按项目／组件／工单分层。助手只收到该任务需要的材料，结果进入该工单证据，不直接修改全局知识或其他项目记忆。更换模型可以更换执行者，不复制整段多项目聊天作为“公共记忆”。

接入门槛：启动身份准确、回报与已读确认可靠、可停止并确认退出、可清理终端资源；每次记录客户端/provider/model、尝试次数、结果和可获得的用量。免费服务限流/下线时有界重试，之后标明等待或使用事先允许的替代项，不静默转付费、不自动充值。

本机多数 Orca agent 默认参数启用了自动批准／yolo。因此只读助手不能只依赖提示词；首轮使用公开文档的独立临时目录，限制工具权限，不授予项目写权限或业务凭据。优先复用客户端原生限制能力，验证有效后再处理私有资料。

## 本轮范围

完成调查与默认 Router 客户端切换；免费助手自动调度尚未实现。目录拆分、实际模型身份审计、免费助手接入需要各自的最小验收。用户后续新增 Orca 普通点击不应自动转人工接管、临时终端／工作空间／worktree 完整清理流程，另行检查 Orca 实现，不在本调查中宣称已完成。
