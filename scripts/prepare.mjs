import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 公共仓库提交编译产物，Git 安装只检查入口和生成控制层归档。
const root = fileURLToPath(new URL('../', import.meta.url))
for (const script of ['check-install', 'pack']) {
  const result = spawnSync(process.execPath, [`scripts/${script}.mjs`], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`工作库准备失败：${script}（退出码 ${result.status}）`)
}
