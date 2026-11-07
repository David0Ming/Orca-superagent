# P1 验证记录

日期：2026-11-02。Node 22.23.0，Orca 1.4.227。代码未提交、未推送、未发布。

## 实现范围

- `src/store.ts`：Node 自带同步 SQLite；领域记录、派工意图、能力令牌、Router 租约和发件箱共用事务。WAL、FULL 同步、嵌套 savepoint。
- `src/app.ts`：只认当前系统用户的 Router 输入；租约与 Executor 能力校验；调用原样复用的 Engine 完成判断、关联和回报。Router 不接受外部提供的账号身份。
- `src/orca.ts`：每派工一个锚点和 Run；持久操作编号、未知结果核对、后续输入确认、完成校验、release → ack → 锚点清理。P1 固定一个执行槽，启动 Codex，保留工单 worktree。
- `bin/osa.ts`：本机 Unix socket 常驻服务与 CLI。状态目录权限 0700，socket 0600；不开放网络端口。活 socket 阻止第二个服务，崩溃留下的 socket 可恢复。
- `skills/super-agent-router/SKILL.md`：任意 Agent 的 Router 职责与命令流程。
- `vendor/dsh-core`：15 份源码与固定上游提交逐字节相同；MIT 许可证、完整提交号、原有 144 项核心测试保留。

## 真实故障注入

第一个工单 `fe2adca79112e63fdcf401a49196150f`：

1. 从 Router CLI 录入目标并 accept。
2. SQLite 显示 launch 已 attempted，但 response 尚未存在时，对 osa 进程执行 SIGKILL。
3. 原状态目录重启，取回同一次派工：Run `run_258c6d680be4`、Task `task_7baedd36c4b3`、Dispatch `ctx_63568236b6a1`。worker-list 的 total 为 1。
4. 独立 worktree 的 `p1-smoke.txt` 实际字节为 `hello from osa\n`。
5. Executor 调用 report ready，Router 收到结果 `8bca471bd8b795b8b5c602820b042edf` 并确认。有效 worker_done `msg_5153f942d4dc` 被持久记录，worker release 成功，然后批次确认。
6. 再次 SIGKILL 和重启，Router 收件箱为空，发件箱历史仍只有同一条消息。

这次发现 Orca 自动增加分支用户名前缀。最终实现改为创建 Orca worktree 后，用不覆盖已有分支的 git branch -m 设置工单短名，再启动 Executor。原故障注入工单保留为历史证据；第二个真实工单验证最终分支路径。

第二个工单 `0bbdd619f618bcb823eb3e4aedf112a6` 验证通过：Run `run_af7a32a8ac26`，Dispatch `ctx_a5c457a32b75`；分支精确为 `p1-exact-branch`，`p1-exact.txt` 的 13 字节精确为 `exact-branch\n`。Router 收到并确认结果 `8ce32443cbcfb170fa12d3dbf5efe193`；有效完成消息 `msg_7cf4fc48e445` 之后完成 release、ack 和锚点关闭。

本机实物保留在 `/Users/mzg/orca/workspaces/Super-agent-orca/p1-smoke-greeting` 与 `/Users/mzg/orca/workspaces/Super-agent-orca/p1-exact-branch`；状态库为 `/tmp/osa-p1-live/state.db`（临时目录可能被清理，以上记录不依赖它长期存在）。测试未提交任何产物。

## 可重复检查

最终结果：6 个测试文件、177 项测试全部通过；TypeScript 严格类型检查通过。两次真实工单均已完成，测试服务已停止，worker 回收列表为空。

```sh
npm test
npm run typecheck
```

测试包含 SQLite 关闭重开与回滚、租约抢占拒绝、非法账号与能力拒绝、外部输入 ID 冲突、结果去重、Unix socket 单实例和 SIGKILL 恢复，以及 fake CLI 子进程模拟回执丢失、未知派工拒绝重发、过期/伪造完成消息拒绝、送达不等于已读、release/ack 顺序、精确分支、分支冲突和单槽执行。

## 边界

- 回复的持久记录按消息 ID 唯一；未确认消息会重放。任意外部聊天窗口的“显示”与 SQLite 确认不能原子提交，Router 必须按消息 ID 去重。这不是任意外部 UI 的视觉恰好一次保证。
- 外部操作状态不明时保留意图和通知，不通过重启自动重新派工。人工恢复和主动监督属于后续阶段。
- 本机系统账号是信任边界，能力令牌防误用但不隔离同一系统用户下的恶意程序。Router 不读代码的边界仍靠技能提示词。
- SQLite 按记录类别读取后筛选，适用于个人规模；没有做断电、磁盘损坏或大规模历史压力测试。
- GitHub、飞书、两层执行、跨模型独立审查按原计划留在 P2/P3。
- 用户已有随 Orca 启停的看门狗；未核对其实现或接入 osa，没有重复建设监督程序。
- 测试依赖从 P0 的 Vitest 4.1.8 更新到安全补丁 4.1.12；安装审计结果为 0 告警。运行时仅使用 Node 标准库与 vendored core。
