# 当前多项目管理入口

2026-11-03 13:12 已加载持续工作线、范围隔离备忘录与后台消息实现。334 项测试通过；详细范围、真实验收与恢复方式见 [CONTINUOUS-WORK-IMPLEMENTATION](CONTINUOUS-WORK-IMPLEMENTATION.md)。13:13 新原生聊天已取得租约并绑定。看门狗改用持久事件队列，不再写人工输入框。终端无干扰后台通道作为后续增强。

2026-11-02，P4 第一版已运行。Router 默认使用 Claude Code，沿用用户现有模型配置；Executor 模型 gpt-6.1-sol，默认最多两个 Executor，独立 Claude Code 审查。客户端名字不代表实际模型身份，见 [调度调查](../AGENT-SCHEDULING-SURVEY.md)。项目数据与任务都在 `.osa/p4-live`，这是当前服务唯一状态目录，名称含 live 不表示可以删除。

- 飞书：原「Orca Super-agent P3 验收」群，`oc_47566f4aacc97abe9ece0fa5efabd809`，只有本人和机器人；无须 @，回复在原话题。
- Orca：**OSA Router（聊天入口）**，Claude 原生聊天 `claude_4015f879_c4ff_4ad9_a049_740a1c56b0ba`。固定系统发送端 `term_58fd0e3b-2e2d-48d6-aec6-5f2737e5fc96`（OSA system events）用于后台消息身份，不是人工对话窗口。旧 `term_6231f374-a326-4fe2-9d78-dce61b155474` 已命名为“历史 Router（新消息请用聊天入口）”，保留历史和草稿，不再作为新目标入口。飞书与新聊天可以交替使用同一任务记录。
- 直接问「查询各项目进度，不创建任务」不会创建开发任务。开发目标请说明业务项目、组件、验收结果以及是否允许提交/推送/部署；缺少执行位置时 Router 应询问候选。

登记项目：SoulShift（`soulshift`）、Super-agent-orca（`legacy`，兼容 ID）、智能客服（`smart-cs`）。智能客服组件为 `smart-cs-panel`、`game-ai-cs-report`、`hermes-core`（客服 Hermes 核心）。alpha/beta 验收项目已归档，历史保留。现有业务项目只登记，没有自动执行修改。

## 服务启动与停止

2026-11-03 起支持独立 LaunchAgent 随 Orca 启停；本轮将原信箱看门狗的发送段接入事件队列。本机配置 `.osa/p4-live/supervisor-config.json`；系统任务 `com.orca-super-agent.osa`。状态见 `.osa/p4-live/supervisor.json`，日志见同目录 `supervisor.log` / `supervisor.err.log`。监测进程留在登录会话中等待 Orca；只在 Orca 存活且磁盘至少有 512 MiB 可用空间时运行 osa，崩溃后退避重试。完整机制和通用配置见 [README](../../README.md)。

**托管期间不能用单次 stop 作为持续暂停**，系统会恢复服务。需要暂停或维护时，在项目根目录执行：

```sh
rtk proxy node scripts/osa-supervisor.mjs uninstall --config .osa/p4-live/supervisor-config.json
# 恢复托管，保留原状态：
rtk proxy node scripts/osa-supervisor.mjs install --config .osa/p4-live/supervisor-config.json
```

查询状态，或在卸载托管后手动运行（路径 `/Users/mzg/orca/projects/Super-agent-orca`）：

```sh
rtk proxy node scripts/osa-service.mjs status --state .osa/p4-live
rtk proxy node scripts/osa-service.mjs stop --state .osa/p4-live
rtk proxy node scripts/osa-service.mjs start --state .osa/p4-live --repository /Users/mzg/orca/projects/Super-agent-orca --two-layer true --executor-model gpt-6.1-sol --max-executors 2 --feishu-chat oc_47566f4aacc97abe9ece0fa5efabd809 --watchdog-events /Users/mzg/.orca/watchdog/events
```

日志在 `.osa/p4-live/service.log`。启动器不会托管 Orca 或恢复电脑电源，不自动重启 worker。不要同时启动旧 `.osa/p3-live` 来监听同一群。服务重启不重派任务；旧状态迁移先备份。

## Router 重启

当前已有正式聊天，不要重复创建。只重启 osa 服务而 Orca 身份未变化时，绑定和消息队列保留。

Orca 本身或聊天/固定发送端重启、关闭后，核对当前 session、terminal incarnation 和 runtime 身份；不能复用旧 handle 猜测新身份。结构化会话使用 `router bind --session SESSION --terminal SENDER --lease TOKEN`。若必须重建，先编写具体交接，再使用：

```sh
rtk proxy node --experimental-transform-types bin/osa-router-chat.ts --state /absolute/state --repository /absolute/repository --sender EXACT_LIVE_SENDER --handoff /absolute/handoff.md
```

创建意图保存在状态目录 `router-chat-create.json`；结果不明原样重试对账。已有创建记录指向旧会话时先核对真实状态，不直接删文件重建。当前版本不会自动重建已失效的 Orca 身份；待办会保留并暴露异常，必须完成核验和重绑后才恢复后台唤醒。单独绑定终端不会退回向输入栏塞提示的旧行为。新聊天沿用现有 Claude Code 配置。

租约闲置 60 秒后允许接替，但原 Router 的 token 若仍是当前 token，下一条命令会自动续租。只有实际接替才使旧 token 失效；被替换的旧 token 即使等到新租约过期也不能直接写入。收到 `invalid or replaced` 时先核对所有权，不自动 attach 抢回。没有因租约过期而强杀旧 Router。原生提醒只唤醒，OSA `router wait` 才读取待办；两种信箱分别确认。结果不明先查回执，必要时显式 `router unbind` 再绑定，不把提醒恢复当作 Executor 重跑授权。

判断任务是否真正占并发名额，查看 `status.executionBindings[].holdsExecutorSlot`。业务未结或报告受阻，不能推导执行器仍占槽；`finished: true` 的派工已经释放调度名额。取消业务任务需用户授权，不能用超时或领域 `running` 字段自动取消来“解堵”。

## 尚未实现或未验收

P5 才处理多机常驻/接管。当前直接执行要求本机 Git 仓库已有可用基线提交；Super-agent-orca 仍有全部未提交文件，若要让它自身通过隔离 worktree 开发，需要先授权基线提交。普通文件夹、直接修改远程专有代码未验收；SSH 连接/部署须按具体任务授权。本轮没有修改业务代码、提交、推送或部署。

审查者已释放但原生 Dispatch 信箱留有 `delivery_a8b8b89f8101`；它只含审查补充说明，不影响运行任务。当前 CLI 无定向残留清理，不要为它全量 reset；看门狗只提醒该批次一次。所有具体证据见 [VERIFICATION](VERIFICATION.md) 和 [REVIEW](REVIEW.md)。
