# Orca 临时任务资源生命周期

## 2026-11-03 实际使用盘点：工单隔离被过度用于所有工作

10:13（UTC+8）盘点，Orca `worktree list --limit 1000` 返回本机 43 个在册工作区，未截断。根据明确的 `createdAt` / CLI 创建时间：11 月 2 日 7 个、11 月 3 日 14 个，另外 22 个无明确创建时间。本统计只覆盖仍在册项，不能代表包含已删除工作区的历史创建总量。原始快照 `.osa/p4-live/workspace-audit-inventory.json`。

11 月 2 日的 7 个均为验证工作区：`p1-exact-branch`、`p1-smoke-greeting`、`p3-feishu-acceptance`、`p3-stall-controlled`、alpha/beta 的两个 `p4-isolation` 和 `p4-joint`。

11 月 3 日的 14 个全部属于智能客服 Hermes，均有 OSA 工单标记、`parentWorktreeId: null`、未归档：

| 类别 | 工作区 |
| --- | --- |
| 七鱼登录与恢复链，6 个 | qiyu-credential-login、qiyu-login-snapshot、qiyu-actionability、qiyu-login-traced、qiyu-novnc-setup、qiyu-restore-online |
| FAQ 与在线目标，4 个 | short-faq-tonight、faq-baseline、faq-rollout、empty-approval-list |
| 核查与清理，4 个 | session-timeout-audit、branch-cleanup、worktree-cleanup、dirty-worktree-inspect |

根因：`OrcaExecutor.workspace()` 对每个新工单强制 `worktree create --no-parent`，`verifyWorkspace()` 要求工单自己的隔离工作树创建回执，尚不能让不同工单绑定同一个持续工作目录。同一工单已有 `execution.directory` 时会复用；`qiyu-actionability` 和 `qiyu-login-traced` 各有两次 assignment，但各只有一个工作区，证明工单内的持久复用存在。跨工单不自动继承未提交成果或执行上下文；14 张业务工单也均未关联 goalId，连续目标的结构化归属没有在此次实际派工中使用。

盘点时 14 个业务工作区中 12 张工单已 completed/stopped，1 张业务未结但 Executor 已收尾，1 张仍执行；所有工作区仍保留。不能据此直接删除：未检查各目录的未提交、忽略文件、产物引用和外部使用者。

后续修正应区分「工单/Run 身份」与「工作目录」：每张工单独立身份与 Run 的 P0 约束继续保留；连续目标可以经过显式绑定、互斥写入和审查基线校验复用目录，只读/运维任务不应一律新建代码工作树，独立并行代码修改仍需隔离。结果、交接证据和清理流程须同时覆盖。此处为已核实的问题与修正方向，尚未改动执行策略或迁移、删除现有工作区。

2026-11-02，用户新增要求：人工操作后不再因此阻止智能体关闭任务窗口，并明确要求做成可选项，配套项目安装后默认允许；同时完善短任务的终端、工作空间与 worktree 清理。关闭策略已完成源码修改与验证，当前已安装 Orca 尚未替换；工作树回收仍是方案。

## 已确认的缺口

已安装 Orca 为 1.4.227，构建 commit `7c19f712f77ba9fa629ccf0abb9a50503c8c3750`。

- `worker-release` 只处理已结束 Dispatch 自己创建且身份可证明的终端，先归档可读输出，再关闭终端；复用终端、人工接管终端等会保留。它不删除工作树。
- `worker-stop` 只停止准确的受管终端，不删除工作树、配置 tabs 或其他进程。
- `worktree rm` 已有 Orca 元数据和 Git worktree 删除流程；也尝试删除关联本地分支，但保留原本存在或不能证明已合并的分支。`--force` 不等于强制删分支。
- archive hooks 默认不运行；显式 `--run-hooks` 后 hook 失败会阻止删除，不能用 `--force` 绕过。
- OSA `src/orca.ts` 目前执行 `worker-release` 和 anchor 关闭，没有工单工作树回收阶段。`released: true` 也包含 Orca 已决定 retained 的情况，只表示终端责任已处理，不能作为“资源物理删除”的证明。
- 本机 profile settings 中未发现名称匹配 takeover / ownership / cleanup / release 的设置项。这是有限的配置检索，不证明所有版本都没有开关。
- 随后按用户要求实际打开 1.4.227 的设置：检查“编排”“智能体”“终端”“通用”“实验性”，并搜索“接管 / takeover / 人工”，未找到控制自动接管的开关。“关闭运行终端前确认”、Yolo/手动权限和智能体睡眠分别控制其他行为；没有修改这些设置。

