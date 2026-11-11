# Super-agent-orca（OSA）

让 agent 主动推进任务、跨项目协作的系统。当前形态：**没有常驻服务，没有自己的库**——一个普通窗口加载 `/osa-router` 技能就是协调者（Router），执行者由 Orca 原生编排拉起（任意 agent harness），报告走 Orca 信箱。

## 用法

在 Orca 里开一个窗口（终端或聊天界面都行），输入：

```
/osa-router <任务说明或任务文件路径>
/osa-router resume <任务名>
```

- 技能：`~/.claude/skills/osa-router/SKILL.md`
- 执行者规则：`~/osa-team/executor-rules.md`（派发书里点名读取，任何 harness 都吃）
- 任务状态：`~/osa-team/state/<名字>.env`（供 resume 重绑）
- 启动脚本（备用入口）：`~/osa-team/osa-team.sh`

## 现在的结构

```
你开窗口 → /osa-router（协调者，前缀 osa-router）
  ├ 评估（要不要改 / 是不是旧任务延续 / 拿不准先问）
  ├ 建 Run（一张 Run = 协调者的收件箱，下挂多个工单、多个执行者）
  ├ worker-start 派执行者（前缀 osa-executor，可并行可顺序）
  │    └ 执行者读 executor-rules.md：持续推进、只在真阻塞时停
  ├ 收报告（worker_done / escalation / 信箱），如实转述
  └ 重绑恢复：run-use + 会话 resume（不切窗口形态）
```

角色对应上游 dsh-superagent：窗口=主 Session，Run=收件箱，`task_*`=工单，`ctx_*`=派发（一个工单可多次派发）。一个 Run 一个协调者窗口，想并行多张单就开多个窗口各绑一张。

## 已实测（2026-11-10/11）

- 普通 Claude 窗口 + claude-agent-teams + chat 形态都能当协调者，能绑 Run、派执行者、收报告、转述。
- 执行者聊天形态同样工作；协调者聊天形态也验证过。
- 重启恢复：run-use 重绑 + `claude --resume` + 重发 `/goal` 有效。
- 报告投递、未读保留、escalation、"Worker stopped without reporting" 都实测收到过；协调者重派补位做过。
- 形态切换会让绑定失效（通知送达不到，但留在 Run 收件箱里，重绑即可取回）。
- `--display-name` 对已存在窗口不生效，要派发后 `orca terminal rename`。
- 报告自带业务标识（消息编号每次发送都不同，不能靠它去重）。
- 一个窗口只绑一张 Run；`run-current` 是绑定的确证。

## 与上游 dsh 的真实差异

任务真相的存储，两边是同一模式：dsh 把工单、输入、派发、报告放进程序化存储（Store），我们把工单（`task_*`）、派发（`ctx_*`）、消息放进 Orca 的库。**存储对齐了，对齐不上的是"喂回去"那一端：**

| | dsh | 新版 OSA |
|---|---|---|
| 谁判断"该做什么" | 程序读工单状态机，自动算出还有几条输入没递、该不该恢复 | 协调者这个模型自己看会话、自己判断 |
| 日常运行中谁喂 | 程序把新输入喂给执行者，事件驱动 | 一样，Orca 把执行者回报注入唤醒协调者 |
| 重启之后谁喂 | 程序自动重建、继续喂 | 人/脚本手动恢复：`run-use` 重绑 + 恢复会话 + 重发 `/goal` |

`/goal` 的分工还没有定论。已观察到的：给协调者重启后重发有效；一次设在执行类角色上的 /goal 在该停下来等授权时判了"目标无法达成"收场。但样本只有一次，且对象不是 worker-start 拉起的执行者——执行者要不要 /goal、有害还是无害，没有实测依据，先不下结论。

已知后果：协调者中途换窗口形态会让绑定失效、回报送不到（不丢，留在收件箱）；协调者重启后没人自动喂，得 `resume`。这两件都已有对应动作，但都要人或脚本先动手。

## 暂缓项（已确认要做，等条件到位）

- 飞书、GitHub 渠道：暂不接。
- 执行者完事默认关闭 → 所有者跟进时同一执行者已不在。等确认方案再做。
- 派往别的仓库（非本仓库）实测还没做过——这是盲区，也是下一个真实测试点。
- 旧待办 1、2（作业重放 binding、服务中断时报告不丢）随旧 OSA 调度服务一并废弃，不再适用。

## 这个仓库现在是什么

旧 OSA 调度服务的源码（src/bin/scripts/tests/plugin/vendor）已于 2026-11-11 删除（`22d2b5b`）。剩下的是：

- `AGENTS.md` —— 开发宪章
- `docs/000-005.md`、`docs/007-architecture.md` —— 设计文档（上游思想映射）
- `docs/006-deployment.md`、`008-cookbook.md` 等 —— 旧服务实现文档，已删（git 历史可查）
- `patches/` —— 对 Orca 的配套修改，按宪章保留、不扩展
- `PRODUCT.md` —— 已删（旧产品定义）
