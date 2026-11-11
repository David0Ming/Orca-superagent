# Orca Super-agent 实施方案

> 状态：P0、P1、P2、P3 已通过；验证记录见 `docs/p1/VERIFICATION.md`、`docs/p2/VERIFICATION.md` 和 `docs/p3/VERIFICATION.md`。P4 第一版已实现，审查修复后 293 项测试与类型检查通过，见 [P4 验证](p4/VERIFICATION.md) 和 [设计方案](P4-MULTIPROJECT-PLAN.md)。用户将多机常驻/自动接管放到 P5。参考上游：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) @ `6337fc8`（MIT）。

## 1. 已拍板的决定

| 决策 | 结论 |
|---|---|
| 使用者 | 个人使用。准入白名单只有本人在各来源的账号 |
| 目标入口 | GitHub、飞书（后续可扩展），加一个 **Router 窗口** |
| Router 窗口 | 不限 Agent 种类（Orca 里开的、普通终端里开的都行），但职责受限，并声明自己是 Super-agent 的 Router |
| 前半段实现 | 复用 DeepSeek 核心层（`src/core`，约 2100 行，不依赖 DeepSeek Harness），自己写存储、来源、Orca 执行器三类适配 |
| 执行侧 | 两层：Executor 作为 Orca 协调者，可以拆子 worker（跨模型），交付前固定派另一个模型做独立审查 |

## 2. 整体结构

```
 来源                         常驻服务 osa（程序：状态和路由）             Orca（执行）
┌──────────┐  触发   ┌─────────────────────────────────────┐
│ GitHub   │───────→│ 入库去重 → 讨论串 → 准入(只认本人)     │
│ 飞书     │───────→│        ↓            ↘ 订阅分发          │
│ Router窗口│───────→│   待判断卡片     已有工单的后续消息 ───┼──→ 送达运行中的 Executor
└──────────┘        │        ↓ (Router 窗口领取并判断)       │
      ↑             │   工单 + 授权范围 → 派工 ─────────────┼──→ orca worker-start
      │             │                                       │      Executor(协调者)
      └── 发件箱 ←──│ 回报(就绪/受阻/等人/失败/无需处理)  ←──┼──    ├→ 子 worker (codex)
        (重试/保序) │ SQLite：触发、讨论串、工单、派工、发件箱 │      ├→ 子 worker (DeepSeek)
                    └─────────────────────────────────────┘      └→ 审查 (claude)
```

分工原则（沿用上游的教训）：**去重、关联、派工记录、对外回复全部由程序完成，大模型只负责「接不接」的判断和执行本身。** 每个决定先写库，再执行。

## 3. 模块来源

| 模块 | 来源 | 说明 |
|---|---|---|
| 领域核心：触发、讨论串、准入判断、工单、授权、派工、订阅 | **复用** 上游 `src/core` | 原样放进 `vendor/dsh-core/`，保留许可证和上游提交号；只通过它的接口接入 |
| 存储 | 新写 | Node 22 自带的 sqlite，表结构参照上游文档 007 的持久化一节 |
| 策略（准入） | 新写，极简 | 每个来源一个「本人账号」白名单；主动规则先不做（上游的观察/自动模式都关着） |
| 来源：Router 窗口 | 新写 | 窗口里的输入一律视为本人的明确请求 |
| 来源：GitHub | 参照上游 `src/sources/github*` 改写 | 通过 gh 轮询通知、Issue、PR、CI |
| 来源：飞书 | 参照上游 `src/sources/feishu*` 改写 | P3 再做 |
| 执行器 | 新写「Orca 执行器」 | 派工启动 → `worker-start`；送达后续消息 → `orchestration send --to dispatch:<id>`；停止 → `worker-stop` |
| 进程监督、存活、恢复 | **Orca 原生** | 不重复开发 |
| 子 worker 拆分、独立审查、多模型 | **Orca 原生** + Executor 提示词 | 子 worker 用 Orca 的 Run 和任务，模型用 `--agent` 和 `--model` 指定 |
| 面板 | 不做 | 用 `osa status` 命令列出等你处理的事 |

## 4. Router 窗口

上游的「主会话」是平台里的一个固定会话，消息会被推进去。我们要求任何 Agent 都能当 Router，所以改成**命令行拉取**：

```
任意 Agent 窗口
  1. 加载 osa-router 技能（声明身份 + 职责边界）
  2. osa router attach        → 领取 Router 租约（同一时间只能有一个 Router）
  3. osa router wait          → 阻塞，直到有待判断卡片、回报或后续通知
  4. osa route accept|attach|stop|ignore ...   → 做决定
  5. osa reply ...            → 需要时回复你
  6. 回到第 3 步
```

- **职责边界**照搬上游 `prompts/orchestrator.md` 和 `prompts/dispatch.md`：只判断、路由、回复，不读代码，不写实施计划，不替 Executor 做技术决定。
- **边界由谁执行**：路由和授权由 `osa` 服务做硬校验，比如不在白名单的触发不能被接单、已停止的工单不能附加消息。「不读代码」这类约束只能靠提示词，因为我们管不了任意 Agent 的工具。这一点在文档里如实写明。
- **你直接在 Router 窗口里说话**也算一个来源：Router 用 `osa intake "<你的话>"` 录入后，走同一套判断流程，不走捷径。
- **租约**：Router 窗口关掉或卡死后，租约超时释放，下一个窗口执行 attach 就能接手。未处理的卡片留在库里，不会丢。

Executor 同样通过命令行使用上游的 6 个执行器工具：`osa read`、`ack`、`report`、`thread unrelated`、`thread follow`、`handback`。

## 5. 执行侧（两层）

