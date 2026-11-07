# P3 验证记录

日期：2026-11-02。P3 真实监督恢复与飞书消息→独立审查→原话题结果均已通过。用户手动发送目标，不依赖代发权限审核。未提交或推送主项目，未新增依赖、修改 vendor 或看门狗。

## 实现与检查

最终协调者检查：`npm test` 为 10 个文件、258 项全部通过（43.12 秒）；`npm run typecheck` 通过。CLI 慢来源测试改为可控阻塞，避免依赖固定网络延迟。测试服务已停止，主协调 Run 无待回收终端。

- Feishu 来源固定本人、应用、机器人和群，激活时间持久化；原生 API 分页读取精确时间及 root/thread，聊天与话题全量历史发现旧根上的新回复。入库事务、消息内容去重、跨群隔离、身份变化和错误分页均有测试。
- 发件箱按话题保序，固定幂等键和可见标记；用真实 bot 身份、原话题及内容对账，返回消息再做原生 GET 验证。结果未知超过 55 分钟且无法对账时保留 pending，请人检查。
- 来源网络轮询与 Executor 循环分离；慢网络不阻塞 Orca 收件，关闭服务会等待来源操作完成。
- 监督记录实际 provider/model/outcome 与每次 Dispatch；超过阈值只通知，不把空输出或失联当死亡。确认失败/停止或原生 exited 证据后显式 retry，保留同 Task/工作区/未读输入并附恢复提示，最多两次；子 worker 未解决、用户接管或熔断均拒绝重试。
- Feishu Task `task_5593e387868f` / Dispatch `ctx_487a57b3c924`，监督 Task `task_8cc7dd08d062` / Dispatch `ctx_5f7e569d5fc1` 均由真实 Orca `gpt-6.1-sol` 审查并修复，succeeded 后 release 再 ack。协调者独立运行最终集成检查。

## 真实监督验收

隔离仓库 `/Users/mzg/orca/projects/osa-p3-validation`，工作区 `/Users/mzg/orca/workspaces/osa-p3-validation/p3-stall-controlled`。无文件改动、提交、推送或外部消息；单层运行以隔离监督测试。

| 证据 | 值 |
|---|---|
| 本地 state | `.osa/p3-stall` |
| 工单 | `95168a4ab7c7d6976f72f2944547f892` |
| Assignment | `f13d79183f92e9a2c3e0ae826d7f371e` |
| 原生 Run / Task | `run_9388351cda7c` / `task_c27e0df934d5` |
| 原 Dispatch | `ctx_37aade8b290e` |
| 恢复 Dispatch | `ctx_598a48410da9`，retryOf 为原 Dispatch |
| 实际模型 | 两次均 `codex` / `gpt-6.1-sol` |
| 结果消息 | `8f98c6d014b1f550123bc9a0a76cb312`，`Recovery check passed` |

1. 测试 worker 故意等待 120 秒后保持 waiting。测试阈值 1000 毫秒时，服务记录核查通知，原生观察仍为 live；没有自行停止或重复派工。
2. 按受控验收操作停止原 Dispatch，原生回执 `stopped` / `closed_agent_terminal` / `ptyKilled:true`。随后 Router `route retry` 沿用 Task 和工作区创建恢复 Dispatch。
3. 恢复 worker 从权威工单读取恢复提示，回报 ready 和真实 worker_done succeeded；服务记录 succeeded，先释放 worker、再确认收件、关闭锚点。
4. 停止服务后以最终实现重新启动，同一个已完成 Dispatch 和唯一结果保留，没有新 worker。Router 确认结果及旧等待通知后收件为空；工作区 `git status --porcelain` 为空。

## 真实飞书验收

指定验收群已建且成员已核对。以用户身份代发因缺 `im:message.send_as_user` 被明确拒绝后，用户改为手动发送 `hello from feishu`，没有 @ 机器人；真实消息已由来源读取。Router 根据本会话已确认的完整验收范围接单，不伪造飞书输入。

| 证据 | 值 |
|---|---|
| 验收群 | `oc_47566f4aacc97abe9ece0fa5efabd809` |
| 原消息 | `om_x100b61b2615670b0b0f055e604f096a` |
| 原话题 | `omt_198dea3099ce1ca3` |
| 工单 / Assignment | `6cdeee51db49fd3510a55d0ecb711479` / `084a5ff59ce8bef6c12445ae2350ef33` |
| Executor Run / Task / Dispatch | `run_11e14948fe16` / `task_2b1c846fcfe4` / `ctx_88c8f023763b` |
| Claude 审查 Run / Task / Dispatch | `run_e5e47508cf21` / `task_c66742d9e3b6` / `ctx_782c3294d8de` |
| 审查结论 | 第一轮 approve，服务校验身份、归属、真实完成记录与文件指纹 |
| 指纹 | `a2fda7a69eb0773801e4bda41c12ac076c2f0035d53241c4fc19b0dfae910221` |
| 发件箱 / 实际 bot 回复 | `101578e6ba12e839db0e230d9c455839` / `om_x100b61b2759a40a4de6a8b0c278f396` |

工作区 `/Users/mzg/orca/workspaces/osa-p3-validation/p3-feishu-acceptance`，独立读回确认 `p3.txt` 恰为 `hello from feishu\n`（18 字节）。HEAD 仍为 `56dd8dc24c34ad63449184e75ddc0d541aee3963`，Git 仅显示 `?? p3.txt`，无新提交或推送。真实 Claude reviewer 第一轮批准；两名 worker 均 succeeded 且 released。原生投递对账与额外飞书读取均确认 bot 回复位于原话题，发件箱为 sent。

以相同 state、repository、chat 和指定模型重启服务并完成后续轮询后，仍为一个工单、一个 Assignment、一个执行 attempt、一个 sent 发件箱记录，candidate/notice 均为零。飞书完整话题 `has_more:false`，仅包含原用户消息和唯一 bot 结果，无重复派工或回复。两个 Run 的待回收终端列表为空。验收后服务已停止，状态和工作区保留；未启用后台自动托管。

## 已知限制

全量聊天/话题扫描仅面向个人规模，数据增大时应换事件或索引。监督阈值是总运行时间提醒，正常长任务也可能触发；不是无活动检测。未实现自动选模型、主动规则、面板或 osa 自动托管。旧已结束 Dispatch 的未确认信箱保留历史；没有修改 Orca 数据库清除提醒。
