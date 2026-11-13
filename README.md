# Orca-superagent（OSA）

**多台电脑，多个 Agent，一个协作入口。**

把目标交给 Router，让 Agent 分头推进。打开面板掌握全局，通过 Orca 远程查看和控制不同电脑上的工作，在关键节点参与判断。

[快速开始](#快速开始) · [为什么用 OSA](#为什么用-osa) · [会话面板](plugin/osa-panel/README.md) · [能力与验证进度](#能力与验证进度)

## 从 Human to Human，到 Agent to Agent

协作正在从人与人的交接，走向人与 Agent、Agent 与 Agent 的共同推进：

| 阶段 | 协作方式 |
| --- | --- |
| **Human → Human** | 人向人交代工作，靠沟通、会议和交接推进 |
| **Human → Agent** | 人向 Agent 描述目标，Agent 执行任务 |
| **Agent → Human** | Agent 主动汇报、提问，把关键判断交回人 |
| **Agent → Agent** | Agent 之间派发任务、回传结果、传递问题，协同推进工作 |

**OSA 把 Agent to Agent 带进你的日常开发工作台。** Router 接住目标、协调派发，Executor 负责探索、实现和调试，报告与问题回到统一入口。人掌握方向与关键决定，Agent 承担执行和工作交接。

OSA 将 DeepSeek **dsh-superagent 的角色分工**与 **Orca 的原生编排、工作区和远程能力**结合。一个窗口加载 `/osa-router` 就成为协调者，Claude Code、Codex 等执行者分头工作，工单、派发与报告保存在 Orca 原生记录中。

> OSA = Orca Superagent。项目名统一写作 **Orca-superagent**，缩写 **OSA**。

## 为什么用 OSA

### 一个入口，协调多项工作

向 Router 说明你要什么结果、属于哪个项目。它把你的原话和限制交给合适的执行者；执行者自行规划、探索、实现和调试。多个执行者可以并行工作，报告回到同一个 Run 收件箱。

### 多台电脑，也在同一个工作台

**承接 Orca 的远程控制与多机管理能力，把协作入口延伸到不同电脑。** 通过 Orca 连接执行主机，远程查看会话、操作工作区、补充要求，让本机和远程电脑上的 Agent 工作都能被看见、被跟进。

Orca 负责设备连接与执行环境，OSA 负责目标沟通、任务协调与进展呈现。多台电脑可以各有分工，你从一个工作台进入对应环境，继续沟通和处理任务。

### 打开面板，就知道该关注哪里

侧栏按任务正在等谁组织工作：**需要你、待开始、等外部事件、进行中、历史**。可以按项目、工作区和智能体分组，搜索已加载的任务与消息，展开查看执行者最近一轮、执行历史和 Router／Executor 往来。

遇到值得跟进的任务，点击 `@` 复制任务定位，粘贴到 Router 即可继续问；需要重新判断的任务，也可以从面板把提醒交回 Router。具体交互和读取范围见[面板说明](plugin/osa-panel/README.md)。

### 长任务有记录，等待有复查约定

“需要你决定”与“等待外部条件”分别记录：前者带具体问题，后者带复查日期。Router 被唤醒时检查队列，判断该继续、改期还是结案。当前本机还配有定时扫描，点名到期等待和派发缺口。

**让任务之间的交接有据可查，让等待中的工作按时回到视野。** 从派发、汇报到复查，任务始终有可以追溯的记录，后续沟通可以接着原任务推进。复查机制与自动续跑的实测进度见[能力与验证进度](#能力与验证进度)。

### 轻量接入已有的 Orca 工作流

OSA 由 Router 技能、执行者规则和会话面板组成，复用 Orca 的 Run、工单、派发与信箱，无需另起 OSA 常驻服务或数据库。适合已经使用 Orca、希望把多个 Agent 的工作集中起来看的个人开发者。

### 插件形态，让协作直达执行现场

**从全局任务，到具体会话，再到实际工作区，协作发生在你干活的地方。** 侧栏里查看进展，展开记录了解上下文，定位执行窗口处理问题，再回到 Router 接着沟通。

| OSA + Orca 的优势 | 你得到什么 |
| --- | --- |
| **原生工作台集成** | 任务面板与执行会话在同一应用中，查看与介入路径直接 |
| **远程与多机管理** | 从一个工作台访问不同电脑上的工作环境 |
| **多 Agent 协作** | 通过 Orca 原生执行入口组织 Claude Code、Codex 等执行者 |
| **按项目和工作区组织进展** | 多项长任务并行时，清楚知道谁在推进、谁在等待、哪里需要你 |
| **复用宿主运行能力** | 编排、窗口、工作区与信箱交给 Orca，OSA 专注任务协作体验 |

## 设计原则

- **Router 只做两件事**：把需求谈清楚，路由到对的项目、分支、路径或执行者。它不规划方案，不扩写或改写需求。
- **Executor 与 Router 平级**：规划、探索、实现、调试自己负责；前提不成立时可以直接拒绝，并说明依据和它认为该去的地方。
- **不复制调度器**：Run、工单、派发、信箱、面板全部复用 Orca。
- **不静默丢失**：回报留在信箱；异常显式报告；恢复由人或脚本触发。
- **不为没有真实反例的假设场景加机制**。

## 怎么运转

```
你开窗口 → /osa-router（协调者）
  ├ 评估：要不要改 / 是不是旧任务延续 / 拿不准先问
  ├ 建 Run：一张 Run = 协调者的收件箱
  ├ worker-start 派执行者（可并行可顺序）
  │    └ 执行者读规则：持续推进，只在真阻塞时停
  ├ 收报告：worker_done / escalation / 信箱，如实转述
  └ 恢复：run-use 重绑 + 会话 resume
```

| OSA 概念 | Orca 原生对象 |
| --- | --- |
| 协调者窗口 | 绑定 Run 的会话 |
| 收件箱 | Run |
| 工单 | `task_*` |
| 一次执行尝试 | dispatch / `ctx_*` |
| 报告 | `worker_done`、消息 |

## 快速开始

前提：本机已安装并登录 Orca，且有一个可用的 agent harness（Claude Code、Codex 等）。

1. 把 `skills/osa-router/SKILL.md` 放到 harness 的技能目录（例如 `~/.claude/skills/osa-router/SKILL.md`）。
2. 把 `skills/executor-rules.md` 放到任务说明能读到的位置（例如 `~/osa-team/executor-rules.md`）。
3. 安装面板：`orca plugin install <本仓库>/plugin/osa-panel`，按当前 Orca 返回的权限说明完成批准。
4. 在 Orca 窗口里输入：

```
/osa-router <任务说明或任务文件路径>
/osa-router resume <任务名>
```

任务状态写在 `~/osa-team/state/<名字>.env`，只作索引和恢复缓存；工单的 result 与 Orca 原生状态才是权威。

例如，向 Router 描述一项真实工作：

> 帮我修复这个项目的登录失败问题，先在本地验证，不推送、不部署。

Router 负责澄清和派发；执行者负责把问题查清、修复并回报。之后从面板查看进展，有需要时回到 Router 补充信息或回答问题。

仓库附带的 Orca 配套补丁有明确的版本要求与适用范围，请单独阅读 [patches/README.md](patches/README.md)。安装技能或面板不会自动应用这些补丁。

## 与相关项目的关系

**OSA 的特色是把自主协作融入可视化、可远程访问的开发工作台。** [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype#readme) 的公开原型面向单个 GitHub 仓库，运行于 DeepSeek Harness；[agent-autoloop](https://github.com/KKKKhazix/agent-autoloop#readme) 以后台中台、命令与通知卡片组织自动化。OSA 选择 Orca 插件形态，让任务、会话、工作区和远程操作形成连贯的工作体验。

OSA 借用了三个公开项目的思想和接口，不包含 dsh 与 autoloop 的代码；Orca 的配套补丁见 `patches/`，按 MIT 分发。OSA 与它们没有隶属关系。

| 项目 | 借了什么 | 没借什么 |
| --- | --- | --- |
| [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 领域模型（Trigger / Thread / Ticket / Assignment）、Router 与 Executor 的分工、报告回投 | 常驻服务、效果队列、工单状态机 |
| [Orca](https://github.com/stablyai/orca) | Run、工单、派发、信箱、面板 API；执行者拉起与监督 | 不改 Orca 本体 |
| [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) | 事件与时钟的思路（到期复查、安静扫描、递增提醒）、执行者适配的抽象 | 自建中台、事件溯源、租约调度 |

## 能力与验证进度

当前是持续迭代的个人工具，以下为维护者本机验证情况，不代表所有 Orca 版本、Agent 或部署环境都已覆盖。

已验证：

- 普通 Claude 窗口、聊天形态都能当协调者；执行者聊天形态同样工作。
- 重启恢复：`run-use` 重绑 + `claude --resume` + 重发 `/goal`。
- 报告投递、未读保留、escalation、“Worker stopped without reporting” 都实际收到过。
- 队列扫描：pending 必须有复查日期；dispatched 无在线执行者会点名；旧格式有截止日。
- 面板：无绑定 Router 且无在线执行者的 Run，其工单归历史。

待验证：

- 等待中的任务在条件满足后，无人工追加输入的完整自动续跑；复查路径已配置，正在观察真实任务。
- 派往其他仓库（非本仓库）的实测。
- OSA 跨电脑派发、等待与自动接续的端到端实测；远程控制与多机管理由 Orca 提供。
- 飞书、GitHub 渠道接入；GitHub 侧优先复用 Orca 原生的来源链接。
- 执行者完事默认关闭后，所有者跟进时的会话保留策略。

定时扫描脚本与调度配置目前是维护者本机配套，尚未打包成仓库的一键安装功能，见[状态守望记录](docs/009-state-watch.md)。

如果你也在用 Orca 协调多个 Agent，欢迎带着真实场景[提 Issue](https://github.com/David0Ming/Orca-superagent/issues)：你希望完成什么、任务停在哪一步、期望怎样接续。可复现的使用反馈最能帮助 OSA 向前走。

## 仓库结构

```
AGENTS.md              开发宪章
docs/                  设计与研究文档
skills/                Router 技能与执行者规则
plugin/osa-panel/      Orca 侧栏面板（只读展示 + 回到 Router）
patches/               对 Orca 的配套修改（MIT）
```

## 许可证

- OSA 自己的代码与文档：**PolyForm Noncommercial 1.0.0**。允许非商业使用、修改和分发，不允许商业使用。它**不是** OSI 认可的开源许可证，准确说法是“源码公开（source-available）”。
- `patches/`：衍生自 Orca，继续按 **MIT** 分发，原版权声明见 `patches/LICENSE.orca`。
- 上述三个参考项目各自遵循其原许可证。

## 致谢

OSA 的领域模型来自 DeepSeek 的 dsh-superagent-prototype；运行时原语来自 Orca；事件与时钟机制受 agent-autoloop 启发。感谢这些项目的作者公开他们的设计与代码。
