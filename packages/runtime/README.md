# 工作库共享运行时

提供所有者认证、插件资源登记与 Toonflow 共享会话。业务页面由各工作室独立拥有；通过 studioProjects.register 登记，卸载撤销新请求。构建：`node scripts/build.mjs runtime`。

向普通新会话提供 `studio` 工具：列举、打开、读取、点击、填写、选择和滚动。命令通过所有者认证的内存队列交给主窗口，结果来自实际页面；取消、超时与插件停用会撤销待执行命令。接入规范见 `packages/sdk/CONTROL.md`。

## 本机服务自动启动

Windows 开发入口在 profile 的 `dsh-studio-projects.config.autoStartServices` 写入启动组；普通桌面加载共享运行时也会执行。每组指定 `label`、`studioIds`、程序 `command`、参数 `args`、工作目录 `cwd`、日志 `logFile` 和正整数 `timeoutMs`；程序、目录和日志使用绝对路径。短剧和影视复用 Harness 的 `scripts/studio-apps.ps1`，影音使用工作库的 `scripts/start-cineflow.ps1`。已有服务按原启动器的身份记录复用。

连接接口等待启动脚本结束，再检查真实健康状态；启动失败在对应工作室显示原因和日志路径，其他页面仍可使用。插件停用或退出桌面只取消尚在执行的启动脚本，不停止已经运行的独立服务。清空 `autoStartServices` 可关闭自动启动；`DSH_STUDIO_SKIP_APPS=1` 可临时跳过。首次配置的原文备份为 `cordis.patch.yml.before-studio-startup`。

## 版本与更新

在工作室公共工具栏选择“版本与更新”，查看已登记工作室的插件版本，检查各自 GitHub 正式发布，并通过 dsh 插件管理器安装适配包。发布页必须同时提供安装包与 schemaVersion 1 的 manifest.json；每个 artifacts 条目包含 name、version、file、sha256、dsh 和可选 dshVersions。检查只接受插件 package.json 的 GitHub repository，不使用原应用安装器。尚未发布、网络失败和不兼容分别显示；安装前核对摘要及包内名称和版本。

更新记录及安装包保存在 DSH_HOME/studio/updates；安装不清空账号、历史、配置或媒体。关闭面板不会中断安装，提示需要重启时完整退出并重新打开 dsh。中断后无法确认的结果显示为未知，重启后核对插件版本。profile 的 updates 支持 timeoutMs、downloadTimeoutMs、maxPackageBytes、directory，分别控制检查超时、下载超时、安装包大小上限及绝对更新目录。

旧安装包缺少 repository 时，可在 profile 的 `updates.repositories` 按插件包名配置 `owner/repository`，例如 `dsh-studio-media: 1997liuyh-boop/dsh-studio-media`；此配置优先于安装包声明。它只选择受控的插件发布仓库，不接受下载 URL。损坏的更新记录只暂停升级，工作室其他功能仍可使用。
