# Router 注意力与持续推进：架构调查

调查日期：2026-11-03。只读调查；未修改服务、业务任务或生产系统。

## 结论

存在三种叠加失效：控制面结算/投递不一致、聊天线程与业务任务混用、Router 把补充要求和授权修订当普通文本。更换模型或增加槽位不足以解决。复用现有 SQLite、工单、输入回执和按 assignment 并行的执行器即可；暂不需要新调度框架或更多管理 Agent。

## 证据范围

- Claude 原始会话：`/Users/mzg/.claude/projects/-Users-mzg-orca-projects-Super-agent-orca/e4746936-458b-4d05-b580-2c73af0dddc1.jsonl`。下列 L 为原始 JSONL 行号，时间为 UTC（本地加八小时）。
- 当前仓库源码，包括 `src/{app,orca,router,store,projects,watchdog}.ts`、`bin/osa.ts`、`scripts/install-watchdog-queue.mjs`、`vendor/dsh-core/src/{intake,assignments,replies,stage}.ts`。
- 2026-11-03 10:13 UTC 以 SQLite mode=ro 查询 `.osa/p4-live/state.db`。这是服务已保存的观察，不是独立对每个 Orca 进程重新验活。
- 当前源码不能证明会话发生每一刻运行的版本完全一致；历史实例以会话及持久记录交叉核对。

## 已证实的问题

### 1. 执行结算卡住，连带阻塞补充消息与无关任务

状态快照里六个 binding 均 finished=false。包括业务已被停止的旧分支工单 `8a11329a`，其观察为 abandoned；另有 FAQ `27623fbb` 和在线恢复 `fdf9e36c`：投递错误分别明确原生 Dispatch 为 failed / completed，且不会再读取旧邮箱；两者 poll 都报 consumer_fenced。新质检任务 `707adced` 排队理由为 Executor capacity reached。

源码链路：

- `src/orca.ts:226` 以 !finished 计槽位。
- `src/orca.ts:632` 主要通过邮箱 worker_done 取得 settled；随后 release、ack、closeAnchor，最终设置 finished。
- `src/orca.ts:576` 仅在 binding.settled 且 finished 后给迟到输入创建下一次派工；若本地 settled 未更新，仍向旧 Dispatch 发消息。
- `src/orca.ts:294` 的 observe 能观察原生状态，但主要保存观察和产生通知，不修复上述结算断层。

因此“原生任务已经结束，OSA 仍占槽且继续投旧邮箱”是实际存在的控制面不一致。consumer_fenced 为何发生还需追溯 Run 归属变化，不能凭错误推定可直接抢回或强制释放。

### 2. 聊天线程被误用为业务任务边界

会话 L975、L1067、L1166 明确记录 FAQ 被混入在线恢复和日报工单，之后靠重登记和更正消息补救。

`vendor/dsh-core/src/intake.ts:36` 遍历线程订阅，向全部相关工单 fan-out；已有 owner 时不再进入新需求判定。这个设计适合专属 Issue 线程，不适合承载多个业务目标的管理聊天。

`src/app.ts:138` 已支持省略 --thread 时生成 request:<id>；但 Router 技能第 2 步要求使用 CONVERSATION，诱导所有任务共享线程。最小改法优先在 Router 入口采用每条请求独立路由，再显式 attach；不要直接破坏 GitHub/飞书专属话题的既有订阅语义。一条消息包含多个意图时，须保留原消息与子意图的对应关系。

### 3. 错误依赖与过度收紧授权制造停顿

- L1166：把 FAQ 验证设成在线恢复成功后的任务。L1594 用户纠正领域边界；数据库仍保存旧票的 dependsOn，L8e33fe3f 停止原因也确认该依赖错误。
- L1552：容器没有 ps，被 Router 的“任一步失败即停”限制卡住；先前本地镜像构建也出现同类情况。
- L4031：所有者已登录并授权继续，但初始派工仍写“只做阶段一”，执行者按旧约束停下。
- 日报 `14f75f3d` 07:10 的 waiting 报告明确补跑完成、常态运行未恢复；直到 08:18 才建立后续恢复任务，间隔约 68 分钟。用户 L3332 追问“1在等什么”。期间 Router 在处理其他工作，不是整个系统都停了。
- L4260：用户已要求更新飞书群报告，Router 自行增加“先拟稿、再确认”的门槛。

这些并非统一的“需要更聪明模型”，而是当前有效授权没有独立版本与执行确认，Router 自加的限制和旧文本都能继续支配执行。

### 4. 已读回执不足以证明要求被采纳

已有 intake / delivery / ack，且 `src/app.ts:111` 校验输入归属，值得保留。但 ack 只表示已读，没有逐项“已纳入计划 / 已完成 / 被替代 / 有具体阻塞”的处理记录。

L3886 用户指出服务器访问方式早已提供。L3988 Router 承认默认 SSH 尝试失败后误判为缺权限，调整身份参数即成功。这一例是信息提取和诊断错误，不是传输丢失。L4074 的渠道补充被转达，不能说所有补充都被忽略。

### 5. 通知过多，可靠推进却仍靠临时监听

会话 L1149 创建 /tmp 一次性脚本，每 30 秒取全量 status；任意关注任务状态或报告时间变化即退出，再由 Router 手工重新挂起。后续大量 Re-arm watcher 通知，且有过期监听回声（L4352）。没有证据表明该脚本必须等所有任务完成，它的判断是 any-change。

