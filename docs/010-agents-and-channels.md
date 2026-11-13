# 010 执行者偏好与渠道拓展

状态：2026-11-13，研究记录稿。依据 owner 当日的两项研究请求：autoloop 的执行者调用偏好、飞书与 GitHub 渠道拓展；以及新查到的 Orca 原生来源链接能力。本文只记录思路与落地方式，不改变任何脚本、技能、面板或 Orca 本体。

## 一、执行者调用偏好

### 1.1 autoloop 的做法

执行者配置写在规则文件里，一条规则对应一类任务，固定声明用谁、什么模型、什么强度、什么权限：

```
agents: { claude:   { use:"claude", model:"…", effort:"high",  access:"edit" },
          reviewer: { use:"codex",  model:"…", effort:"xhigh", access:"read" } }
rules:  [ { name:"审查", to:"reviewer", … }, { name:"实现", to:"claude", parallel:2, … } ]
```

值得借鉴的是三条规矩，不是字段本身：

1. 偏好挂在任务类型上，不挂在单次派发上——同一类活每次同一套配置，可复现。
2. 能力差异显式声明——有的 Agent 不吃模型和强度（DeepSeek Harness、ZCode 用自己的配置），文档直接写"这几项可能没有"，不假装统一。
3. 权限档由适配器翻译——只读、改工作目录、全权，各 CLI 各自映射；拦不住的（如 ACP 不问就执行）明说拦不住。

### 1.2 OSA 已有的一半

Orca 原生 `worker-start` 已经提供：`--agent`（claude、codex、cursor、antigravity、muse、zcode、opencode 等）、`--model`、`--effort`（必须同时给模型）、`--keep-open`、`--worktree`、`--setup`、`--timeout-ms`、`--retry-of`、`--from`。旋钮齐全，缺的是一张统一的偏好表和一条派发理由。

### 1.3 建议（纯约定）

| 任务类型 | 执行者 | 模型/强度 | 备注 |
| --- | --- | --- | --- |
| 代码审查 | codex | 指定模型 + high/xhigh | 只读靠 Codex 自身配置；Orca 没有沙箱开关 |
| 实现 | claude | 默认 | 需要跟进时加 `--keep-open` |
| 只读调研 | claude | 默认 | 在 spec 里明确写"只读" |
| 文档/文案 | 任一 | 默认 | |

三条落地细节：

- 派发带理由：每次 `worker-start` 加 `--comment "派发理由：…"`，存进 Orca 元数据，事后可查。相当于 autoloop 的 `why`，零成本。
- 能力差异写进表里：`--effort` 必须配 `--model`；OpenCode 不接强度；ZCode 用自己配置。不支持就明说。
- 不伪造权限控制：Orca 没有 `--access` 档位，不在 OSA 里造"只读派发"的假承诺。需要只读时靠执行者自身模式或工作树隔离，做不到就报告，符合宪章"检测到就报告"。

约束：不为没有真实反例的任务类型预设偏好；表从实际用过的组合开始记录。

## 二、渠道拓展总方案

### 2.1 dsh 的可移植部分

dsh 不开公网端口、不接 webhook，用本机 CLI 增量拉取（GitHub 查 Issue/PR/评论/CI，飞书查消息和话题）。对 OSA 友好，因为 Orca 没有入站 webhook，但定时任务和 CLI 都有。

| 机制 | dsh 的做法 | OSA 最小对应 |
| --- | --- | --- |
| 来源注册 | 来源类型 + 实例 + 各自配置校验 | 每来源一个脚本 + 一份配置，不建注册框架 |
| 稳定身份 | 评论 ID、消息 ID 作触发编号，重放不重复接单 | 原生 ID 直接当去重键，存"来源 ID → 工单 ID"映射 |
| 话题 | 群聊按"群+根消息"、GitHub 按 Issue/PR 编号 | 原生 thread 编号 + 工单关联 |
| 人机区分 | 机器人/GitHub App 的消息永不算授权 | 白名单：所有者账号 + 非 bot |
| 回复 | 回原位置，发送回执、失败可见、按会话保序 | 发送记录（工单+尝试次数 → 原生消息 ID） |
| 失败隔离 | 一个来源坏了不拖累其他，读取位置只在成功后推进 | 每来源独立游标和错误记录 |

### 2.2 分阶段

```
第一步（出站，风险最低）
  执行者报告 → Router 转述 → 通知脚本 → 飞书卡片 / GitHub 评论
                              发送记录：工单+尝试次数 → 原生消息 ID（防重发）

第二步（单来源入站）
  定时任务 → gh / lark 增量拉取 → 白名单 + 人机过滤 → 稳定 ID 去重
           → 投进 Run 信箱（附来源定位）→ Router 评估 → 建工单
           → 游标写入 state 文件，发送成功后才推进

第三步（话题关联与回复闭环）
  同一 Issue/话题的新消息 → 扫描 → 作为补充输入投递 → 结果回原位置

第四步（只读观察）
  PR 打开/合并、CI 失败 → 通知 Router；不自动发布
```

### 2.3 不建的东西

webhook 服务、通用来源注册框架、自动接单、发布流水线、团队权限树。这些正是旧 OSA 调度服务被回滚掉的那类东西。

### 2.4 未知项

