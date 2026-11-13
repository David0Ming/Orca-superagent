# Orca-superagent（OSA）

**多台电脑，多个 Agent，一个协作入口。**

把目标交给 Router，让 Agent 分头推进。打开面板掌握全局，通过 Orca 远程查看和控制不同电脑上的工作，在关键节点参与判断。

[中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · [العربية](README.ar.md)

## 从 Human to Human，到 Agent to Agent

| 协作方式 | 工作如何推进 |
| --- | --- |
| **Human → Human** | 人与人沟通、分工、交接 |
| **Human → Agent** | 人描述目标，Agent 执行任务 |
| **Agent → Human** | Agent 主动汇报、提问，邀请人作出关键判断 |
| **Agent → Agent** | Agent 派发任务、回传结果、传递问题，协同推进 |

**OSA 把 Agent to Agent 带进日常开发工作台。** Router 负责澄清目标与派发，Executor 负责规划、探索、实现和调试。你掌握方向，Agent 接住执行与交接。

## 为什么用 OSA

- **一个入口，多项任务。** 用自然语言交代目标，组织 Claude Code、Codex 等执行者并行工作，报告回到统一收件箱。
- **多台电脑，一个工作台。** 借助 Orca 的远程控制与多机管理，访问本机和远程电脑上的会话与工作区，随时跟进。
- **进展一目了然。** 原生侧栏按“需要你、待开始、等外部事件、进行中、历史”组织任务，支持按项目、工作区和 Agent 分组。
- **从全局直达执行现场。** 展开任务查看会话和往来记录，定位执行窗口，点击 `@` 复制任务引用，回到 Router 接着沟通。
- **长任务持续跟进。** 决策有具体问题，等待有复查日期，派发和反馈有记录，后续工作沿着原任务继续。

OSA 将 dsh-superagent 的角色分工、autoloop 的事件与时钟思路，与 Orca 的原生编排、可视化工作区和远程能力结合，形成从目标到执行现场的连贯体验。

## 怎么运转

```text
你提出目标 → Router 澄清并派发 → Executor 执行
                  ↑                   ↓
              关键判断 ← 问题、进展与结果

Orca：执行窗口 · 工作区 · 信箱 · 远程连接
OSA 面板：集中查看任务，追踪进展，进入具体会话
```

## 快速开始

准备好 Orca 和已登录的 Agent（例如 Claude Code 或 Codex）。

1. 将 [Router 技能](skills/osa-router/SKILL.md) 放入 Agent 的技能目录，例如 `~/.claude/skills/osa-router/SKILL.md`。
2. 将 [执行者规则](skills/executor-rules.md) 放到 `~/osa-team/executor-rules.md`。
3. 在仓库根目录运行，按 Orca 提示批准插件权限：

```sh
orca plugin install ./plugin/osa-panel
```

在 Orca 窗口中开始一项工作：

```text
/osa-router 帮我修复这个项目的登录失败问题，并在本地验证
```

接续已有任务：

```text
/osa-router resume <任务名>
```

## 深入了解

- [会话面板](plugin/osa-panel/README.md)：查看、搜索、定位与跟进任务。
- [设计理念](docs/000-philosophy.md)：Router 与 Executor 的分工。
- [状态守望](docs/009-state-watch.md)：等待复查与自动接续的实现记录。
- [执行者与渠道](docs/010-agents-and-channels.md)：执行者偏好及 GitHub、飞书接入方向。
- [Orca 配套补丁](patches/README.md)：适用版本与使用方法。

欢迎通过 [Issues](https://github.com/David0Ming/Orca-superagent/issues) 分享使用场景、反馈问题或提出建议。

## 致谢与许可

感谢 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)、[Orca](https://github.com/stablyai/orca) 和 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 提供的思想、接口与实践。

OSA 的代码与文档采用 [PolyForm Noncommercial 1.0.0](LICENSE)，允许非商业使用、修改和分发。`patches/` 中的 Orca 衍生补丁采用 [MIT](patches/LICENSE.orca)。