```
工单 → 派工 → Executor（Orca worker，独立 worktree）
               │ 读上下文、判断范围、决定是否拆分
               ├─ 小改动：自己做
               ├─ 大改动：在 Orca 里再起子 worker 并行（跨模型）
               ├─ 交付前：固定派另一个模型做独立审查 → 打回修复，最多 N 轮
               └─ osa report ready|blocked|dropped|failed（带 PR 号、跑过的测试、风险）
```

- 一张工单对应一个 Executor 和一个 worktree，分支名等于工单短名（沿用上游规则，用来把 PR 关联回工单）。
- 回报分两层：工单状态（进展、就绪、受阻、失败、无需处理）用 `osa report`；Orca 进程层面的收尾仍用 Orca 的 `worker_done`。
- 第一版的模型分工先写死：codex 写代码，claude 做审查。等派工效果记录攒够了，再做「按任务选模型」。

## 6. 阶段与验收

### P0 技术验证（4 项相互独立，可以并行）

| # | 要验证什么 | 验收判据 |
|---|---|---|
| A | 一个不在 Orca 终端里的普通进程，能用 `--run` 参数建 Run、启动 worker、阻塞等待并收到 `worker_done` | 脚本输出收到的 worker_done 消息，Run 状态为已完成 |
| B | 嵌套深度：Orca 允许调整，默认 1 层（worker 不能再起子 worker）。找到设置入口，调成 2 后验证 worker 里能再起子 worker | 默认值下拿到 `nested_worker_depth_exceeded`；调成 2 后子 worker 成功回报；文档里写明设置方法 |
| C | 给运行中的 worker 送后续消息（`send --to dispatch:`），worker 能在检查点收到 | worker 的输出里出现这条消息的内容 |
| D | 上游核心层脱离 DeepSeek Harness 单独编译，并通过核心测试 | 拷到 vendor 目录后类型检查通过，核心测试全部通过 |

**B 不通过时的退路**：执行侧改成扁平结构，由 `osa` 服务替 Executor 去起子 worker，Executor 通过 `osa spawn` 提出申请。

#### P0 结论（详见 docs/p0/）

| # | 结果 | 对实现的影响 |
|---|---|---|
| A | 通过，但需要一个变通 | Orca 要求每条命令都属于某个终端：osa 先开一个空闲的「锚点终端」作为身份，之后的命令都带上它的句柄。重启后开一个新锚点，用 `run-use` 接管原来的 Run。工作区要写成 `path:<仓库路径>`，不能写 `current` |
| A+C | 一个身份同一时间只能绑定一个 Run | **每个活跃工单单独一个锚点和一个 Run**。Executor 要起子 worker 时，也得先建自己的 Run |
| B | 通过。默认深度 1 时被拒绝；改成 2 后，两层 worker 的完成回报都送到了最外层 | 部署说明里写上：设置 → Orchestration → 嵌套工人深度 ≥ 2（只能在界面里改）。Executor 要先建自己的 Run，再起子 worker |
| C | 通过，补发的消息约 4 秒送达 | Orca 不提供「已读」：Executor 每处理完一条后续消息，要回一条带原消息编号的确认，osa 收到后才标为已读 |
| D | 通过，144 项测试全部通过，没有外部依赖 | 存储接口是同步的，要用 Node 自带 sqlite 的同步接口；上游的内存版存储可以直接拿来做测试 |

### P1 最小闭环

存储 + 只认本人的准入 + Router 窗口来源 + Orca 执行器（单层）+ 发件箱（回复先只回 Router 窗口）。

验收：在 Router 窗口提一个小目标 → 生成工单 → Orca worker 完成 → 回报就绪 → Router 窗口收到结果。**中途杀掉 osa 服务再启动，不会重复派工，也不会重复回复。**

### P2 GitHub + 两层执行

GitHub 来源、订阅、PR 跟踪、Executor 拆子 worker、独立审查。

验收：你在 Issue 里提目标 → 生成 PR；你在 PR 上评论 → 评论自动送达 Executor（不用再 @），Executor 修完后更新 PR；审查不通过时 Executor 会收到打回意见。

### P3 飞书 + 监督策略

飞书来源；超时、重试、上游那套恢复规则（重启后带恢复提示重新派工）；记录每次派工用了哪个模型、结果如何。

验收：飞书里提目标，结果回到同一个话题；人为卡死一个 worker，系统能识别并按规则恢复或请你决定。

### 以后再做

P4 先落实统一多项目管理、跨入口接续、跨组件任务与日常运行，详见 `P4-MULTIPROJECT-PLAN.md`。一套服务管理业务项目和组件，复用 Orca 项目/工作区；远程操作第一版优先在本机 Executor 中使用 SSH，暂不建设跨机器派工。

协作优化、按任务自动选模型（需要 P3 记录的数据）、主动规则、面板。

## 7. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 上游是研究级代码，作者说明可能有 bug | 复用的核心层出问题 | 只复用有测试覆盖的 core；P0-D 先跑通测试；放在 vendor 目录，以后可以逐步替换 |
| Orca 嵌套深度默认 1 层 | 不改设置，两层执行跑不起来 | 部署说明要求调成 2；osa 启动时检查这个设置，不满足就报错。实在改不了就用 P0-B 的退路 |
| 任意 Agent 当 Router，职责只能靠提示词约束 | Router 越权，比如自己读代码、写计划 | 状态和授权都由服务硬校验；越权最多浪费 token，不会写坏状态 |
| Executor 以你的系统用户身份、无需审批地运行命令 | 安全 | 和上游一样：不是安全边界。建议后续改用独立系统账号运行 |
| 并行多模型 + 审查，消耗大 | 成本 | 加并发上限（沿用上游的工作槽设计）；审查打回轮数设上限 |
