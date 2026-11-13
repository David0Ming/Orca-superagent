# Orca-superagent（OSA）

**把需求交给一个窗口，让多个 AI 执行者分头推进，在一个面板里看清谁在干活、谁在等待、哪里需要你。**

[快速开始](#快速开始) · [会话面板](plugin/osa-panel/README.md) · [能力与验证进度](#能力与验证进度) · [设计理念](docs/000-philosophy.md)

同时让几个 Agent 干活并不难，难的是任务变多、时间变长之后：谁还在推进？谁等着另一个任务？哪个问题真的需要你回答？重启后，又该从哪里接着干？

OSA 把 DeepSeek **dsh-superagent 的角色分工**带到 **Orca 的原生编排和面板**里。一个窗口加载 `/osa-router` 就成为协调者，Claude Code、Codex 等执行者负责探索、实现和调试，工单、派发与报告留在 Orca 原生记录中。你可以从面板找到任务、查看往来，再把上下文带回 Router 继续沟通。

> OSA = Orca Superagent。项目名统一写作 **Orca-superagent**，缩写 **OSA**。

## 为什么用 OSA

### 一个入口，协调多项工作

向 Router 说明你要什么结果、属于哪个项目。它把你的原话和限制交给合适的执行者；执行者自行规划、探索、实现和调试。多个执行者可以并行工作，报告回到同一个 Run 收件箱。

### 打开面板，就知道该关注哪里

侧栏按任务正在等谁组织工作：**需要你、待开始、等外部事件、进行中、历史**。可以按项目、工作区和智能体分组，搜索已加载的任务与消息，展开查看执行者最近一轮、执行历史和 Router／Executor 往来。

遇到值得跟进的任务，点击 `@` 复制任务定位，粘贴到 Router 即可继续问；需要重新判断的任务，也可以从面板把提醒交回 Router。具体交互和读取范围见[面板说明](plugin/osa-panel/README.md)。

### 长任务有记录，等待有复查约定

“需要你决定”与“等待外部条件”分别记录：前者带具体问题，后者带复查日期。Router 被唤醒时检查队列，判断该继续、改期还是结案。当前本机还配有定时扫描，点名到期等待和派发缺口。

我们正在验证的关键场景是：**A 等 B 或条件 C，条件满足后，无须你再说一句“继续”，A 就能接着干。** 复查和续派路径已配置；完整自动接续仍在实测，不作为已兑现的能力。扫描脚本和定时配置目前属于本机配套，并未打包成仓库的一键安装功能，见[状态守望记录](docs/009-state-watch.md)。

### 轻量接入已有的 Orca 工作流

OSA 由 Router 技能、执行者规则和会话面板组成，复用 Orca 的 Run、工单、派发与信箱，无需另起 OSA 常驻服务或数据库。适合已经使用 Orca、希望把多个 Agent 的工作集中起来看的个人开发者。

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
- 飞书、GitHub 渠道接入；GitHub 侧优先复用 Orca 原生的来源链接。
- 执行者完事默认关闭后，所有者跟进时的会话保留策略。

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
