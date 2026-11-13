# 工作库共享运行时

提供所有者认证、插件资源登记与 Toonflow 共享会话。业务页面由各工作室独立拥有；通过 studioProjects.register 登记，卸载撤销新请求。构建：`node scripts/build.mjs runtime`。

向普通新会话提供 `studio` 工具：列举、打开、读取、点击、填写、选择和滚动。命令通过所有者认证的内存队列交给主窗口，结果来自实际页面；取消、超时与插件停用会撤销待执行命令。接入规范见 `packages/sdk/CONTROL.md`。

## 本机服务自动启动

### 随包服务（影音、短剧工作室，无需配置）

影音工作室安装或启用后，运行时直接拉起它自带的服务，不需要 `autoStartServices`，也不需要 PowerShell 7。页面读取连接状态（包括点击“重新连接”）时，如果服务没有运行会自动重试启动；控制台的“一键启动”同样可用。

- 服务从 `DSH_HOME/studio/cineflow/runtime/<版本>-<指纹>/` 下的独立副本运行（应用目录连同依赖一起复制），**不占用插件安装目录**：服务运行期间，控制台和插件市场都可以更新、重装工作室。
- 安装目录内容变化后（更新、重装并重新加载，或下次启动桌面），服务自动切换到新版本并清理旧副本。更新中断导致安装目录残缺时，继续使用正在运行的版本或上一份完整副本。
- 旧版启动脚本留在安装目录内运行的进程会被识别并替换为独立副本；用户从别处自行启动的服务保持不动。
- Electron 依次查找：插件配置 `electronPath`、环境变量 `DSH_STUDIO_ELECTRON`、`DSH_HOME/electron`（桌面插件共用的独立 Electron）、安装目录各级 `node_modules/electron`、开发模式下的宿主程序。打包安装的宿主本身不能用来运行服务。
- 启动失败会在工作室页面显示原因（安装不完整、找不到 Electron、端口被占用、启动后退出及错误日志最后一行）；日志位于数据目录的 `service.log` 与 `service.error.log`。
- 在 `autoStartServices` 中为该工作室显式写了启动组时，以配置为准，不再使用随包服务。`DSH_STUDIO_SKIP_APPS=1` 同样跳过自动启动，手动“一键启动”不受影响。

短剧工作室（`dsh-studio-media` 0.3.0 及以上）用同一套机制，区别只有三点：

- 应用是 Toonflow 的构建产物（`app/build`），用 Bun 运行。Bun 依次查找：插件配置 `bunPath`、环境变量 `DSH_STUDIO_BUN`、运行副本里随依赖复制过来的 Bun、安装目录各级 `node_modules/@oven/bun-<平台>`（工作室包把各平台的 Bun 声明为可选依赖）、`DSH_HOME/bun`。
- 服务不写连接信息：以 `toonflowUrl` 的本机端口（默认 33101）首页返回 Toonflow 页面为就绪。端口上已有服务在运行且不是本运行时拉起的（自行从源码启动的），直接沿用，不停止它。`toonflowUrl` 不是本机回环地址时不由运行时管理。
- 数据与运行副本分开：数据库、素材、工作区在 `toonflowDataDirectory`（依次取插件配置、`DSH_STUDIO_TOONFLOW_DATA`、宿主工作目录旁已有的 `../studio-data/toonflow`、`DSH_HOME/studio/toonflow`），运行副本、进程记录与日志在 `DSH_HOME/studio/media`。

不带 `app` 目录的旧版短剧工作室不纳入管理，仍由用户自行启动服务。

### 本机服务栈（剧工作室）

剧工作室（PRINTFILM）依赖 PostgreSQL、Garnet 缓存、Python 后端和两个页面服务，无法随包分发。在 profile 的 `dsh-studio-projects.config.printfilmService` 写入三个绝对目录后，运行时按顺序直接拉起整套服务，不需要 PowerShell 启动脚本：

```yaml
- id: dsh-studio-projects
  config:
    printfilmService:
      appDirectory: D:/studio-apps/printfilm        # 应用源码：backend、frontend/dist、admin/dist、.venv
      runtimeDirectory: D:/studio-runtime           # 专用运行时：pgsql、garnet、dotnet、node、ffmpeg
      dataDirectory: D:/studio-data/printfilm       # 数据：runtime.json（数据库密码与密钥）、postgres、garnet
```

也可以用环境变量 `DSH_STUDIO_PRINTFILM_APP`、`DSH_STUDIO_PRINTFILM_RUNTIME`、`DSH_STUDIO_PRINTFILM_DATA`。三个目录都没有给时，剧工作室在控制台显示「未配置启动脚本」，服务仍由用户自行启动。

