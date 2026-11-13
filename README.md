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

## 与 dsh 、 autoloop 的取舍



## 暂缓项（已确认要做，等条件到位）

- 飞书、GitHub 渠道：暂不接。
- 执行者完事默认关闭 → 所有者跟进时同一执行者已不在。等确认方案再做。
- 派往别的仓库（非本仓库）实测还没做过——这是盲区，也是下一个真实测试点。
- 旧待办 1、2（作业重放 binding、服务中断时报告不丢）随旧 OSA 调度服务一并废弃，不再适用。

