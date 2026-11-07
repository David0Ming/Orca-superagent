# P2 实现与验收

日期：2026-11-02。Node 22.23.0，Orca 1.4.227。Super-agent-orca 本项目保持未提交、未推送；远端写入仅发生在用户选择新建的私有验收仓库。

## 实现

- GitHub 来源使用固定仓库和本人数字账号 ID。Issue、普通评论、行内评论、review 按稳定编号和内容版本去重；完整分页，游标持久化，初次启动不派发历史 Issue。直接轮询目标仓库满足当前范围，无另建通知调度层。
- PR 必须来自同一仓库、本人账号、精确工单分支才能自动关联。绑定后评论自动成为原工单输入，CI 仅提供已有工单事实，merge/close 走上游核心生命周期。
- 发件箱程序回复，固定消息标记用于发送结果丢失后的核对；按讨论串保序，账号变化或暂时失败保留待发送记录。自己的回复不重新进入准入。
- Executor 用 Codex，在自己的 Run 下拆子 worker；交付前固定 Claude 独立审查。程序校验有效模型、父 Dispatch、同工作区、当前 Task 的真实 worker_done 和源码/输入指纹；两轮仍不通过则 blocked。陈旧或伪造通过声明不能放行。
- PR 发布需要 Router 的 `--publish true` 授权、当前派工能力、干净且已提交的精确分支、当前独立审查通过记录。程序推送固定提交并创建或核对现有 PR；不强推、不合并、不部署。
- 原 worker 已完成且回收后，新评论通过核心的投递失败/重试接口创建新派工，复用工单和工作区。单纯重启不重新派工。Orca 仍负责进程监督，没有新增看门狗。

## 真实验收证据

仓库：[David0Ming/osa-p2-validation-20261102](https://github.com/David0Ming/osa-p2-validation-20261102)（private）。

1. [Issue #1](https://github.com/David0Ming/osa-p2-validation-20261102/issues/1) 的本人目标被来源程序录入，Router 接受，工单为 `6b53c2b38c0f55ad7444d62ac6c773c5`。
2. 首派工 `ctx_f6461fcfad3e`（Run `run_8eb9455e60be`）实现 greeting 模块，2 项 Node 测试通过，提交 `7d6887ffb2a640d8b2c3dec22f3aa4007c28d7f9`。
3. Executor 新建子 Run `run_27e7aaec9ab9`，Claude 审查派工 `ctx_2cb033b8ad75`；有效完成消息 `msg_b263d5de81c6` 包含 approve 和已核对指纹，服务成功记录审批。
4. 程序创建 [PR #2](https://github.com/David0Ming/osa-p2-validation-20261102/pull/2)，绑定到工单并回复原 Issue。首派工与审查 worker 均已收尾。
5. 服务重启后，在 [PR 评论](https://github.com/David0Ming/osa-p2-validation-20261102/pull/2#issuecomment-6573227257) 中提出 trim/空白名称回退目标，没有 @。来源自动投递给同一工单，并创建第二次派工 `ctx_0c85dc54ecce`（Run `run_de82d8fb9824`），继续使用 `p2-greeting` 分支和原工作区。
6. 第二次提交为 `f5d13d4660c37c604aa8eb56ba70169125246418`，4 项 Node 测试通过。Claude 审查派工 `ctx_f14c72f9dbdf`（子 Run `run_f633ca9f4746`）再次批准，程序更新同一个 PR #2，远端 HEAD 与该提交一致。PR 保持 OPEN，没有合并。
7. 数据库中共一个工单、两次派工、两条已发送结果；逐条查询 GitHub 原 Issue 评论，两条消息标记各出现一次，无重复回复。两次 Executor 和两次审查均已结算；第二次 Executor 和两次审查已 released，第一次 Executor 被 Orca 标记为 `user_owned / retained / user_takeover`，按平台所有权保留其终端，没有强制关闭。五个相关 Run 均无 reclaimable 资源；测试服务已停止。

最终检查：9 个测试文件、217 项测试全部通过，TypeScript 严格类型检查通过，真实验收仓库 `node --test` 4/4 通过。源码保持原样 vendored，上游测试也纳入以上总数。

本机验收状态为 `/tmp/osa-p2-live/state.db`，工作区为 `/Users/mzg/orca/workspaces/osa-p2-validation-20261102/p2-greeting`。临时状态目录可能被系统清理，远端 Issue/PR 和以上记录保留证据。

## 验收中修正的问题

- Issue 的 updated_at 会随评论变化。正文版本改用标题/正文内容，避免程序自己的评论不断重发同一个目标。
- macOS `/tmp` 的真实路径是 `/private/tmp`。服务统一真实路径，新仓库以真实路径登记到 Orca。初次失败明确返回 selector_not_found 且尚无 Dispatch；备份验收数据库后，仅清除了这条已拒绝的锚点创建回执，未重试未知派工。
- 已结束 Executor 的后续消息原先会被丢弃，现改为确认其结算和回收完成后续接新派工。
- 没有 CI 的新提交不再产生“无检查”的虚假工作输入。
- 运行期间切换 gh 账号时，发件箱拒绝用新账号发送。

## 边界

- 本轮真实审查走通过路径；打回意见、两轮上限、错误模型、过期版本和伪造完成消息拒绝由自动测试覆盖，不声称已做真实模型打回实验。
- 审查指纹不支持子模块，Git 输出超过 64 MiB 会失败；ignored 文件不在交付审查指纹内。
- 当前一个 Executor 工作槽；每轮扫描开放 PR 的 review，适用于个人仓库。大量历史/高流量仓库的压力优化未做。
- 消息标记用于重试核对，不是 GitHub 提供的原子幂等键；任意外部 UI 的视觉恰好一次不作保证。
- 未核对或接入用户现有看门狗，飞书和 P3 主动监督尚未实施。
