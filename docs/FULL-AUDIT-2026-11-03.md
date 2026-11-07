# 全量实现审查：2026-11-03

> 本文保留修复前的审计基线与原始发现；后续修复、验收和生效状态见 [修复记录](p4/AUDIT-FIXES.md)。下面的旧夹具和失败数量不代表修复后的现状。

结论：现有实现已经能完成 P1–P4 的主流程，但还不能视为可放心长期无人值守的多项目管理系统。此次确认 **10 项发现：4 项优先修复、6 项后续修复或补齐**。主要问题在外围适配、异步边界和资源生命周期，不需要推翻 DeepSeek 核心模型，也没有证据支持为了这些问题替换 SQLite。

本轮只审查、生成隔离复现和报告，没有修改业务代码、停止真实任务、操作客服工作区、发送消息、提交或推送。工作区复用方案保持待实现状态。

## 范围、基线与证据

- 审查对象是当前本地工作区，不是某个 Git 提交或 PR：项目内容目前仍未提交。
- 覆盖 `src/` 全部 9 个模块、`bin/osa.ts`、两个服务脚本、Router 技能、配置及相关测试，追踪接单→路由→任务绑定→启动/补充/取消→审查→发布/回传→释放与恢复。配套 Orca 补丁检查了设置、统一输入入口和释放保护的改动；未对整个 Orca 源码做全仓审查。
- 上游固定为 `deepseek-ai/dsh-superagent-prototype@6337fc823ce20251c8de8085948165c81aaa701e`。本地参考副本干净；逐字节比较确认 `vendor/dsh-core/src/` **15 个文件全部与上游相同**。没有把上游文档中的功能默认算作本项目已接入。
- 基线验证：`npm test` **14 个文件、300 项测试通过**；`npm run typecheck` 通过。这些测试没有覆盖下面新增的全部交错场景。
- 隔离审计：**9 个预期行为断言失败，确认 8 项发现**；飞书和 GitHub 两个复现归入同一项“来源故障隔离”。另外两项为持续工作与回收流程缺口，由代码和既有运行盘点确认。失败表示原实现不满足所写断言，不表示本轮改坏了业务代码。
- 本地证据目录：`.osa/full-audit-20261103/`。`manifest.json` 固定源码哈希与上游版本，`results.json`、`cancellation-result.json`、`startup-result.json` 保存原始结果（启动超时的具体错误和当时进程状态另见 `startup-evidence.json`），`evidence-summary.json` 保存九个失败摘要。夹具只操作临时 SQLite、临时 Git 仓库和模拟 CLI，不连接真实飞书/GitHub/Orca。
- 审计夹具使用 `.audit.ts` 后缀和独立配置；已用 `vitest list --filesOnly` 确认正常测试仍只有原来的 14 个文件。证据目录被 `.gitignore` 排除，不会随报告自动交付到远端。

修复前用于复现审计断言的命令（历史夹具，不作为修复后的验收入口）：

```sh
npx vitest run --config .osa/full-audit-20261103/vitest.config.ts -t AUDIT
```

这不是线上故障注入，也不是已经修复后的回归测试。

## 优先修复

### 1. P1：准备期间取消工单，仍会新启动 worker

**位置：** `src/orca.ts:442` 的 `launch()`，尤其是等待 anchor、Run、workspace 后到 `worker-start` 之间；对照 `recover()` 的类似异步边界。

**证据：** 隔离复现让真实工作树准备完成后、尚未调用 `worker-start` 时执行 `engine.stopTicket()`。工单已是 `stopped`，但模拟原生 CLI 仍记录 **1 次新 worker 创建**。现有测试覆盖“准备失败后取消”和“恢复回执丢失后取消”，没有覆盖这次交错。

**原因与影响：** 启动资格只在前段检查；异步准备返回后使用旧 ticket 继续派工。后续停止不能保证新 worker 在被停之前没有执行命令。这是授权撤回边界的问题，不只是多出一个窗口。

