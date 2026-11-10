/** 校验市场发现结果和 Git 安装入口，不连接外部服务。 */
import { readFile, stat, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
const read = async path => JSON.parse(await readFile(path, 'utf8'))
const pkg = await read(join(root, 'package.json'))
const roots = pkg.dsh?.bundle ? [root] : (pkg.workspaces ?? []).map(path => join(root, path))
if (!roots.length) throw new Error('没有可发现的插件。')
for (const directory of roots) {
  const plugin = await read(join(directory, 'package.json'))
  if (plugin.private || !plugin.dsh?.bundle?.patch || !plugin.engines?.dsh) throw new Error('插件清单或兼容范围缺失：' + plugin.name)
  const patch = plugin.dsh.bundle.patch
  await access(join(directory, patch))
  const manifest = await read(join(directory, 'dsh.plugin.json'))
  if (plugin.name !== manifest.name || plugin.version !== manifest.version) throw new Error('插件名称或版本不同步：' + plugin.name)
  for (const entry of [plugin.main, plugin.exports?.['./client']].filter(Boolean)) {
    const path = join(directory, entry)
    if (!(await stat(path)).size) throw new Error('安装入口为空：' + path)
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('安装入口语法检查失败：' + path)
  }
  console.log(plugin.name + '@' + plugin.version + '：清单、补丁、Host/Client 入口通过')
}
