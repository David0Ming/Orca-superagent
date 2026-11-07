# P0-D：上游核心层脱离 DSH 单独编译与测试

上游：dsh-superagent-prototype，提交 6337fc8，MIT。验证目录：/tmp/p0-d（可随时删）。

## 结论：通过

- 类型检查（tsc --noEmit，沿用上游的严格配置）：0 错误。
- 核心测试：2 个文件，**144/144 通过**（耗时约 0.2 秒）。
- 环境：Node 22.23.0，依赖只装了 typescript 6.0.3、vitest 4.1.8、@types/node 22.20.0（版本照上游）。zod 不需要。

## core 之外的依赖

**没有。** src/core 共 15 个文件、2088 行，所有引用都在 core 内部，外部只用了 Node 自带的 node:crypto。不依赖 src/kv.ts、src/policy.ts、infra、app、sources，也不依赖任何 @deepseek-ai 包。

## 测试取舍

| 测试 | 处理 | 原因 |
|---|---|---|
| tests/core-engine.spec.ts | 纳入 | 只引用 core 和 vitest |
| tests/stage.spec.ts | 纳入 | 只引用 core 和 vitest |
| 其余 19 个引用了 core 的测试（outbox、passes、policy、runtime、sources、store 等） | 排除 | 都同时引用 app/、sources/、infra/、policy.ts 或 fixtures/host.ts；追下去会连带 cordis、dsh-agent、dsh-session、dsh-llm 等 DSH 包。例如 outbox.spec 经 infra/commands 一路拉进约 70 个文件和十几个 DSH 包 |

不需要 tests/fixtures。

## 对 DSH 的残留耦合

代码上为零。只有注释和接口命名里沿用了 DSH 的概念，例如“主 Session”（EngineForMainSession）、“worker 的 Session 把输入读进一步”（inputsRead）。这些是语义约定，不是代码依赖：我们的执行器把“主 Session”对应到 Router 窗口，把“worker Session”对应到 Orca worker 即可。

## 安装注意

本机 npm 10.9.8 解析 vitest 的可选 peer 依赖时会崩溃（报 edgesOut 错误），需要加 `--legacy-peer-deps`；用 pnpm 应无此问题。

## 建议的 vendor 目录

```
vendor/dsh-core/
  LICENSE              上游 MIT 原文
  UPSTREAM.md          上游地址 + 提交号 6337fc8，注明“原样拷贝，勿改”
  src/*.ts             = 上游 src/core/ 15 个文件，一字不改
  tests/core-engine.spec.ts, tests/stage.spec.ts   引用路径从 ../src/core/index.ts 改成 ../src/index.ts（唯一改动）
```
要求我们的 tsconfig 打开 allowImportingTsExtensions（上游引用写的是 .ts 后缀）。

## 需要我们实现的接口（src/core/ports.ts）

引擎构造：`new Engine({ repo, policy: () => Policy, scope, assessor, executor, outbox, prepareTicket?, now?, emit? })`

- **Repositories**（存储，P1 用 Node 自带 sqlite 实现；上游带一个内存版 MemoryRepositories 可直接用于测试）
  - `atomic<T>(work: () => T): T` —— 事务，同步
  - `triggers`: get(id)、save(trigger)、disposition(id)、saveDisposition(id, value)
  - `threads`: get(key)、save(thread)、list()、active()
  - `tickets`: get(id)、save(ticket)、list()、open()、active()
  - `decisions`: get(id)、save(decision)、byThread(key)
  - 注意：全部是**同步**接口，sqlite 要用同步 API（node:sqlite 的 DatabaseSync 正好是同步的）。
- **Policy**（准入）：`version`、`paused`、`evalTimeoutMs` 三个字段；`gate(trigger, thread, tickets) → 可准入(强度+依据) / 不可准入(原因)`；`revalidate(mandate) → boolean`；`admitsInferred(rules) → boolean`。
- **SourceScope**：`scope({ source, meta }) → 已监听(是否仅观察) / 未监听(原因)`。
- **Assessor**（判断是否立工单）：`request(candidate)` 发出评估请求，结果之后回调引擎；可选 `release(evalId)`。
- **Executor**（执行器，对应 Orca worker）：`start(ticket, assignment)`、`deliver(ticket, assignment)`（送后续消息）、`stop(ticket, assignment, reason)`。
- **Outbox**（回复出站）：`send(message)`、`status(id) → pending/sent/dropped`、`withdraw(id)`。
- 可选 `emit(event)`：领域事件（trigger.received、ticket.created、assignment.started 等 13 种），可接日志/通知。