**最小修正：** 在提交新的 `worker-start` 前重新读取当前工单/assignment 与执行门禁。尚未提交的启动应终止；已经提交但回执不确定的启动继续走原有核对、停止流程，不能直接丢弃记录。检查初次启动和恢复两条调用路径。

**上游对照：** 上游在准备目录、获取 Session、等待旧任务停止等每个异步阶段之后调用 `current()`，实际投递前再次校验授权。[上游 launch](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L424)

### 2. P1：Executor→Router→用户的问答协议没有完整接通

**位置：** `src/app.ts:89` 的 report、`:121` 的 router wait、`:192` 的 reply；`bin/osa.ts:19` 的参数定义；Router 技能第 4–5 步。

**证据：** Executor `report waiting --question` 成功保存 attention；Router 尝试回传问题时，现有 `reply --ticket` 一律按 result 处理，报 `Ticket is not ready for delivery`。CLI 也没有 attention 的 purpose 参数。waiting/progress 提问不生成通知，`router wait` 不直接返回这些 attention。

**同一协议的其他缺口：** report 没有映射核心的 `answers`、`askedBy` 和显式 `question: null`；因此已经交给 Executor 的用户问题，无法按既有核心规则授权 Router 回复，也不能正常清空待回答问题。对原请求的 acknowledgement 入口也未接入。技能却要求遵循这套回答协议，并禁止手工绕过程序向远端回传。

**影响：** 用户在飞书等待决定问题或追问回复，而程序只有本地状态；Router 可能只能在自己的窗口描述，形成“用户没有回答，所以任务等待”的闭环死角。普通未关联任务的管理查询仍能回复，不能概括成所有飞书回复都坏了。

**最小修正：** 映射上游已有的报告和回复字段，并把需要人工处理的 attention 持久通知 Router；复用核心的准入、来源选择和发件箱去重，不另建问答系统。补充跨入口提问、回答、清除与崩溃重放测试。

