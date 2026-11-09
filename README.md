# OSA

个人多项目开发入口：一个 Router 负责澄清结果、定位与路由，Executor 负责规划和实现。Orca 插件在主区域标签页提供日期／项目／工作树任务工作台和任务内对话；一套本机服务保存原请求、授权、输入、报告与回复。

2026-11-08 已接通本机正式库 `.osa/p4-live`，工作台和正式 Router 可用于新任务。旧任务和历史保留，升级前积压执行已隔离，避免自动续跑；详见 [正式接入记录](docs/FORMAL-ACTIVATION-20261108.md)。

2026-11-07 开发版。实现计划和进度见 [开发计划](docs/DEVELOPMENT-20261107.md)，产品约定见 [九章文档](docs/OSA-CORE.md)。开发完成与实际验收分别记录；历史 P0–P4 验证不代表本版已经通过完整验收。

## 本地启动

需要 Node 22.13+、Git、可用的 Orca 及已配置的 Agent。GitHub 和飞书是可选来源。本项目没有运行时 npm 依赖。

```sh
rtk npm run typecheck
rtk npm test
rtk proxy node scripts/osa-service.mjs start --state /absolute/osa-state --repository /absolute/service-home --executor-agent codex --max-executors 2
rtk proxy node scripts/osa-service.mjs status --state /absolute/osa-state
rtk proxy node --experimental-transform-types bin/osa.ts --state /absolute/osa-state owner status
```

`--executor-agent` 指定 Orca 承载的 Agent，默认 codex；可选 `--executor-model`，未指定时沿用宿主模型。没有固定审查模型或通用审查轮数限制。Executor 仍须遵守任务和仓库明确规定的审查要求。

状态目录与代码目录分别指定。沿用现有状态时先做 SQLite 一致性备份；不要另开服务重复监听同一来源。旧 `--two-layer` 只为启动配置兼容保留，不再开启通用审查门禁。服务重启不重新派工。

## 面板与 Router

```sh
rtk proxy orca plugin validate plugin/osa --json
rtk proxy orca plugin check plugin/osa --json
rtk proxy orca plugin test plugin/osa --json
rtk proxy orca plugin dev load plugin/osa --json
```

实际命令使用当前会话的 `ORCA_CLI_COMMAND`，否则使用本机 `orca`。代码插件首次加载会返回权限说明，所有者确认后按本次返回的指纹批准。插件需要 `trusted-worker` 及自身设置、草稿存储权限。加载后在 OSA 面板的设置里填写服务状态目录。

侧栏的“打开任务工作台”打开主区域标签页；也可在 Orca 新建文件菜单选择“OSA 工作台”。工作台按日期、项目或工作树查看任务，项目当天清单可直接提出要求。原侧栏保留配置、登记与旧任务入口。查询不领取 Router 租约。未连接、未绑定 Router、来源异常和空列表会分别显示；后台刷新保留草稿。相关说明见 [插件](plugin/osa/README.md)。

工作台输入栏支持多行、粘贴截图、拖入／选择附件、上传进度、重试与草稿；也可只发送附件。Enter 发送，Shift+Enter 换行，Cmd/Ctrl+Enter 发送。单文件最多 20 MiB，每条最多 10 个附件；历史图片可预览并保存。详见 [输入栏实现与验证](docs/COMPOSER-20261108.md)。

在要作为 Router 的 Orca 结构化聊天中加载 [Router skill](skills/super-agent-router/SKILL.md)，再运行：

```sh
rtk npm run router:takeover -- --state /absolute/osa-state
```

此命令明确接管 Router 绑定；不要在普通执行窗口中误用。Router 处理原生事件和当前待办后让出轮次，普通进度留在任务记录。

## 本机所有者接口

以下命令均在 `node --experimental-transform-types bin/osa.ts --state /absolute/osa-state` 后使用；它们与面板走同一服务。

