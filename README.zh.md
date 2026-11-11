# dsh-studio-library

[English](README.md)

## 仓库信息

- 仓库名称：`dsh-studio-library`
- 仓库描述：可安装的 DSH 工作室控制组合包，提供工作室发现、项目容器、服务状态、会话和更新能力；业务工作室按需安装。
- 仓库地址：`https://github.com/1997liuyh-boop/dsh-studio-library`

## 功能

- `dsh-worktable`：工作室列表、控制室、项目容器、分屏工作区和窗口布局。
- `dsh-studio-projects`：工作室注册、页面托管、本机服务启动与健康状态、会话工具、快捷任务展开和更新记录。
- 项目数据和更新记录按工作室隔离，默认位于 `DSH_HOME/studio/<studio-id>/`。
- 根包只组合两个控制层插件，不安装业务工作室，也不包含私有 Live2D/Cubism 资源。
- 根清单声明 `dsh.bundle.patch`；`packages/worktable` 与 `packages/runtime` 保留独立清单和已构建的 Host/Client 入口。

## 安装

请完整退出 Desktop 后使用官方插件管理器；Windows 也可以使用安装目录中的 `resources/runtime/cli/bin/dsh.cmd`。先安装控制组合包，再按需安装业务工作室：

```powershell
& "<Desktop安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:1997liuyh-boop/dsh-studio-library#v0.1.15"
& "<Desktop安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop list
```

第一条命令会安装 `dsh-worktable` 和 `dsh-studio-projects`；没有业务工作室也是有效状态。再按各工作室 README 添加需要的插件。使用 `plugin --profile desktop list` 验证安装条目；清单必须包含 `dsh.bundle.patch`，并且包内存在声明的 `main` 入口和补丁文件。包操作后重新启动 Desktop。

Git 提交不会更新已安装的锁文件，升级时请重新安装精确 tag。移除旧组合包前保留 `DSH_HOME/studio/`，并先安装需要保留的业务工作室。

## 要求与限制

使用兼容 DSH `0.2.2-rc.1` 的构建；源码构建需要 Node.js 22。本机应用、OBS、外部服务和模型素材需要分别配置。公开包不包含凭据、私有模型文件或 Cubism Core。

## 许可与来源

本项目使用 MIT 许可。工作台适配保留 `SDK-SNAPSHOT.json` 和仓库文件中记录的上游声明。
