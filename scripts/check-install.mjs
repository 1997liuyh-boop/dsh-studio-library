/** 校验市场发现结果和 Git 安装入口，不连接外部服务。 */
import { readFile, stat, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
const read = async path => JSON.parse(await readFile(path, 'utf8'))
const pkg = await read(join(root, 'package.json'))
const workspacePaths = pkg.workspaces ?? []
const roots = workspacePaths.length ? workspacePaths.map(path => join(root, path)) : pkg.dsh?.bundle ? [root] : []
if (!roots.length) throw new Error('没有可发现的插件。')
if (workspacePaths.length && pkg.dsh?.bundle) {
  await access(join(root, pkg.dsh.bundle.patch))
  if (!pkg.engines?.dsh || pkg.name !== 'dsh-studio-library') throw new Error('控制层组合包名称或兼容范围缺失')
  const names = await Promise.all(roots.map(async directory => (await read(join(directory, 'package.json'))).name))
  if (names.length !== 2 || names.some(name => !pkg.bundleDependencies?.includes(name)) || pkg.bundleDependencies.length !== 2) throw new Error('组合包必须只包含两个控制层插件')
  for (let index = 0; index < names.length; index++) {
    if (pkg.dependencies?.[names[index]] !== 'file:' + workspacePaths[index]) throw new Error('控制层插件依赖路径不同步：' + names[index])
  }
}
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
