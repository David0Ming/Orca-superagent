# 2026-11-07 开发验证记录

本轮按 [开发计划](DEVELOPMENT-20261107.md) 实施。代码及隔离验证完成，真实插件加载仍待所有者授权；不宣称全部产品验收完成。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `rtk npm test` | 18 个文件，382 项通过 |
| `rtk npm run typecheck` | 通过 |
| `orca plugin test plugin/osa --json` | 9 项通过 |
| `orca plugin validate plugin/osa --json` | 通过 |
| `orca plugin check plugin/osa --json` | 原生组件测试宿主渲染通过 |
| `git diff --check` | 通过 |

后端与插件使用各自的测试运行器。插件依赖 Orca 的 `orca/testing`，因此 npm test 排除 plugin，插件由原生 CLI 单独运行。未统计或宣称覆盖率。

测试覆盖真实改动：不可变授权、跨项目与仓库选择、所有者接口不抢 Router 租约、评论去重、子窗口保留时的结算、活跃子任务仍受保护、多个工作区及续用、逐仓发布、首仓先合并、已结束任务再次补充、当前提交发布证明、人工停止、重启、候选送达与重新评估、窗口发现、草稿和状态目录切换。

## 独立审查

实现由 sol / terra 高推理执行，astra 高推理独立审查。修复并复核了：

1. 面板项目 B 的请求不能附加到项目 A；选择的仓库不能被 Router 静默替换。
2. 多仓任务的首个 PR 先合并，或上一轮 PR 已合并后开始续作，都不能提前结束当前工作。
3. `ready` 核对当前干净工作区 HEAD 的真实发布记录，历史开放或关闭的 PR 不能覆盖未发布的新提交。
4. 断线后旧快照不显示为已连接；结果查看后退出提醒，新结果重新出现。
5. 已有窗口发现包含已登记仓库中的其他原生工作区，不只包含 OSA 创建的目录。
6. 切换服务状态目录时，旧快照不能向新服务提交动作，草稿按实际状态目录隔离。

上述复核未要求额外的通用恢复、并发或权限平台。

## 真实 Orca 验证

使用独立状态 `.osa/validation-20261107/state`，三个临时 Git 仓库，无 GitHub／飞书来源。没有推送、发布 PR、改线上或重载正式 OSA。

| 场景 | 实际结果 |
| --- | --- |
| 两项目并行 | 双仓任务与另一项目的单仓任务分别启动，目标和结果没有串项目 |
| 双仓首阶段 | 两个工作区各生成 `VALIDATION.txt`，第一行为 `osa-native-cycle`；提出问题后原生尝试结算，槽位释放 |
| 原任务评论 | 重复提交同一确认 ID 只保存一次；原任务新建第二次派工，复用两个原工作区，均追加 `osa-followup` |
| 独立项目 | `INDEPENDENT.txt` 实际内容为 `osa-other-project` 加换行；任务完成并释放资源 |
| 原生 Router 唤醒 | 绑定隔离 Router，服务递送后台事件；Router 自行 accept 原请求，执行者生成 `WAKE.txt`，实际内容为 `osa-router-wake` |
| 服务重启 | 先后两次核对原 Dispatch；没有因重启重新派工或重复创建任务 |
| 最终记录 | 3 个任务均 completed，4 次执行均 finished，候选 0、异常通知 0 |
| 原文和版本 | 所有工单 Mandate 等于原始请求；CLI 返回中文与数据库原文一致；服务实际加载代码指纹 `5049f21b2d0f` |

本轮不仅读取 Agent 的完成声明，也实际读取了三个成果文件。当前验证服务已停止，测试状态和成果保留以便追溯；没有恢复历史停止的业务工单。

### 实测发现后修复

- **唤醒身份继承：** 从结构化 Agent 内启动 OSA 后，RouterWake 曾继承 `ORCA_AGENT_SESSION_ID`，原生 CLI 返回 `consumer_fenced`、`runtimeId=null` 并明确未发送。服务现在与已有 Executor 适配一致，使用自己的发送锚点身份；同一待办随后成功唤醒 Router 并完成。回归在修复前失败、修复后通过。
- **中文分块：** socket 将每块 Buffer 单独转字符串，遇到 UTF-8 字符边界时出现替换字符。客户端、服务端和插件 worker 已使用 Node `setEncoding('utf8')`；请求与回复故意在中文/emoji 字节中间分段，修复前两项失败，修复后通过。

## 证据位置

私有状态及原生回执保存在 `.osa/validation-20261107/`，不进入 Git：

- `tickets.json`、`targets.json`：隔离目标和任务。
- `status-after-first-turn.json`、`status-after-restart.json`、`status-after-followup.json`：提问、重启与续跑事实。
- `file-checks.json`：实际成果内容。
- `router-launch.json`、`native-wake-request.json`、`wake-error-envelope.json`、`router-history-after-wake.json`：原生启动、请求、故障和恢复。
- `status-native-wake-final.json`、`final-status.json`：最终结果、回执与资源状态。

## 尚未完成与宿主限制

- 代码插件首次加载需要所有者批准 `trusted-worker`、`settings:own`、`storage:own`。授权问题已提出，尚无答复。未使用 `--approve`，未把组件模拟测试当成实际面板验收。
- 原生预览截图命令要求窗口隐藏/最小化；本次宿主仍拒绝截图，未生成或伪造截图。原 Orca 窗口已恢复。
- 当前安装版 Orca 缺少插件 TypeScript 类型文件，`plugin types` 报具体文件不存在；后端类型检查和插件运行时检查分别记录，未声称插件独立 tsc 通过。
- 现有公开接口可切换终端；未发现结构化聊天的一键导航接口。窗口记录可按需观察，不自动导入为任务授权。
- 多仓附加工作区保留且可查；现有 cleanup 仍针对主工作区，不自动删除附加目录。
- GitHub 发布回归使用两个真实临时 Git 仓库和两个本地 bare remote，加 API 替身；未做线上 GitHub 发布。飞书本轮未做真实群消息测试。