```text
owner project-add --id product --name 产品
owner repository-add --id api --name API --project product --repository /absolute/api
owner repository-add --id web --name Web --project product --repository /absolute/web
owner request --id unique-message --project product --locations api,web --text '所有者的完整原话'
owner comment --id unique-reply --ticket TICKET --text '补充或回答的完整原话'
owner status --project product
owner windows --ticket TICKET
owner window-link --ticket TICKET --session SESSION_ID
owner window-observe --ticket TICKET --session SESSION_ID
owner stop --ticket TICKET --reason '所有者明确停止'
owner retry --ticket TICKET
```

请求先保存为待路由消息；选定项目是来源上下文，Router 可以说明理由后路由到其他项目，原入口和原话保留。评论进入原任务的 Input，不改原 Mandate。未接单话题也可以用 `owner comment --trigger ORIGINAL_ID` 继续补充；接单后仍是同一话题。范围内补充继续，范围外请求由 Executor 交回。重试保留原工作与证据，只在原执行状态符合条件时进行；Orca 原生限制仍生效。

一个工单可明确选择同一项目的多个仓库，由同一个负责的 Executor 协调。每仓工作区、发布记录和 PR 分别保存；第一个仓库完成不表示整体完成。旧单仓数据继续可读。

## 可选外部来源与发布

服务可加 `--github OWNER/REPO,OWNER/OTHER` 或 `--feishu-chat CHAT_ID`；使用已配置的 gh/lark CLI 核对所有者身份。新工作只接受所有者明确要求；已订阅 GitHub 讨论中的审查者和机器人反馈可以进入上下文，不能扩大授权。

GitHub 来源与项目仓库通过现有 component 的 GitHub 字段关联；面板不要求使用者管理组件层级，外部来源高级配置仍用现有命令和启动参数。改配置不等于已运行的会话更新了提示词。

发布依据原始授权和项目交付规则；旧 `--publish` 参数仅兼容，不授予或撤销权限。Executor 可用 `pr publish --location LOCATION` 逐仓发布，也可使用项目已有工具；辅助接口校验目标、账号和分支。`ready` 沿用 DSH 报告与 PR 跟踪，不要求 OSA 专有发布回执。不会因此自动合并、部署或推送未授权任务。

## 停止、恢复与限制

```sh
rtk proxy node scripts/osa-service.mjs stop --state /absolute/osa-state
```

2026-11-09 起仅手动启动：`npm run osa:start` 按现有正式配置启动，`npm run osa:stop` 停止，`npm run osa:status` 查看状态。登录、打开 Orca、打开工作台和加载 Router skill 都不会自动启动服务。Supervisor 注册默认也不自启或自动重启；当前两项 LaunchAgent 均禁用。停止服务不等于停止已派发 Executor。

看门狗单独手动启动：先删除 `~/.orca/watchdog/DISABLED`，再在专用终端运行 `bash ~/.orca/watchdog/orca-watchdog-loop.sh`；Ctrl+C 停止。它不随 `osa:start` 启动。当前保留 DISABLED 标记，且 LaunchAgent 已移除 WatchPaths、RunAtLoad 和 KeepAlive 自动触发。

执行者的报告在线直接提交；服务不可连接时可进入 Orca 原有信箱。报告已排队不等于领域接受；服务保存回执后确认。原生完成、业务完成、输入投递与读取是不同事实。

已有窗口可显式关联并按需查看最近观察。关联不增加授权，窗口历史不被自动导入为任务输入。目前公开接口可以切换终端；结构化聊天的一键导航未发现可用接口，面板明确说明。多仓的附加工作区可查且保留；现有自动检查式 cleanup 仍以主工作区为目标，不自动删除附加目录。

不修改 Orca 本体或 vendor，不恢复已放弃的可靠性平台。不承诺电脑休眠、关机或 Orca 关闭时仍可派工，也不承诺跨机器自动接管。

工作台的实现与实测记录见 [2026-11-08 验证](docs/WORKBENCH-VALIDATION-20261108.md)。日期取本机时区；没有记录时间或窗口历史不全时明确显示，不把观察时间写成业务进展。
