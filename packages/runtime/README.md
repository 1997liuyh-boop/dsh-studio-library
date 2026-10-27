# 工作库共享运行时

提供所有者认证、插件资源登记与 Toonflow 共享会话。业务页面由各工作室独立拥有；通过 studioProjects.register 登记，卸载撤销新请求。构建：`node scripts/build.mjs runtime`。

向普通新会话提供 `studio` 工具：列举、打开、读取、点击、填写、选择和滚动。命令通过所有者认证的内存队列交给主窗口，结果来自实际页面；取消、超时与插件停用会撤销待执行命令。接入规范见 `packages/sdk/CONTROL.md`。
