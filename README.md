# dsh 工作室共享基础库

本项目配合 [1997liuyh-boop/deepseek-harness](https://github.com/1997liuyh-boop/deepseek-harness) 使用；该宿主 **fork 自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**。感谢 DeepSeek 团队及上游贡献者。当前已验证的适配目标为 **dsh 0.2.1-rc.2（实验性）**，Windows 桌面端优先。

本仓库只维护工作室容器、共享运行时、SDK 和仓库索引。**一个工作室一个仓库**，八个业务工作室各自开发、构建和发布。

## 工作室仓库

| 工作室 | 独立仓库 | 来源方式 |
| --- | --- | --- |
| 旅行工作室 | [dsh-studio-travel](https://github.com/1997liuyh-boop/dsh-studio-travel) | 源码改编 |
| AI 学习路线 | [dsh-studio-knowledge](https://github.com/1997liuyh-boop/dsh-studio-knowledge) | 公开页面参考 |
| AI 短剧工作台 | [dsh-studio-media](https://github.com/1997liuyh-boop/dsh-studio-media) | 独立服务与补丁适配 |
| 健身记录 | [dsh-studio-fitness](https://github.com/1997liuyh-boop/dsh-studio-fitness) | 原创实现 |
| AI 剧工作台 | [dsh-studio-film](https://github.com/1997liuyh-boop/dsh-studio-film) | 独立服务与补丁适配 |
| 影音工作室 | [dsh-studio-cineflow](https://github.com/1997liuyh-boop/dsh-studio-cineflow) | 源码改编 |
| 直播工作室 | [dsh-studio-live](https://github.com/1997liuyh-boop/dsh-studio-live) | B站弹幕、VRM、云端语音、OBS、星露谷与 Minecraft 本机测试服接口 |
| 设计工作室 | [dsh-studio-design](https://github.com/1997liuyh-boop/dsh-studio-design) | MasterGo Vibe MCP、Reborn UI 与项目配置协作 |

## 来源与感谢

容器基于 [Aisland-SJL/dsh-worktable](https://github.com/Aisland-SJL/dsh-worktable) 0.4.0 改编，保留原 MIT 版权与许可证。感谢原作者提供工作室容器、分屏布局与控制室基础。悬浮球协作参考 [mini-yifan/deepseek-harness-orb](https://github.com/mini-yifan/deepseek-harness-orb)。详细来源、锁定提交和许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 构建与安装

需要 Node.js 22 或更新版本、npm、Git。

```powershell
git clone https://github.com/1997liuyh-boop/dsh-studio-library.git
cd dsh-studio-library
npm ci --ignore-scripts
npm ci --prefix packages/worktable --ignore-scripts
npm run build
npm run check
npm test
npm run test:worktable
npm run pack
```

artifacts 生成 dsh-worktable 0.6.0、dsh-studio-projects 0.5.0 两个 tgz 及 SHA256 清单。用实际桌面应用自带的 dsh CLI 依次执行 plugin --profile desktop add <tgz绝对路径>，再安装各独立工作室的安装包，最后重启宿主。网页端使用 web profile。源码目录不作为运行数据目录。

GitHub Actions 的构建产物包含完整 tgz 和摘要清单，可在 Actions 的对应成功构建中下载。宿主必须具备本分支的工作室/会话桥适配，未经适配的官方版本不保证直接兼容。

## 多仓库联调与升级

按 registry.json 将各工作室克隆为本仓库的同级目录，分别构建。设置 DSH_HARNESS_ROOT 指向已构建的宿主后，运行 npm run test:integration，验证原有工作室在真实 Loader 中的注册与清理；设计工作室在其独立仓库运行 npm run test:host，验证正式包解析、路由与内置 MCP。独立仓库日常构建不要求其他工作室存在。

共享 SDK 的源码快照和版本在各库 SDK-SNAPSHOT.json 记录；协议更新先修改本仓库，再同步受影响工作室。各插件保留独立版本，dsh 升级后先验证兼容范围。新增工作室按 [开发规范](CONTRIBUTING.md) 建立新仓库，再登记 registry.json。

普通会话可以请求“打开影音工作室，筛选日本动画、2025 年，按评分排序”，共享运行时通过受控 studio 工具操作真实页面。接口见 [工作室控制协议](packages/sdk/CONTROL.md)。