### 已安装包的静态根因定位

ASAR SHA-256：`3c7be379019c49cedcd52d4b8c3bf2c18dc1bb1b5de894c1c91b91b9ac103ae3`。没有执行或修改包内代码。

1. `out/renderer/assets/terminal-native-copy-gutter-CFsAyfe0.js`：终端鼠标报告在非默认编码分支调用 `coreService.triggerDataEvent(encodedMouseEvent, true)`；该方法的第二个参数为 true 时会触发 `_onUserInput.fire()`。因此鼠标点击／滚轮也可能被纳入“用户输入”，并非所有聚焦事件都必然触发。
2. `out/renderer/assets/terminal-user-input-signal-6ZQqhS74.js`：直接订阅 `_core.coreService.onUserInput`，没有区分键盘、鼠标或滚轮。
3. `out/renderer/assets/OnboardingInlineCommandTerminal-ijm89GAd.js`：`recordRealUserTerminalInput` 同时记录休眠活动和报告 worker 输入，报告经 `orchestration.workerTerminalUserInput` RPC 发送。原生聊天提交也调用这一 RPC；Web 构建和移动构建各有相关入口，修改需覆盖。
4. `out/main/index.js`：RPC 调用数据库方法 `markWorkerTerminalUserOwned`，将 `worker_terminal_resources.ownership_state` 设为 `user_owned`，`release_state` 设为 `retained`，reason 为 `user_takeover`。正常 release 后续看到该归属就返回保留。

这是有明确条件的静态调用链，与用户描述相符；尚未在新的受管测试终端复现鼠标点击，也未证明每一种 TUI/鼠标模式都受影响。修复应把“交互活跃度”和“所有权接管意图”拆开判断，不能直接删掉所有用户输入保护，或把数据库 user_owned 校验整体关闭。

REA 全包分析因结果内存上限只保留部分结果，父 Evidence `ev_7a45003d743bd5a5625e466ee1a17c5400180a886566e0da2c0e71c564536efc`；summary Evidence `ev_8bbeb8580a9efb939ee508a5392ce8f2eda071a4e08ee5c05cf8f5f83e1b22cf`。上述具体调用链通过对该 ASAR 索引定位后的定向文本读取核对，不依赖不完整图谱来证明全局覆盖。

## 可选关闭策略（用户最新决定）

“设置 → 编排 → 允许智能体关闭人工操作过的任务窗口”，配置键 `allowAgentCloseAfterUserInput`，配套 Orca 修改版默认开启。开启时，点击、键盘、粘贴及手机/聊天操作不自动转移任务窗口的所有权；关闭时，后续人工输入恢复原有保护。显式关闭会持久保存。此前仅排除鼠标报告的方案已被这一决定替代，因此不再有“滚轮转换成方向键仍被接管”的例外。

策略在执行主机的 `orchestration.workerTerminalUserInput` 入口统一判断，所有客户端沿用原协议。设置由本机设置界面写入，不开放 settings RPC 改写，避免 worker 自行推翻用户选择。精确终端 incarnation、所属 Dispatch、已结束状态与归档校验不变，不允许任意 agent 因此关闭任意窗口。

它影响该 Orca 实例所有受管任务。仅安装 Super-agent 的 Node 依赖不会改变原版 Orca；正式发布须交付配套 Orca 构建，详见 [配套补丁](../patches/README.md)。远程 host 以其自身版本与设置为准。

历史人工接管标记如未保存原因，不能安全区分普通查看与真正接管。不批量抹掉；新语义优先适用于后续事件，历史受阻项逐项给出可审查的处置。

额外核实：`worker-retain` 会记录 `user_requested` 并可取消尚未提交的释放，但后续显式 `worker-release` 可以再次申请释放。完整自动回收流程必须先识别并尊重这个保留意图，不能把“retain 不可被 release 覆盖”当成现有保证。

