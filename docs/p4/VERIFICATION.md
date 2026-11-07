# P4 验证记录

2026-11-02。范围：通用多项目管理、双入口接续、调度和跨组件目标、日常 Router。多机常驻、迁移和自动接管列入 P5，本轮不实现。代码已集成，真实主要验收、独立代码审查后的修复和最终回归完成；使用入口见 [RUNBOOK](RUNBOOK.md)，审查及处理记录见 [REVIEW](REVIEW.md)。

## 实现与检查

- 复用 Store 与 dsh-core，新增登记数据，不硬编码业务项目。项目→组件→位置；稳定 ID、重命名、归档、暂停、Orca 清单和 worktree 观察快照。
- 工单固定目标，执行、Git 工作区身份、审查和 Publisher 使用同一绑定。多 GitHub 来源只处理自己的消息，提交/推送仍需逐工单授权。
- 默认两个 Executor 槽；项目轮转、优先级和等待时间；共享资源互斥；暂停不停止已运行任务；显式恢复复用容量/资源门禁。
- 目标、子任务、依赖和独立联合验收；失败/停止不满足依赖；验收等待所有子任务，启动后冻结目标成员，防止旧验收变成新增工作完成的证明。
- 知识记录带来源、版本和项目/组件范围，替代保留历史。工单事实、项目决定、模型聊天分开。
- Router 租约及跨入口显式关联；重复关联幂等，外国来源/其他项目目标拒绝。普通管理查询用上游 answer 回复，不创建开发任务。
- 本地 start/stop/status 启动器，SQLite 进程锁及 PID 身份核对；明确绑定 Router 的终端、进程实例和运行时，原生持久 attention 唤醒，不向忙碌终端反复打字。

专项测试覆盖同名任务跨仓、目标冻结、重命名、知识隔离、依赖环/失败、联合验收、并发恢复、轮转和等待、资源冲突、发件箱隔离、丢失回执、终端身份变化、并发启动、旧 PID、孤儿子进程及重启。最终完整运行 13 个测试文件、293 项通过，类型检查通过；最后的旧输入默认话题兼容调整另通过全部 6 项 App 检查。

## 真实本地执行

运行状态：`.osa/p4-live`。两个无关示例项目 alpha/beta 使用从既有验收仓库创建的独立本地副本，不操作业务仓库。Executor 模型按用户选择使用 gpt-6.1-sol，审查为独立 Claude。

| 项目/任务 | 工单 | Executor Dispatch | 独立批准 |
|---|---|---|---|
| alpha，优先级 100 | `ad4d4502949190a7aae7c790604d5a72` | `ctx_e4c7617ca6f5` | `ctx_2f0d4ec28ba3` |
| beta，优先级 0 | `24f834e27bea72357a739ee29de24353` | `ctx_21db77598cba` | `ctx_510376e69c8b` |
| 联合验收 | `6a7e4f205afdeeb3fadc0479c6c8811a` | `ctx_210f65e629ee` | `ctx_c9e62b368a8b` |

alpha 与 beta 使用相同短名称 `p4-isolation`，落在不同仓库的独立 worktree，实际同时执行，证明不是只跑最高优先级。两个 p4.txt 分别严格为 `hello from alpha\n`（17 字节）和 `hello from beta\n`（16 字节），没有提交或推送。运行期间 Router 补充输入均有 Executor 已读时间；beta 还有真实原生消息投递/确认记录 `msg_2220f014bbc9`。

联合验收在两个前置任务原生成功结算、审查通过后才启动；它与独立 reviewer 分别读取两个产物，在自己的 `p4-joint/joint.txt` 记录路径、哈希和检查，最终目标为 `accepted`。所有执行 worker 和审查子 worker 均由各自协调者按先 release 后 ack 回收；测试 worktree 留存供检查。

验收抓到了真实集成缺陷：Executor 创建自己的子 Run 后，投递时强带旧父 Run 导致 `recipient_run_mismatch`。修复为按原 Dispatch 地址投递、由 Orca 确定当前信箱；仅明确被拒绝的旧调用可归档后重试，不重放结果不明的副作用。已补回归测试。审查 JSON 行不完整时程序拒绝接收，各 Executor 通过新的独立审查获取合法回执，没有修写或伪造旧审查证据。

服务在执行中多次正常重启，三个任务均只有一次实际 Executor 派工。证据保存在 `.osa/p4-live/parallel-evidence.json`、`acceptance.json`、数据库及原生 Run 中，不包含令牌的摘要可供复核。

## 真实入口与日常使用

指定终端 `term_c6043cc5-2113-4435-b961-aeab72508b06`，标题 OSA Router P4，邮箱 Run `run_474f64a7afdb`。首次启动按 TUI 就绪证据注入 Router 技能，此后由原生持久消息唤醒；已观察到 Router 结束一轮、空闲后因新消息开始处理，不依赖主协调者手动转发。

