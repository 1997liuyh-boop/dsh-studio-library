# 工作室容器与共享运行时

本仓库提供两个可独立安装的基础插件：`dsh-worktable` 负责工作室列表、控制室、项目容器和窗口布局；`dsh-studio-projects` 负责工作室注册、页面资源、本机服务连接、会话工具和版本更新。它只提供控制能力和共享运行时，默认不安装业务子工作室。市场以一个“工作室控制台”组合包展示；两个基础插件在 packages/ 下保留独立源码与版本。

## 功能

- 工作室列表：显示已安装的工作室，支持启用、停用、版本检查和适配包升级。
- 控制室：查看当前工作室、启动状态、连接状态、服务地址和最近错误；弹窗使用宿主设置弹窗的浮层层级，不会被卡片或侧栏遮住。
- 项目容器：为每个工作室提供独立项目目录、会话入口、资源窗口和布局状态。
- `studio` 工具：列举、打开、读取、点击、填写、选择和滚动真实工作室页面；取消、超时和停用会撤销待执行命令。
- 本机服务：按工作室配置启动命令、参数、工作目录、日志和健康检查；启动失败保留日志路径并显示重试操作。
- 工作室目录：新增工作室时可选择本地目录或 GitHub 仓库；导入完成后才会出现在工作室列表。AI 代为新增时必须先询问保存位置，完成后再询问是否立即导入。
- 会话工作区：默认位于 `DSH_HOME/studio/<studio-id>/`，项目文件、服务日志和更新记录按工作室隔离，不会写入其他工作室目录。

## 安装顺序

在插件管理器的“添加插件”中填写 `github:1997liuyh-boop/dsh-studio-library`。根包会安装 `dsh-worktable` 与 `dsh-studio-projects` 两个控制层插件，再按需添加业务工作室。安装基础库后列表可以为空；未安装子工作室时不显示业务卡片。

安装子工作室后，如果服务尚未启动，页面会显示“工作台暂未连接：请确认本机工作室服务已经启动，再重新连接”，并提供重新连接入口。该提示表示连接状态未知，不会伪造已启动状态。

## 更新与旧组合库迁移

GitHub 的代码提交不会自动更新已经安装的插件：Desktop profile 的锁文件固定已安装提交，重启也会继续使用该提交。请通过插件管理器重新安装所需版本，或在完整退出 Desktop 后使用其自带 CLI 更新；不要直接编辑锁文件或复制 `node_modules`。

旧的 `dsh-studio-library` 组合包包含业务子工作室。迁移前先记录正在使用的子工作室，将其安装成 profile 的直接依赖，再移除旧组合库。现有项目与更新数据位于 `DSH_HOME/studio/`；保留该目录。直播模型若存放在旧包目录内，请先另存到用户模型目录，公开直播包不包含私有模型和 Cubism Core。

1. 保存任务，备份 `DSH_HOME/studio/`，从菜单或托盘完整退出 Desktop。
2. 使用当前 Desktop 安装目录中的 `resources/runtime/cli/bin/dsh.cmd`。先运行 `plugin --profile desktop list` 核对原有插件，再对正在使用的每个子工作室执行 `add`。例如保留旅行工作室：

   ```powershell
   & "<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:1997liuyh-boop/dsh-studio-travel"
   ```

3. 确认所有需要保留的子工作室均已成功添加；任何一步失败都先停止迁移。随后移除旧组合库，再安装本仓库的新控制层组合包：

   ```powershell
   & "<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-studio-library
   & "<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:1997liuyh-boop/dsh-studio-library"
   & "<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop list
   ```

4. 确认列表包含控制层组合包和自己选择的子工作室，再打开 Desktop，检查工作室列表、项目目录和连接状态。若安装器提示原生依赖构建待批准，按其提示批准 `node-pty` 的构建后再测试终端。

各子工作室在“添加插件”中的来源如下；只添加自己需要的项目：

| 工作室 | 安装来源 |
| --- | --- |
| 设计 | `github:1997liuyh-boop/dsh-studio-design` |
| 户型 | `github:1997liuyh-boop/dsh-studio-floorplan` |
| 直播 | `github:1997liuyh-boop/dsh-studio-live` |
| 旅行 | `github:1997liuyh-boop/dsh-studio-travel` |
| 知识 | `github:1997liuyh-boop/dsh-studio-knowledge` |
| 健身 | `github:1997liuyh-boop/dsh-studio-fitness` |
| 影音 | `github:1997liuyh-boop/dsh-studio-media` |
| 影视 | `github:1997liuyh-boop/dsh-studio-film` |
| CineFlow | `github:1997liuyh-boop/dsh-studio-cineflow` |

独立业务插件的升级也需更新其已安装依赖。工作室内的“检查更新”只有在上游发布对应适配安装包后才能升级，源码提交本身不会生成该安装包。

## 开发与构建

需要 Node.js 22 及 npm。运行 `npm install --include=dev --legacy-peer-deps`、`npm run build`、`npm run check` 和 `npm test`。`npm run pack` 只为两个控制层插件生成带 SHA256 的归档；Git 安装使用仓库提交的编译产物，并在安装时检查与恢复这两个插件。业务子工作室在各自仓库中单独构建。

## 数据与限制

工作室项目、会话关联、布局和更新记录保存在 `DSH_HOME/studio/`。卸载基础库不会删除业务工作室的数据，但会停止控制入口。外部应用、OBS、TMDB、地图服务和模型素材需要用户自行配置；本仓库不包含这些应用或凭据。

工作台的原始容器来自 [Aisland-SJL/dsh-worktable](https://github.com/Aisland-SJL/dsh-worktable)，保留 MIT 许可。共享 SDK 固定副本与来源见 `SDK-SNAPSHOT.json`。
