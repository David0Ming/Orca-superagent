# OSA 工作台与侧栏

侧栏用于连接设置、登记及快捷入口。点击“打开任务工作台”后，主区域的独立标签页展示日期／项目／工作树视图、任务连续记录和当天输入；也可从 Orca 新建文件菜单选择“OSA 工作台”。使用 `.osaworkbench` 标记文件打开，不将工单写进文件，数据仍来自同一 OSA 服务。

项目栏只提供来源上下文，Router 可说明理由后路由到其他项目；原始入口仍指向同一话题。跨日活动复用任务身份，旧日期入口保留。范围内补充交原执行者，范围外由它交回。

插件通过 Unix socket 连接指定的状态目录。代码插件需要 `trusted-worker`、`settings:own`、`storage:own`；不启动正式服务、不读写 Orca 私有数据库。草稿按状态目录和话题保存，断线或切换目录后不误提交。

开发检查：`orca plugin types plugin/osa --json`、`npx tsc -p plugin/osa/tsconfig.json --noEmit`、`orca plugin validate/check/test plugin/osa --json`。需使用当前宿主的 Orca CLI。工作台启动快捷入口目前用于 `local.osa` 本机开发安装；发布到其他 publisher 前再调整该定位，不冒充已支持所有安装身份。