**上游对照：** 这些能力已经存在于上游 Executor/主智能体工具和本地 vendor 核心。[Executor tools](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/tools/executor.ts#L76)、[Router reply](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/tools/main.ts#L224)

### 3. P1：审查校验期间的新输入可能沿用旧批准

**位置：** `src/review.ts:31` 的 snapshot、`:135` 的 assertReady；`bin/osa.ts:96` 附近 ready 提交流程；发布调用同一个 ReviewGate。

**证据：** 先记录有效批准，启动 `assertReady()`，在其 Git/文件异步读取期间追加一条新要求。预期旧批准失效，实际 Promise 成功返回。现有测试只覆盖“追加输入完成后再开始检查”。

**原因与影响：** snapshot 开始时读取 ticket/binding，此后跨多个 await 使用那份快照。校验结束到状态提交前没有同步确认输入范围仍然相同，因此有机会把没有覆盖新要求的工作标为 ready。复现证明门禁竞态，没有在真实仓库推送未审查内容。

**最小修正：** 异步检查完成后，在接受批准/ready 的状态提交边界重新核对当前 assignment、Dispatch 和输入范围；沿用现有字段与指纹内容。发布前使用同一有效性条件。不要靠多跑一次完整测试或延时规避竞态，也不要宣称此项能让任意外部文件系统修改获得原子性。

**上游对照：** 这里的“强制独立 Claude 审查＋文件指纹”是本项目增加的约束，上游没有可直接照搬的同等 ReviewGate。上游反复校验 current 授权的做法可参考，但不是已提供完整修复。

### 4. P1：一个坏话题/PR 可以阻塞同来源的其他新请求

**位置：** `src/feishu.ts:99` 的 poll；`src/github.ts:156` 的 poll。

**证据：** 两个独立复现：① 已保存的飞书旧话题根消息无法读取，新的一条有效本人消息没有进入核心；② 一个 PR 详情读取失败，同仓库另一个有效新 Issue 也没有进入核心。

**原因与影响：** 飞书先读取全部历史根话题和回复，再统一入库；GitHub 先读取全部相关 PR，再处理 intake。一项失败使整个轮次退出。持久失败的旧项会反复挡住后续请求，而不是仅拖延自己的线程。消息通常仍在来源侧，不应误称数据库已经丢失它们。

**最小修正：** 身份、账号、群/仓库范围校验仍全局失败关闭；独立线程的内容读取与提交则隔离，记录每线程错误和重试位置。坏项不推进自己的游标，也不阻塞不相关有效项。保留发送端已有的线程顺序与去重。

**上游对照：** 上游 `pollThreads` 已逐线程捕获失败并保存 pollError，另有坏项计数和失败读取的重试记录。[共享轮询实现](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/sources/poll.ts#L19)、[GitHub 来源](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/sources/github.ts#L297)

## 后续修复或补齐

### 5. P2：Router 唤醒回执掩盖之后的失联

**位置：** `src/router.ts:83`；`status()` 返回保存的绑定和 attention，没有实时存活结论。

**证据：** 成功发送一次 attention 后，让绑定终端断开；待处理内容不变，后续 tick 不产生失联 notice。原因是有 receipt 就在 identity 检查之前返回。新工作改变 fingerprint 时可能重新检查，故不是所有情形永久不可恢复。

**影响：** 系统知道曾经送达提醒，却不知道 Router 是否仍可处理这些工作。服务进程健康、消息回执存在，都不能证明待办正在推进。

**最小修正：** 保持消息去重；独立、节流地检查仍有待办的 Router 绑定，公开“待判断/绑定失效/最后确认时间”。恢复绑定仍显式进行，不自动抢租约或把未完成任务重派。

另有同路径提示矛盾：唤醒正文要求每次先执行无 token 的 `router attach`，而现有有效租约会拒绝这种调用；技能正确要求沿用已有 token。更新提示应一起校正，但不能把本项简单解释成旧的 60 秒租约 bug 又出现了。

**上游对照：** 上游经持久 Session/effect relay 投递；本项目使用 Orca 原生邮箱提示，需要自行补足绑定存活与未处理状态，不能把原生 send receipt 当作 Session 处理完成。[上游 Sessions](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts)

### 6. P2：慢启动会拖住其他 Executor 的监督和收件

**位置：** `src/orca.ts:223` 的 runTick；`:290` 的 CLI 最长 120 秒等待；`bin/osa.ts:164` 的执行循环。

**证据：** 隔离夹具挂住一个 launch，另一个运行中 binding 的 poll 在 launch 释放前调用次数为 0。代码顺序是所有 recovery/job 逐一 await，之后才轮询各 binding。

**影响：** “两张工单并行”只保证 worker 可以同时运行，监督循环仍可能被另一张工单的启动命令阻塞；已完成消息确认、释放和停止动作被延迟。来源轮询已经从该循环拆开，因此不应误称所有网络来源同时阻塞。

**最小修正：** 将不同 assignment 的慢外部操作与监督分开、受限并行；同 assignment 的操作仍串行，同步保留并发槽，沿用 operation 回执，避免简单全量 Promise.all 导致超额启动或重复操作。

**上游对照：** 上游已有按 effect 类型的并发限制和同步 WorkerSlots 预留。[上游 Executor](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L166)

### 7. P2：前置任务能解锁后续任务，却不一定交付前置证据

**位置：** `src/projects.ts:117` 的 blocked/successful 与 `:148` 的 context；`src/app.ts:89` 的 read。

**证据：** 同项目 A→B，仅设置 dependsOn、不设置 goal，这是合法配置。A 有成功报告和产物路径，B 的阻塞条件解除；但 B 的 context 仅包含前置 ID，不含 A 的报告和产物路径。隔离断言找不到 `/isolated/prior/output.json`。有共同 goal 的任务会取得 goal children，不属于该复现。

**影响：** B 能开始，却可能不知道应消费哪个成果。普通 Executor 也没有跨 ticket 的 read 权限，不能要求它自行绕过权限读数据库。补充 prompt 或人工粘贴可以暂时绕行，但不是完整依赖交接。

**最小修正：** 在 context 中返回显式依赖所授权的最小证据：目标、完成报告、审查/执行身份和已有产物引用。只扩展现有读取，不建立全局记忆库，不开放任意跨项目访问。

**上游对照：** 多业务项目、goal、依赖验收是本项目扩展；没有找到上游同等项目 DAG 交接实现。这里不能仅靠复制上游修复。

### 8. P2（功能缺口）：持续工作被过度拆成新工单、新工作树

**位置：** `src/orca.ts:398` 的 workspace、`:181` 的 verifyWorkspace；Router 路由/任务组织约定。

**运行证据：** 2026-11-03 10:13（UTC+8）既有快照记录 Orca 在册工作区 43 个：明确于 11 月 2 日创建 7 个、11 月 3 日创建 14 个，22 个缺少明确创建时间。不能把 43 都称作“昨天新建”，也不包含已经删除的历史项。14 个业务工作区都属智能客服 Hermes，均未关联 goal；七鱼连续目标占其中 6 个。详见 [生命周期盘点](ORCA-RESOURCE-LIFECYCLE.md)。

**准确边界：** 同一 ticket 已有 execution.directory 时会复用，两个真实 ticket 各有两次 assignment 却仅一个目录。因此不是“完全没有持久目录”。问题是所有新 ticket 强制创建 `--no-parent` worktree；不同 ticket 不能直接复用已有目录。新的 assignment 也没有显式接续原模型 Session 的适配，而主要依赖持久报告和重新 read。

**影响：** 把连续排障拆成新 ticket，会丢失自然的目录和会话连续性；只读/运维目标也付出创建代码工作树的代价。独立目录中的未提交成果不会自行出现在下一个目录。

**最小修正方向：** 先让连续需求正确 attach 原工单，明确重开/续接规则；完善第 7 项交接；再按真实任务类型允许适合的准备方式。确需跨工单共用目录时，才补显式绑定与互斥。每工单独立身份和 Run 的 P0 约束保持不变，本轮不迁移目录。

**上游对照：** 上游是每 ticket 的持久 Session＋目录；prepare 命令可配置，默认创建目录，不强制每次 Git worktree；后续 assignment 复用 Session。未找到上游完整的跨 ticket 共享工作区或自动垃圾回收方案。[目录准备](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L247)、[Session 接续](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L440)

### 9. P2（功能缺口）：任务结束没有完整的工作树回收结果

**位置：** `src/orca.ts:567` 的 poll/closeAnchor；`docs/ORCA-RESOURCE-LIFECYCLE.md`；配套 Orca 补丁。

**证据：** 当前结束流程调用 worker-release、确认消息、关闭 anchor，没有调用工作树归档/删除。原生返回 retained 和 released 都被归为 `binding.released = true`。盘点的 14 个业务目录中，12 张工单已 completed/stopped，但所有目录仍在。其 Git 内容、忽略文件和外部引用没有逐个检查，不能据此宣称这 12 个都应删除。

**影响：** 工单结束、调度槽释放、终端保留、目录保留混在使用体验里；磁盘与侧栏持续累积，用户无法从 finished 判断还剩什么资源。此前窗口关闭开关是源码补丁，尚未安装到当前 Orca，也不能解决工作树回收。

**最小修正方向：** 先生成框架自有资源的只读回收清单和保留原因；分别记录终端 release/retain、工作区归档、Git worktree/分支结果。保护未提交/未追踪/忽略产物、未合并提交、活跃使用者和证据引用，再复用 Orca 原生删除流程；禁止按年龄、finished 或“短任务”直接强删。

**上游对照：** 在审查的固定版本中未发现可直接搬用的完整工作树回收流程。Orca 原生 release 与 worktree rm 是不同能力，需要本项目明确衔接，而不是再造一个全盘删除守护进程。

### 10. P2：启动就绪预算与依赖超时不匹配

**位置：** `scripts/osa-service.mjs:88` 的 15 秒 readiness 等待，`scripts/osa-supervisor.mjs:108` 附近异常处理；`bin/osa.ts:122` 起的来源身份初始化。

**证据：** 临时 service fixture 仅需 16 秒正常输出 ready，launcher 就先返回 `Service readiness unconfirmed`。独立断言已复现。Supervisor 对此异常执行 stop；该停止路径由代码追踪确认，本轮没有让真实服务故意慢启动。

**原因与影响：** GitHub/飞书发现命令各允许等待 60 秒，且在输出 ready 之前执行；launcher 仅等 15 秒，supervisor 命令超时又是 25 秒。正常但较慢的认证/网络初始化可能反复被终止并退避，始终无法启动。

**最小修正：** 对齐启动总预算，区分 starting、已确认 failed 与身份不明；保留单实例和 Orca runtime 校验。不要只增加最内层 CLI 超时或在未确认 ready 时宣称 running。

**上游对照：** LaunchAgent＋Orca 启停跟随是本项目平台适配，没有对应的上游服务脚本可直接复制。

## 已有实现中应保留的部分

- 核心模型保持原样；SQLite WAL、FULL 同步、事务与持久 effect intent 对单机单主服务是合理选择。此次没有发现需要改用另一种数据库才能修复的问题；多机同时打开共享 WAL 不在已承诺范围内。
- 本人/指定来源过滤、冻结 ticket target、跨仓发布校验、review parentage/Claude 身份/真实 worker_done 验证有实际实现和测试，不应因存在竞态就全部重写。
- 不确定外部副作用保留回执并核对，超时不直接认定进程退出，正常完成不粗暴 stop；这些恢复原则继续保留。
- 60 秒租约已有“原 token 未被替换即可续用、替换后旧 token 永久失效”的修正，相关测试通过；不是本次新发现的未修问题。
- 调度已支持多个项目、有限并发、项目轮转、优先级与等待时间、共享资源限制；不应描述为“只跑第一优先级”。第 6 项是监督延迟，不等于并发功能不存在。
- 知识有显式项目范围和版本替代，goal 有独立联合验收条件。没有证据支持新增一个全局向量记忆系统；先修复依赖证据和持续任务接续。

## 集成修复顺序

先修 1–4，补对应竞态和协议回归；再修 5、6、10，验证 Router/服务恢复与长操作不会阻塞监督；然后一起处理 7–9，让任务接续、证据继承、目录使用与回收形成完整流程。

修复以几个完整主题集成验收，不为每个小补丁分别推送部署。优先复用已有核心字段、Orca API 和任务记录；不引入新数据库、额外管理 Agent 层或另一套调度框架。用户要求本轮审查，因此这里仅给出修正建议，没有开始实施。

## 检查边界与剩余风险

这次“全量”指本项目现有实现的模块和端到端流程审查，并不证明没有其他缺陷。没有重新发送真实飞书/GitHub 消息、创建真实 PR、停止/重启生产 worker 或验证 SSH 远端副作用；线上可触发性由明确条件限定，不能把隔离复现当作某次历史事故的已确定根因。

没有重新运行完整 Orca 源码测试/构建，也没有安装签名应用或验证真实窗口点击后关闭。此前补丁的 197 项测试与构建结果属于历史验证，见 [补丁说明](../patches/README.md)，不是本轮新跑结果。

本地 ReviewGate 只证明其覆盖的 Git 工作树内容和输入范围，不能证明远程机器、忽略文件或目录外产物未发生变化；这是已声明的能力边界，不能用本地 ready 宣称任意远程部署已验收。跨机器常驻/自动接管、附件处理、自动模型择优均不因本次审查新增为必做需求。

未做长时压力测试、全量磁盘历史归因、逐工作树产物盘点或依赖安全漏洞扫描；没有断言个人规模下已出现数据库性能瓶颈。当前四项 P1 仍未修复，在实施前应继续由人关注待处理问题、取消结果和新要求的验收范围。
