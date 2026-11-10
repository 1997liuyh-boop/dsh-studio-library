# 工作室容器与共享运行时

本仓库分别提供 dsh-worktable（工作室容器）和 dsh-studio-projects（页面与服务运行时）两个独立的 DSH 插件。市场生成器通过 workspaces 发现两个包；根目录只承担源码构建，不是可启用插件。

Git 安装直接使用已提交的 packages/worktable/lib 与 packages/runtime/lib、static。源码构建执行 npm install --include=dev --legacy-peer-deps、npm run build、npm run check。独立业务工作室通过 studioProjects 服务注册页面，停用后自动撤销。

工作室容器基于 [Aisland-SJL/dsh-worktable](https://github.com/Aisland-SJL/dsh-worktable) 开发；保留原 MIT 许可。共享 SDK 固定副本见 SDK-SNAPSHOT.json。

需连接本地外部应用时，在运行时插件配置中设置服务地址及自动启动项；用户数据库、凭据和运行记录不在本仓库中。
