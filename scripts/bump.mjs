// 发布前升版本号：node scripts/bump.mjs <总包新版本> [--all]
// 一次改齐总包的 package.json、package-lock.json、catalog.json 与 README 安装命令；
// 自上一个发布标签以来有改动的子插件（--all 时全部）补丁位加一，同步写入它的 package.json、dsh.plugin.json 与 package-lock.json。
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedSince, greater, nextPatch, parseVersion, previousTag, readJson, subPackages, writeJson } from './versions.mjs'

/**
 * 计算并写回全部版本号。
 * @param {string} root 仓库根目录。
 * @param {string} version 总包新版本。
 * @param {{ all?: boolean, since?: string }} options all：子插件全部升级；since：比较起点，缺省为上一个发布标签。
 * @returns {Promise<{ library: { from: string, to: string }, packages: { name: string, from: string, to: string, changed: string[] }[] }>}
 */
export async function bump(root, version, options = {}) {
  parseVersion(version)
  const rootPath = join(root, 'package.json'), lockPath = join(root, 'package-lock.json'), catalogPath = join(root, 'catalog.json')
  const pkg = await readJson(rootPath)
  const from = pkg.value.version
  if (!greater(version, from)) throw new Error(`新版本 ${version} 需要大于当前版本 ${from}`)
  const since = options.since ?? previousTag(root, 'v' + version)
  const lock = await readJson(lockPath)
  const packages = []
  for (const sub of await subPackages(root)) {
    const changed = since ? changedSince(root, sub.path, since) : ['（没有更早的发布标签）']
    if (!options.all && changed.length === 0) continue
    const to = nextPatch(sub.version)
    for (const file of ['package.json', 'dsh.plugin.json']) {
      const path = join(root, sub.path, file)
      const json = await readJson(path)
      if (json.value.version !== sub.version) throw new Error(`${sub.path}/${file} 的版本 ${json.value.version} 与 package.json 的 ${sub.version} 不一致`)
      json.value.version = to
      await writeJson(path, json.value, json.newline)
    }
    if (lock.value.packages?.[sub.path]) lock.value.packages[sub.path].version = to
    packages.push({ name: sub.name, from: sub.version, to, changed })
  }
  pkg.value.version = version
  await writeJson(rootPath, pkg.value, pkg.newline)
  lock.value.version = version
  if (lock.value.packages?.['']) lock.value.packages[''].version = version
  await writeJson(lockPath, lock.value, lock.newline)
  const catalog = await readJson(catalogPath)
  catalog.value.version = version
  await writeJson(catalogPath, catalog.value, catalog.newline)
  // README 里的安装命令固定到 #v<版本>
  for (const name of ['README.md', 'README.zh.md']) {
    const path = join(root, name)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace(/(dsh-studio-library#v)\d+\.\d+\.\d+/g, `$1${version}`))
  }
  return { library: { from, to: version }, packages }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version] = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
  if (!version) { console.error('用法：node scripts/bump.mjs <总包新版本> [--all]'); process.exit(2) }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const result = await bump(root, version, { all: process.argv.includes('--all') })
  console.log(`dsh-studio-library ${result.library.from} → ${result.library.to}`)
  for (const item of result.packages) console.log(`${item.name} ${item.from} → ${item.to}（${item.changed.length} 个改动文件）`)
  if (!result.packages.length) console.log('子插件自上一个发布以来没有改动，版本号保持不变')
  console.log('请重新构建（npm run build）后提交，再打标签 v' + version)
}