用户在原验收群发送「查询各项目进度，不创建任务」，无需 @。来源消息 `om_x100b61b3984bdd38ce4639efc1e7e9a`，内部 Trigger `0813ef2d94f369ce1ffb902ab613eb0c`；原生 attention `msg_9ec6fa89957b` 唤醒 Router。Router 查询持久状态，机器人在原话题回复；发件箱 `f76d3c3b59b92719cf122a8a9184595e` 已完成发送并核对身份、话题和内容。开发工单总数仍为 3，没有把查询变成开发任务。

独立读取飞书确认机器人实际消息 `om_x100b61b397a820acc0aab0db24f3f53`，话题 `omt_198df5a143169b48`；只有一条带该发件箱标记的回复。最终版本再次重启服务后无重复派工或新候选。

两向跨入口关联另有程序回归：飞书发起、Router 补充，以及 Router 发起、飞书补充，都维持单一工单。真实 P4 本轮只发送了上述管理查询，未冒用用户身份制造额外飞书开发消息；P3 的真实飞书创建→执行→原话题回传证据继续保留。

Router 自行处理和确认的消息 ID、原生 delivery、任务和项目摘要保存在 `.osa/p4-live/router-observed.json`。已登记真实项目 SoulShift、Super-agent-orca、智能客服（smart-cs-panel、game-ai-cs-report、客服 Hermes 核心），仅保存管理关联，没有改业务文件。其他历史仓库没有自动登记为可执行目标。

测试项目 alpha 经管理 CLI 改名为 P4 Archived Alpha，alpha/beta 均已归档，工单和已接受的联合目标保留。Router 正确拒绝把另一个 Agent 的普通原生 status 当作用户授权；这些登记验收操作由本实施会话在旧租约到期后通过已授权 CLI 完成，没有放宽 Router 的本人边界。

## 旧状态兼容

从 `.osa/p3-live/state.db` 用 SQLite `VACUUM INTO` 创建独立快照 `.osa/p4-p3-migration.db` 后迁移，原库未改动。原工单 `6cdeee51db49fd3510a55d0ecb711479` 的身份、任务数据、来源游标和全部 7 条外部操作回执不变；新增一个目标绑定。恢复一轮 Executor 后操作数仍为 7，无新派工、无通知。检查记录 `.osa/p4-live/migration-evidence.json`。

启动时对含旧任务、尚未迁移的状态先保存 `before-p4-*.db`，再事务迁移。旧发布授权只有在仓库和给定已验证账号匹配时补全账号，不能借迁移扩大授权。已经开始的旧任务加入目标指纹后需当前审查，不能复用失配批准。

## 边界

直接执行只支持有基线提交的本机 Git 仓库；可登记远程位置，但不伪装成可直接派工。SSH 继续由本地 Executor 按具体目标使用，未连接生产服务器。仅在远程存在的代码、非 Git 文件夹尚未验收。Super-agent-orca 当前文件仍未提交，登记可管理；要从它创建隔离执行 worktree，还需要用户授权的基线提交。

没有新增依赖，没有修改 vendor 的 15 份核心源码（与上游固定版本 `src/core` 逐文件一致），没有主项目 commit/push、业务部署或全局模型/看门狗配置变更。多个 Executor 各自的子 worker/reviewer 仍占额外机器资源，槽数不是模型进程总数。原生 attention 是持久提醒，不是已读；失去 Router 运行环境时待办仍保留，必须明确重新绑定，不承诺关机后继续运行。

## 2026-11-03 本机随 Orca 启停补充验收

用户明确授权后新增独立 LaunchAgent `com.orca-super-agent.osa`，复用 `osa-service.mjs`；原信箱看门狗未改。服务此前因 ENOSPC 退出，启动前 `PRAGMA integrity_check` 返回 `ok`，SQLite 在线快照保存在 `.osa/p4-live/before-supervisor-1793641916656.db`。

- `npm test -- tests/service.test.ts tests/supervisor.test.js`：2 文件、8 项通过。真实子进程夹具覆盖 Orca 开/关、孤儿进程、重复监督实例拒绝、崩溃后退避、磁盘不足停止/恢复、PID 重用拒绝、运行信息损坏时停止接单，以及 SIGTERM 安全退出。后续故障退避从 15 秒增至 30 秒，最高 300 秒。
- `npm run typecheck`、Node 语法检查通过；生成的 plist 经 `plutil -lint` 验证通过。
- 本机实际完成 install → 服务 ready → uninstall → 服务退出码 0 → install → 服务再次 ready。最终监督进程 PID 26236、启动器 PID 26288、osa PID 26298；这些是验收时快照，后续以实时状态为准。
- 原 3 张已完成工单及 3 个已释放派工保持原身份，无重复派工；Claude Router 的 terminal / incarnation / runtime 与原绑定一致，恢复后无 notice。

本轮没有真实退出 Orca 或重启电脑，以免打断业务窗口；Orca 生命周期及低磁盘故障用隔离夹具验证。没有测试断电、多机切换、运行中业务任务重启或 Router 换身份自动恢复；后者仍要求显式重新绑定。配置、状态和暂停方式见 [运行手册](RUNBOOK.md)。没有提交、推送或替换 Orca 应用。
