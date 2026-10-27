# 独立工作室开发与发布规范

一个工作室对应一个 GitHub 仓库、一份 studio.json 和独立插件包。工作室 ID、包名及页面入口发布后保持稳定；只修改本工作室目录，不导入宿主内部源码。共享容器与运行时在 [dsh-studio-library](https://github.com/1997liuyh-boop/dsh-studio-library) 维护。

packages/sdk 是共享协议的固定源码快照，来源及文件摘要记录在 SDK-SNAPSHOT.json。更新 SDK 时从共享库选定提交同步整个目录，重新记录摘要，并验证模型选择、会话消息、运行状态、停止操作和工具控制。不要在单个工作室中私自改变共享协议。

UI 使用 Tailwind，新增代码注释使用中文。宿主工作室行沿用文件夹的折叠动画与悬停行为。数据、模型凭据、桥接令牌、旅行照片和下载文件保存在 DSH_HOME/studio 或显式外置目录，禁止进入源码与安装包。

每次发布更新对应插件 package.json 版本并构建；运行 npm run check、相关行为测试与 npm run pack，检查 artifacts/manifest.json 的 SHA256。GitHub Actions 上传完整 tgz，不能只交付 lib/static。每个工作室可以独立打标签和发布，无须同时升级其他工作室。

上游更新时，先检出 UPSTREAM.json 中的锁定提交，在新目录重放补丁。保留 LICENSE、UPSTREAM-LICENSE（如有）和来源声明。dsh 升级先验证兼容范围，再更新 studio.json；未经验证不能声称立即兼容。禁止覆盖运行中的服务或用户数据库。