- 启动顺序：数据库（`pg_ctl`，端口 35432）→ 缓存（36379）→ 后端接口（33104）→ 前台（`printfilmUrl` 的端口，默认 33102）→ 管理后台（33103）。每一步先看端口：已经在监听的直接沿用，只补缺的那几个；整套服务健康时什么也不做。
- 环境变量与原启动脚本一致，数据库密码和密钥读取 `dataDirectory/runtime.json`。Node 可用 `DSH_STUDIO_NODE` 指定；`DSH_STUDIO_PRINTFILM_SINGLE_USER=0` 恢复邮箱登录。
- 日志写在 `dataDirectory/logs/<进程名>.log` 与 `.error.log`。失败原因（缺少文件、端口被占用、进程启动后退出及错误日志最后一行、启动超时）显示在控制台对应工作室那一行。
- 与随包服务一样：工作室登记时自动启动，页面读取连接状态时自动重试，控制台可「一键启动」；退出桌面不停止已运行的服务。`printfilmUrl` 不是本机回环地址时不由运行时管理。在 `autoStartServices` 里为剧工作室写了启动组时以启动组为准。

### 配置的启动组

Windows 开发入口在 profile 的 `dsh-studio-projects.config.autoStartServices` 写入启动组；普通桌面加载共享运行时也会执行。每组指定 `label`、`studioIds`、程序 `command`、参数 `args`、工作目录 `cwd`、日志 `logFile` 和正整数 `timeoutMs`；程序、目录和日志使用绝对路径。短剧和影视复用 Harness 的 `scripts/studio-apps.ps1`，影音使用工作库的 `scripts/start-cineflow.ps1`。已有服务按原启动器的身份记录复用。

连接接口等待启动脚本结束，再检查真实健康状态；启动失败在对应工作室显示原因和日志路径，其他页面仍可使用。插件停用或退出桌面只取消尚在执行的启动脚本，不停止已经运行的独立服务。清空 `autoStartServices` 可关闭自动启动；`DSH_STUDIO_SKIP_APPS=1` 可临时跳过。首次配置的原文备份为 `cordis.patch.yml.before-studio-startup`。

## 卸载子工作室

控制台的工作室列表里，每个子工作室右侧有「卸载」（垃圾桶图标），点击后在该行确认。卸载交给 dsh 插件管理器完成，只移除插件本身：

- 没有在运行的工作室直接移除。
- 桌面 profile 没有热重载，自启动起就在运行的工作室不能当场移除：运行时先把它停用并记为待卸载（`DSH_HOME/studio/updates/removals.json`），该行显示「已停用，完整重启 DSH 后完成卸载」；下次启动时它不再加载，运行时自动完成移除。重启前在插件管理器里重新启用它，就等于取消卸载。
- 卸载前先停止该工作室由运行时拉起的随包服务（影音、短剧），只停确认是自己拉起的进程；用户自行启动的服务和剧的本机服务栈不动。
- 工作室的数据目录（数据库、素材、设置）不在安装目录里，不会被删除。工作室库自身与共享运行时没有卸载入口。
- 失败原因（由 DSH 安装包提供而不能卸载、插件管理器执行出错等）显示在弹窗里，该行恢复可操作。

## 版本与更新

在工作室公共工具栏选择“版本与更新”，查看已登记工作室的插件版本，检查各自 GitHub 正式发布，并通过 dsh 插件管理器安装适配包。发布页必须同时提供安装包与 schemaVersion 1 的 manifest.json；每个 artifacts 条目包含 name、version、file、sha256、dsh 和可选 dshVersions。检查只接受插件 package.json 的 GitHub repository，不使用原应用安装器。发布列表按时间倒序读取，读到已安装版本的清单就停，不再下载更早的发布。尚未发布、网络失败和不兼容分别显示；检查结果保留在内存里，控制台在重新打开时对失败超过一分钟或结果超过十五分钟的工作室重新检查，也可以点「检查更新」全部重查；安装前核对摘要及包内名称和版本。

更新记录及安装包保存在 DSH_HOME/studio/updates；安装不清空账号、历史、配置或媒体。关闭面板不会中断安装，提示需要重启时完整退出并重新打开 dsh。中断后无法确认的结果显示为未知，重启后核对插件版本。profile 的 updates 支持 timeoutMs、downloadTimeoutMs、maxPackageBytes、directory，分别控制检查超时、下载超时、安装包大小上限及绝对更新目录。

旧安装包缺少 repository 时，可在 profile 的 `updates.repositories` 按插件包名配置 `owner/repository`，例如 `dsh-studio-media: 1997liuyh-boop/dsh-studio-media`；此配置优先于安装包声明。它只选择受控的插件发布仓库，不接受下载 URL。损坏的更新记录只暂停升级，工作室其他功能仍可使用。