补充核对（用户指出的指令来源）：当前 `/Users/mzg/.claude/CLAUDE.md` 的“任务推进”明确将“派任务必挂监听”等规则迁至 OSA Router skill，不再在全局重复。`skills/super-agent-router/SKILL.md:63` 则明确要求：

> Every dispatch — subagent, extra window, background command — must be armed with a completion watcher in the same turn. No watcher, no dispatch.

因此，手工监听不能仅归因为模型习惯：这条强制规则会促使 Router 为每次派工补挂 watcher；它还覆盖 background command，若把监听命令本身也视作需要监听的后台任务，存在继续叠加监督的风险。这是文本可能造成的歧义，不是已经证实发生了递归监听。技能没有明确要求使用 /tmp 脚本或每轮手工 re-arm；具体实现仍由模型选择。当前全局偏好与 skill 是转引关系，不能描述成两份同时重复执行的规则。

应保留“派工必须有持续监督、完成后主动报告”的用户意图，将机制改写为：优先确认现有服务已持久接管该 Dispatch 的监督；同一 Dispatch 只设一个监督责任方；不为已覆盖任务额外挂临时轮询；监督程序本身不递归创建监听。只有现有服务不能覆盖时才建立有明确截止和交接方式的临时监听。服务闭环通过验收前不能直接删掉现有监听，否则会失去仅剩的完成通知。本次只补调查报告，未修改用户偏好或 Router skill。

服务本来已有 RouterWake；但 `src/router.ts:89` 在相同待办已有发送回执时不会因未处理超时自动再提醒。发送成功与业务被处理之间缺少监督。

`scripts/install-watchdog-queue.mjs` 把 now/900 加入事件 identity，同一个未解决问题每 15 分钟成为新事件；`src/router.ts:83` 对完整内容做 hash，增加时间字段也会变成新 attention。

不要照搬会话中“answer 永远存在”的结论：`vendor/dsh-core/src/replies.ts:87` 在正确发送 answer 后会移除 ticket.answers。需要检查消费是否完成，而非简单删除答复通知。

## 优化顺序与验收

| 顺序 | 最小完整改造 | 验收场景 |
|---|---|---|
| P0 结算恢复 | 在 OrcaExecutor 增加精确 Dispatch/Run 身份的结算对账；明确区分成功、失败、abandoned、未知；恢复 fenced 消费者前核验归属；确认子资源结束后才释放容量；迟到输入转当前或下一有效派工 | worker_done 丢失、consumer_fenced、Dispatch 已终态却有迟到输入、服务重启；无重复执行，无静默丢输入，不误释放活跃写入者 |
| P0 请求归属 | Router 入口先持久登记，明确 new/attach/query/correction；聊天 ID 只作回复地址，不隐式决定归属；复用 request:<id> 与 route attach | 同一消息三个需求各自路由；后续一个补充只到目标票；重放不重复派工；GitHub/飞书专属线程行为不退化 |
| P1 要求闭环 | 基于现有 trigger/input 记录当前要求版本、被替代关系和处理状态；read 返回当前有效约束与未处理增量；报告带处理到的版本，结算时拒绝遗漏新约束 | 执行中补渠道口径、阶段一改阶段二、撤销旧限制；旧审查不得覆盖新要求；有未处理补充不能宣告全部完成 |
| P1 持续推进 | 复用服务 pulse，逐工单检查目标尚未完成且无下一动作；waiting 要有明确等待对象、责任人和复查时点；可恢复技术错误在原授权内继续 | A 等人工登录时 B 立即推进并独立汇报；部分完成不得永久停在 waiting；不把正常长任务当失败重跑 |
| P1 通知收敛 | 同步调整 Router skill 的“每次派工必挂 watcher”为“确认唯一持久监督责任方”；事件按对象+条件+代次去重，观察时间不作为身份；分别记录已送达、已消费、已处理；未处理按期限升级；常规进度按任务发送增量 | 同一残留只保留一个未解决事件；消费者崩溃后可重放；某任务完成立即汇报，其他任务不用等；不再依赖 /tmp 手工 re-arm |
| P2 状态表达 | 从现有 business report、原生执行态、binding、queue reason 派生状态；展示最新实质进展、下一步、阻塞对象及要求版本差距 | 业务未在线时不能只报“在线运行中”；已终态但待回收可见；无关任务排队能定位到具体资源或容量 |

依赖必须指向具体前置产物/资源，并写明缺失时哪一步不可执行。仅最后发布需要整体验收时，只给发布关卡加依赖；独立实现、验证和汇报继续推进。集成发布偏好不应被解释为“等所有无关工作一起推进”。

授权版本不是扩大权限：保留原始所有者消息、作用域与替代关系；若确实涉及新风险或不同外部动作，只阻塞相关动作，继续已经授权且独立的部分。

## 实施边界

先做 P0，并用故障注入回归验证后再接入活跃工作线。继续使用现有 SQLite / Orca / 按 assignment 的执行队列；不新建消息中间件、不为每个业务目标先增设管理 Agent。当前主循环使用 pulse 按 assignment 并行，没有发现“必须等待全部 worker 一起完成”的全局执行屏障。retryTicket 中调用全局 tick 的等待仍值得单独缩小范围，但不足以解释全部观察。

本轮没有改代码、重启服务、释放槽位、重派任务或联网研究通用框架。尚未独立验活每个原生进程，也未复现 consumer_fenced 的首次起因；运行状态快照会随服务继续变化。修复时禁止用直接改 finished 或重发生产动作来绕过不确定状态。
