// 发布前校验版本号（CI 在打标签后、测试前运行；本地发布前也可运行）：
// 1. 标签与总包 package.json、package-lock.json、catalog.json、README 安装命令一致；
// 2. 每个子插件的 package.json、dsh.plugin.json、package-lock.json 版本一致；
// 3. 自上一个发布标签以来有改动的子插件，版本号必须大于上一个发布里的版本。
// 用法：node scripts/check-versions.mjs [标签]，标签缺省取环境变量 RELEASE_TAG，再缺省为 v<package.json 版本>。
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedSince, greater, previousTag, readJson, subPackages, versionAt } from './versions.mjs'

/**
 * 返回发现的问题；空数组表示通过。
 * @param {string} root 仓库根目录。
 * @param {string} tag 本次发布标签（v<版本>）。
 * @param {{ since?: string, until?: string }} options since：比较起点，缺省为上一个发布标签；until：比较终点，缺省为工作区。
 */
export async function checkVersions(root, tag, options = {}) {
  const issues = []
  const pkg = (await readJson(join(root, 'package.json'))).value
  const lock = (await readJson(join(root, 'package-lock.json'))).value
  const catalog = (await readJson(join(root, 'catalog.json'))).value
  if (tag !== 'v' + pkg.version) issues.push(`标签 ${tag} 与 package.json 版本 ${pkg.version} 不一致`)
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) issues.push(`package-lock.json 的总包版本与 package.json（${pkg.version}）不一致`)
  if (catalog.version !== pkg.version) issues.push(`catalog.json 的版本 ${catalog.version} 与 package.json（${pkg.version}）不一致`)
  for (const name of ['README.md', 'README.zh.md']) {
    const pinned = [...(await readFile(join(root, name), 'utf8')).matchAll(/dsh-studio-library#v(\d+\.\d+\.\d+)/g)].map(match => match[1])
    if (pinned.some(version => version !== pkg.version)) issues.push(`${name} 的安装命令没有固定到 v${pkg.version}`)
  }
  const since = options.since ?? previousTag(root, tag)
  for (const sub of await subPackages(root)) {
    const plugin = (await readJson(join(root, sub.path, 'dsh.plugin.json'))).value
    if (plugin.version !== sub.version) issues.push(`${sub.path}/dsh.plugin.json 的版本 ${plugin.version} 与 package.json 的 ${sub.version} 不一致`)
    if (lock.packages?.[sub.path] && lock.packages[sub.path].version !== sub.version) issues.push(`package-lock.json 中 ${sub.path} 的版本与 package.json 的 ${sub.version} 不一致`)
    if (!since) continue
    const changed = changedSince(root, sub.path, since, options.until)
    const before = versionAt(root, since, sub.path)
    if (changed.length && before && !greater(sub.version, before)) {
      issues.push(`${sub.name} 自 ${since} 以来有 ${changed.length} 个文件改动（如 ${changed.slice(0, 3).join('、')}），版本仍是 ${sub.version}：请用 node scripts/bump.mjs 升级`)
    }
  }
  return issues
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const pkg = (await readJson(join(root, 'package.json'))).value
  const tag = process.argv[2] ?? process.env.RELEASE_TAG ?? 'v' + pkg.version
  // CI 校验的是标签对应的提交：比较终点用 HEAD，不受工作区影响
  const issues = await checkVersions(root, tag, process.env.CI ? { until: 'HEAD' } : {})
  if (issues.length) {
    console.error('版本号检查未通过：\n- ' + issues.join('\n- '))
    process.exit(1)
  }
  console.log('版本号检查通过：' + tag)
}
