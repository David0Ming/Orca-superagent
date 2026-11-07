# OSA Orca 面板

面板连接运行中 OSA 服务的 Unix socket。安装开发目录后，在面板的“设置”中填写该服务的状态目录绝对路径。它不启动服务，也不读取 OSA 数据库。提出请求先保存并等待 Router 处理；任务补充的投递与读取以服务记录为准。

插件需要 Orca 授权 trusted-worker（以当前用户身份运行 Node 代码）以及插件自己的设置和存储。未连接时草稿保留；网络或服务超时后，可用同一草稿重试。

开发验证：`orca plugin validate plugin/osa --json`、`orca plugin test plugin/osa --json`、`orca plugin check plugin/osa --json`。当前安装版 Orca 缺少插件类型文件，`plugin types` 可能失败；运行时检查不依赖这些类型。