## 最小完整流程

优先复用 Orca 已有 release 和 worktree rm，不另建守护进程或定时全盘删除脚本。

| 阶段 | 动作 | 不能跳过的条件 |
| --- | --- | --- |
| 创建 | 记录 Task/Dispatch、终端、工作空间/worktree、创建来源及是否共享 | 不凭目录名或存在时间认领资源；读取文档默认复用工单目录或公开资料目录，不为每个子助手创建独立 Git worktree |
| 结束 | 保存结果、审查证据、工具回执及必要产物 | 收到可信完成或明确停止；idle、超时、断线均不代表已结束 |
| 终端释放 | 调用现有 worker-release；处理/确认原生消息 | 精确身份、已结束、输出已归档；记录 released / retained / unknown 的实际结果 |
| 工作空间审查 | 枚举所有终端、子任务和依赖，识别可回收项 | 不是项目根、Router 或共享目录；没有活跃任务、用户明确保留或未解决交接 |
| 产物保护 | 检查 Git 状态、未追踪文件、忽略文件、未合并提交及证据引用 | dirty 或产物未另存时只标记保留，不能靠自动 stash 或强制删除掩盖成果丢失 |
| 删除 | 对确认为临时且安全的目标调用 Orca 原生 worktree rm | 精确 workspace 身份；不加 force；普通文件夹注销和磁盘目录删除必须区分 |
| 收尾 | 核对终端、Orca workspace、Git worktree、分支的实际结果 | 分支保留可以是正确结果，不能宣称“一切删除”；保留任务审计与结果记录 |

自动动作先限于由本框架明确创建、无共享使用的资源。历史其他 agent 留下的目录先提供清单和保留理由，不因接入 Super-agent 就取得删除权。多项目清理也按所在 host 与 repo 执行；远程 host 不可达时状态为未知，不能当作不存在。

“短任务”不是删除依据。比如 P4 验收 worktree 里的 `p4.txt` 和 `joint.txt` 是按用户要求未提交的产物，任务成功以后仍需要保留，不能当成无用目录删掉。要删除必须先完成用户认可的产物保存或明确放弃。

程序侧最小接入应放在现有任务结束流程：先有只读清单与逐项原因，再执行明确满足条件的清理；每一步沿用持久 operation 回执。工作树删除的响应丢失时先查原身份和 Git inventory，不盲重试或用新建目录覆盖旧记录。不删除 Run/工单审计来让列表看起来干净。

## 验收要覆盖的实际故障

1. 短任务子窗口被普通点击、切换、滚动后完成，协调者仍能释放它；明确保留的窗口保持可用。
2. 一个工作空间里的共享/预先存在终端不会随单个 Dispatch 释放被关闭；运行中的兄弟任务不会被回收。
3. 无变更的临时 worktree 可通过原生删除流程完成收尾；dirty、未追踪/忽略产物、未合并分支均有准确保留结果。
4. 删除任一步失败或进程重启后可查询、可恢复，不重复执行不确定副作用；远程不可达不误删。
5. 已归档任务仍可读取结果和审查证据；列表隐藏与磁盘删除分别报告。

## 对应源码与修改进度

已从官方 `https://github.com/stablyai/orca.git` 下载源码到 `/Users/mzg/workspace/orca-resource-lifecycle`，基于已安装版本的精确 commit `7c19f712f77ba9fa629ccf0abb9a50503c8c3750`。不需要用户再提供源码；`~/.orca` 是辅助数据位置，不是该 checkout。

已改为主机统一策略开关，无需分别改造桌面鼠标、键盘、移动端或聊天发送入口。源码补丁纳入本项目 `patches/orca-1.4.227-worker-terminal-policy.patch`，并验证可应用到精确基线。15 个测试文件、197 项测试通过；Node/Web 类型检查、changed-code quality gate、main/preload/renderer 构建均通过。

应用包仅进行只读分析，尚未替换或重启，也没有新的签名安装包或真实应用窗口的端到端验收。没有批量清除历史 `user_owned` 标记，没有删除任何历史终端、工作空间、工作树或分支。完整工作树回收仍是上述方案，尚未接入自动执行。
