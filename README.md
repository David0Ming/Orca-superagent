# Super-agent-orca（OSA）

让 agent 主动推进任务、跨项目协作的系统。当前形态：**没有常驻服务，没有自己的库**——一个普通窗口加载 `/osa-router` 技能就是协调者（Router），执行者由 Orca 原生编排拉起（任意 agent harness），报告走 Orca 信箱。

## 用法

在 Orca 里开一个窗口（终端或聊天界面都行），输入：

```
/osa-router <任务说明或任务文件路径>
```

协调者会：和你澄清需求 → 用 `orca orchestration worker-start` 派执行者（窗口前缀 `osa-executor`）→ 收报告并如实转述。

窗口重启后恢复：`/osa-router resume <任务名>`（状态存在 `~/osa-team/state/`）。

技能文件：`~/.claude/skills/osa-router/SKILL.md`（仓库外，个人技能）。

## 这个仓库现在是什么

旧 OSA 调度服务的源码（src/bin/scripts/tests/plugin/vendor）已于 2026-11-11 整体删除，git 历史里可以找回。剩下的是：

- `AGENTS.md` —— 开发宪章，仍然有效
- `docs/` —— 设计文档（其中描述旧服务实现的章节已是历史记录）
- `patches/` —— 对 Orca 的配套修改，按宪章保留、不扩展
- `PRODUCT.md` —— 旧产品定义，历史记录

新架构的实测结论和决定记录在会话记忆里；提示词底稿在 `~/osa-team-prompt-draft.md`；协调者启动脚本在 `~/osa-team/osa-team.sh`（技能之外的备选入口）。
