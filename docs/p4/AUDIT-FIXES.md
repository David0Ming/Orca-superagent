# 全量审查修复与验收（2026-11-03）

对应 [全量审查](../FULL-AUDIT-2026-11-03.md) 的 10 项发现。保留 DeepSeek 核心、SQLite、每个活跃工单独立 anchor/Run 和固定独立审查，不增加依赖。

## 修复范围

| 发现 | 本轮实现 | 验收证据 |
| --- | --- | --- |
| 1 准备期间取消仍启动 | 新启动前重新确认工单、assignment、调度门禁；已尝试启动继续核对回执 | `tests/orca.test.ts` 取消交错回归 |
| 2 问答协议缺口 | 接通 acknowledgement、attention、answers、askedBy、显式清除；答案摘要按问题编号保存 | `tests/app.test.ts` 问答与重放回归 |
| 3 审查跨 await 竞态 | snapshot/record/ready 与发布重新核对输入、身份、target 和批准记录 | `tests/review.test.ts`、`tests/publish.test.ts` |
| 4 来源间故障扩散 | 飞书逐话题、GitHub 逐对象独立入库；失败记录持久通知，保留游标重试 | `tests/feishu.test.ts`、`tests/github.test.ts` |
| 5 Router 回执掩盖离线 | 已唤醒仍每 15 秒复核同一终端身份和连接；状态显示 health | `tests/router.test.ts` 离线回归 |
| 6 慢启动阻塞监督 | 每个 assignment 独立异步处理，内部串行；全局循环继续收件与监督 | `tests/orca.test.ts` 阻塞启动回归 |
| 7 依赖证据缺失 | 无 goal 的 dependsOn 也提供目标、目录、执行、报告、审查信息 | `tests/projects.test.ts` |
| 8 每次新建目录 | `--workspace inspect` 使用仓库目录；`--continue-from TICKET` 明确续用结束工单的目录/分支并检查资源；普通写任务保持隔离 | `tests/orca.test.ts` 只读/续接、`tests/projects.test.ts` |
| 9 无完整删除流程 | Router 授权的 inspect → fingerprint → remove → Orca/Git/磁盘三方核对；保留任务/审查记录，失败结果不明不盲删重试 | `tests/cleanup.test.ts`；真实 Orca 一次性工作树验收 |
| 10 服务启动窗口过短 | 启动器 15 秒后返回仍存活的 starting；监督器给身份初始化最多 150 秒 | `tests/service.test.ts` 慢启动回归 |

## 使用变化

Router 技能已更新。工单尚未结束时，后续要求继续 `route attach`；新任务若继承已结束任务，显式使用 `--continue-from`，不靠“最近目录”猜测。续接保留目录、分支和结构化上下文；不保证恢复模型完整对话。只读模式是执行约定，不是操作系统文件权限沙箱，不能用于发布。

新建执行仍保留每工单独立身份和 Run；目录复用不等于多个活动写任务共享同一工作树，也尚未建立“按任务类别/功能域分配长期工作区、自动维护工程管理文件”的独立管理层。目录写入冲突受现有资源锁控制。

清理接口：`cleanup inspect --ticket ID --lease TOKEN`；只有 eligible 为 true，才可使用返回的 fingerprint 调用 `cleanup remove --ticket ID --fingerprint VALUE --lease TOKEN`。不会自动批量删除历史工作区。存在未提交/忽略文件、新提交、未知创建基线、保留终端、工单引用时拒绝删除。通过 Orca 原生删除工作树及其临时分支；不承诺保留分支。因此创建后出现任何新提交都会阻止此接口删除。

## 验证与证据

- 完整集成测试：15 个文件、322/322 通过（106.12 秒，`npm test -- --maxWorkers=2`）；`npm run typecheck` 通过。
- 用户指定的低成本辅助验证实际使用 `gpt-5.6-sol`，有效模型已核对；发现 2–4 的 81 项相关测试通过。报告 `.osa/full-audit-20261103/cheap-validation.md`。
- Claude Code 独立审查沿用现有模型配置。初次审查要求补修启动结果未知时的身份落库及取消边界；补修后复核为 approve，58 项定向测试通过。报告位于 `.osa/full-audit-20261103/independent-review-followup.md`。客户端名称不代表 Anthropic 模型身份。
- 真实 Orca 1.4.227：在已有 alpha 验收仓库新建一次性工作树；有 fallback shell 时 inspect 拒绝；确认其为空闲 shell 并关闭后 eligible；使用真实 cleanup 实现删除，Orca 列表、Git worktree 和目录都确认消失；该无新增提交的临时分支也被 Orca 删除。只采用隔离验收数据库，不伪造生产任务完成。回执 `.osa/full-audit-20261103/native-cleanup-result.json`。
- 原始审计失败夹具保留为历史证据；正式回归在 `tests/`，旧 `.audit.ts` 不是最终验收入口。
- 上游固定提交 `6337fc823ce20251c8de8085948165c81aaa701e`；vendor 核心不变。

