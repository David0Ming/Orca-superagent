# 配套 Orca 修改

`orca-1.4.227-worker-terminal-policy.patch` 基于官方仓库 `https://github.com/stablyai/orca.git` 的提交 `7c19f712f77ba9fa629ccf0abb9a50503c8c3750`，对应本机 Orca 1.4.227。已核对补丁能够应用到该提交的干净索引；不承诺适用于其他版本。

上游版权与 MIT 许可见 [LICENSE.orca](LICENSE.orca)。

新增“设置 → 编排 → 允许智能体关闭人工操作过的任务窗口”，配置键为 `allowAgentCloseAfterUserInput`。配套修改版默认开启，包括尚无此字段的旧配置；显式关闭会保存，重启不会重新打开。

- 开启：点击、键盘、粘贴和移动端/聊天输入不再自动将受管任务窗口转为人工接管。原有所属 Dispatch、终端身份、完成状态、输出归档等释放校验继续生效。
- 关闭：后续人工输入恢复原来的持久接管保护。worker 不能通过 settings RPC 改写此选项；只能在执行主机的 Orca 设置界面修改。
- 历史 `user_owned` 标记不自动抹除，已有外部/转移归属不改变。`worker-retain` 和后续显式 `worker-release` 沿用 Orca 原有语义，前者不是不可撤销的永久锁。
- 这是该 Orca 实例所有受管任务的设置，不是仅针对一个业务项目的设置。远程执行主机需要自己的配套版本与设置；新客户端不能替旧主机改变策略。

应用补丁（在对应 Orca 源码 checkout 内，将路径换成此文件所在目录）：

```sh
git rev-parse HEAD
git apply --check /absolute/path/Super-agent-orca/patches/orca-1.4.227-worker-terminal-policy.patch
git apply /absolute/path/Super-agent-orca/patches/orca-1.4.227-worker-terminal-policy.patch
```

安装包构建、签名与安装沿用 Orca 的构建流程。仅在 Super-agent 项目执行 `npm install` **不会**修改已安装的 Orca；正式集成发布需要同时交付配套 Orca 版本，不能把补丁文件当作安装成功。

2026-11-02 验证：15 个测试文件、197 项相关测试通过；Node 与 Web 类型检查通过；changed-code quality gate 通过；main/preload/renderer 构建通过，Web 客户端投影与校验通过。测试覆盖默认允许、恢复保护、偏好持久化、桌面/手机/结构化会话寻址、远程归属、活动任务拒绝释放、历史接管保留、设置搜索与 UI 切换、RPC 不允许 worker 改写保护选项。

本机工作副本：`/Users/mzg/workspace/orca-resource-lifecycle`。目前只交付源码补丁与构建产物；没有生成或安装新的签名应用包，没有重启运行中的 Orca，也未做真实应用窗口的端到端验收。