1. Orca 的消息类型只有 question/escalation/status 等固定几种，外部来的新请求该用哪种。较稳的做法是入站直接建一张 pending 工单（来源元数据写进 spec），再发一条唤醒消息，而不是把请求伪装成问答。
2. 飞书侧要有可用的命令行工具或 API 凭据（dsh 用 lark 命令行）；GitHub 侧 `gh` 即可。
3. README 里"派往别的仓库实测还没做过"是渠道的前置，需要先验收。

## 三、GitHub：用 Orca 原生来源链接，不写插件

### 3.1 事实

- Orca 的插件清单里没有任何 GitHub 集成插件，只有一个 GitHub 主题包。真正的联动在核心里。
- 工作树自带一整套链接字段：`linkedIssue`、`linkedPR`、`linkedLinearIssue`、`linkedGitLabMR`、`linkedGitLabIssue`、`linkedBitbucketPR`、`linkedAzureDevOpsPR`、`linkedGiteaPR`、`linkedWorkItem`。
- 命令：

| 能力 | 命令 | 实际作用 |
| --- | --- | --- |
| 来源链接 | `reference add/list/remove` | 把 Issue/PR/Linear/Jira/GitLab 等的完整 URL 挂到工作树 |
| 按来源反查 | `reference find <url>` | 给出关联的工作树和执行者；只读已存链接 |
| 建树即关联 | `worktree create --issue N --pr N --reference <url>` | 新建工作树时带上来源，可同时启动执行者 |
| 改已有树 | `worktree set --issue/--pr/...` | 给现有工作树补挂来源 |
| 会话搜索 | `orca search` | 全文搜该主机上的历史会话 |
| Linear | `orca linear` | 原生读写 Linear 议题 |

- `reference find` 只查已存链接，不会去 GitHub 拉数据；GitHub 事件它也不监听。
- `reference add` 挂完整 URL 不需要联网校验；`worktree create --issue` 是否要求 GitHub 远端和认证，需实测。
- 本仓库当前没有 git remote，本地的 GitHub 联动暂时是空转；验证要在有远端、`gh` 已登录的仓库做（本机 `gh` 已登录，账号 David0Ming，有 repo 权限）。

### 3.2 联动方式

```
GitHub / Linear（外部）
   │  gh 轮询 / API（Orca 自己不收事件）
   ▼
Router（模型判断）
   ├─ 派发时挂来源：worktree set --issue N  或  reference add <url>
   │        └→ 写进 Orca 原生 linkedIssue/linkedPR，界面直接可见
   ├─ 入站路由：reference find <url> → 这个 Issue 属于哪棵树/哪个项目
   │            orca search → 这件事以前有没有人做过（续接判断）
   └─ 回写：gh issue comment（用原生链接当目标）
            发送记录只记"工单+尝试次数 → 原生消息 ID"
```

三条具体用法：

1. 派发即挂来源（马上可用，零代码）：任务来自某个 Issue/PR 时，顺手把链接挂到工作树。Orca 界面可见，面板也可读这两个字段显示。权威数据在 Orca，不自建"来源→项目"表。
2. 入站路由不再自己造：轮询到新评论，用 `reference find` 找到对应工作树和项目，再用 `orca search` 查历史会话，判断是否旧任务延续。两个原生命令替掉自建映射表，接上 Router 技能里"先查是不是旧任务延续"的规矩。
3. 出站回写有天然目标：完成或受阻时，从工作树的 `linkedIssue`/`linkedPR` 取目标地址，用 `gh` 发评论。OSA 只记"发没发过"，不记"发到哪"。

### 3.3 限制

- 事件监听：Orca 不接 webhook，入站仍需 `gh` 定时轮询。
- 飞书：没有任何原生对象，链接、反查、回写都得自建，比 GitHub 贵。
- 不改 Orca 本体：以上全是调用已有命令，符合宪章。

## 四、飞书

- 出站：一个 webhook 脚本即可，卡片内容由 Router 转述结果时提供。
- 入站：定时轮询 + 所有者白名单 + 人机区分 + 稳定消息 ID 去重 + 每来源游标；失败隔离，单条坏数据不丢整批。
- 没有原生链接对象，需要自建"群/话题 → 项目/工单"映射，规模应控制在当前实际使用的群。
- 消息类型同上：入站建 pending 工单再唤醒，不伪装成问答。

## 五、建议顺序与验证

1. 执行者偏好表与派发理由（纯文档，半天）。
2. 出站通知脚本（GitHub 用原生链接当目标，飞书用 webhook），一两天。
3. GitHub 派发挂来源与入站路由（需要先完成跨仓库派发实测）。
4. 飞书单来源入站。
5. 话题闭环与只读观察。

验证方式：每条用真实数据走一遍。偏好表在实际派发中记录并核对；挂来源后用 `reference list` 确认写入；入站轮询用测试仓库和测试群，确认去重与游标推进；面板用现有模拟 CLI 与截图工具检查显示。不以理论竞态阻断，按宪章以真实复现为准。

## 六、待决

| 事项 | 需要谁定 |
| --- | --- |
| 偏好表的初始条目（从实际用过的组合开始） | 所有者 |
| `worktree create --issue` 的远端与认证要求 | 实测后定 |
| 入站消息用 pending 工单还是新消息类型 | 所有者与 Router 约定 |
| 飞书使用哪些群、谁算所有者账号 | 所有者 |
| 跨仓库派发先验收哪个仓库 | 所有者 |