## 独立审查后的补修

- 启动回执即使为 `outcome_unknown`，只要 Run/Task 身份吻合，也先保存 Dispatch；取消可停止对应原生 worker，不丢弃已发生的外部副作用。恢复启动同样处理，并允许结束工单核对已提交的恢复操作。
- 尚未发生 worker-start 的失败准备可收尾；没有 start 作业的取消可结束。身份不匹配或已尝试但无法核实的启动继续保留和告警，不能盲目关闭锚点或停止未知 worker。
- 失败作业增加 15 秒重试间隔；明确取消不受旧准备失败的退避拖延。
- 显式恢复等待已运行的同 assignment 处理轮次，再处理新恢复，避免误报 pending；`report ready` RPC 预算 180 秒，监督器 stop 预算 40 秒。
- 新增 6 项回归（包括首次启动被原生明确拒绝后的取消收尾）；结束工单上未核实的启动也保留 15 秒退避，避免高频核对。定向 Orca 测试 58/58 通过；另补首次启动原生拒绝的回归后，该文件 59/59 通过。类型检查通过。最后全量复跑曾出现 4 项默认 5 秒超时（318/322 通过），随后低并发复跑暴露启动观察循环在定时器跨过截止时间时未返回 JSON 的边界；已将截止判断收敛到循环内部的唯一出口，修正后以 `--maxWorkers=2` 完整复核，322/322 通过，未放宽测试超时或断言。

## 生效与边界

2026-11-03 11:53（本地时间）已重载常驻服务与监督器：supervisor PID 21916、launcher PID 21957、服务 PID 21975，状态均为 running。原 21 张工单、26 条派工记录全部保留，已有 Run/Dispatch 身份无变化；SQLite integrity_check 为 ok，Router 原绑定健康为 connected。Orca runtime 未变化，业务 worker 未因更新被关闭。快照与对比见 `.osa/full-audit-20261103/rollout-backup.db`、`rollout-before.json`、`rollout-after.json`。主项目没有提交或推送，没有删除历史业务工作树。

远程直接执行/跨机接管仍属后续阶段。历史工作区缺少创建基线时保守保留；本轮没有实现自动垃圾回收或自动归档所有产物。Orca“允许关闭人工操作窗口”的配套应用补丁仍未安装，本轮不重启 Orca 应用。


## 新反馈：系统消息占用 Router 输入栏（待实现）

用户报告原生 `You have 1 orchestration message` 和看门狗通知都会占用人工输入栏。已核对源码，不能继续声称使用原生信箱就不会写入终端：

- Orca 配套源码 `src/main/runtime/orchestration/mailbox-pointer-stage.ts` 的终端通道调用 `writePty` 写通知，`mailbox-pointer-submit.ts` 随后提交 Enter。
- 本机 `~/.orca/watchdog/orca-mailbox-watchdog.sh` 的 `nudge()` 使用 `terminal send --text ... --enter`。
- Orca 已有 `structured-mailbox-pointer-delivery.ts`，通过结构化会话的 send/queue 交付，不依赖 PTY。应优先验证既有 Claude 配置在该通道的兼容性；系统事件和人工输入分开排队，繁忙时合并通知，空闲时消费，保留消息 ID、确认、重启续收，人工编辑中的草稿不受影响。
- 看门狗应产生结构化运维事件，复用后台投递；无人可接收时显示通知/待办，不能自动 ack、取消工单或冒充人工消息。
- 终端模式如无可靠后台协议，不能承诺“完全不碰输入栏且能主动唤醒空闲模型”；需要配套 Orca/provider 支持，或迁移 Router 为结构化会话。不能只移除现有通知而导致飞书目标无人处理。

此项为本轮审查后新反馈，当前未切换 Router 会话类型、未修改看门狗、未安装新的 Orca 应用；上述是已核对机制的改进方向，不算本轮已验收功能。


## 新反馈：跨项目智能体与工作区备忘录（设计方向，未自动化）

已有 `Projects.context()` 按 project/component 筛选版本化知识并提供工单上下文；尚无每工作目录自动维护的工程备忘录流程。用户指出一个智能体会参与多个项目，因此记忆归属不能绑定智能体身份。

建议复用已有 AGENTS.md/工程文档：全局只放通用偏好，项目规则与已验证的常见卡点归项目，工作区特有环境/分支限制归工作区；每次执行按冻结的项目/组件/目录加载，写回也核对同一绑定。条目只保留“触发条件 → 做法 → 验证方式”，实时进度继续由工单管理，过期条目删除。已有知识注册表可保存索引、来源与摘要，避免与文档形成两份独立可变的规则。跨项目经验经确认后再提升到全局。

Router 读取索引和进度摘要；Executor 仅加载当前工单相关详细上下文。同一模型/智能体可复用，跨项目执行不能假设换 cwd 就隔离了同一长聊天中的旧信息；需要独立会话或受控重建上下文。此项与长期工作区管理共同规划，尚未修改各业务项目的 AGENTS.md。
