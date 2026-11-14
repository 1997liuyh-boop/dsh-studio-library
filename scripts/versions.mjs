// 发布版本工具：总包与随包子插件（dsh-worktable、dsh-studio-projects）的版本号读取、比较与写回。
// 子插件随总包一起分发，但安装器（pnpm、DSH 插件管理器）按「包名 + 版本」判断是否已装好：
// 子插件代码变了而版本号不变，换电脑或升级时旧副本可能不会被替换，也无法从版本号看出装的是哪一份。
// 因此发布时，自上一个版本以来有改动的子插件必须升版本号，由 bump.mjs 自动完成、check-versions.mjs 在发布前校验。
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 读取 JSON，同时记住原文件的换行符，写回时保持一致。 */
export async function readJson(path) {
  const text = await readFile(path, 'utf8')
  return { value: JSON.parse(text), newline: text.includes('\r\n') ? '\r\n' : '\n' }
}

/** 按两空格缩进写回 JSON，保留原换行符与结尾换行。 */
export async function writeJson(path, value, newline = '\n') {
  await writeFile(path, (JSON.stringify(value, null, 2) + '\n').replace(/\n/g, newline))
}

/** 只接受 x.y.z 形式的版本号。 */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version))
  if (!match) throw new Error('版本号需要是 x.y.z 形式：' + version)
  return match.slice(1).map(Number)
}

/** 补丁位加一。 */
export function nextPatch(version) {
  const [major, minor, patch] = parseVersion(version)
  return `${major}.${minor}.${patch + 1}`
}

/** a 是否严格大于 b。 */
export function greater(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] > y[index]
  return false
}

/** 在仓库根目录执行 git，返回去掉首尾空白的输出。 */
export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * 子插件清单：catalog.json 里登记、并在根包 bundleDependencies 中声明的包。
 * @returns {{ id: string, path: string, name: string, version: string }[]}
 */
export async function subPackages(root) {
  const catalog = (await readJson(join(root, 'catalog.json'))).value
  const bundled = (await readJson(join(root, 'package.json'))).value.bundleDependencies ?? []
  const result = []
  for (const item of catalog.packages ?? []) {
    const pkg = (await readJson(join(root, item.path, 'package.json'))).value
    if (bundled.includes(pkg.name)) result.push({ id: item.id, path: item.path, name: pkg.name, version: pkg.version })
  }
  return result
}

/**
 * 上一个发布标签：按版本排序的 v* 标签中，排除 exclude（当前要发布的标签）后最新的一个。
 * @returns {string | undefined} 没有任何标签时为 undefined。
 */
export function previousTag(root, exclude) {
  const tags = git(root, ['tag', '--list', 'v*', '--sort=-v:refname']).split('\n').map(tag => tag.trim()).filter(Boolean)
  return tags.find(tag => tag !== exclude && /^v\d+\.\d+\.\d+$/.test(tag))
}

/**
 * 子插件自 since 以来是否有会进入安装包的改动（测试目录不算）。
 * @param {string} since 比较起点（标签或提交）。
 * @param {string} until 比较终点，缺省为工作区（含未提交改动）。
 */
export function changedSince(root, path, since, until) {
  const args = ['diff', '--name-only', since, ...(until ? [until] : []), '--', path]
  return git(root, args).split('\n').map(file => file.trim()).filter(file => file && !file.startsWith(path + '/tests/'))
}

/** 某个提交里子插件 package.json 的版本号；那时还没有这个文件则为 undefined。 */
export function versionAt(root, ref, path) {
  try { return JSON.parse(git(root, ['show', `${ref}:${path}/package.json`])).version }
  catch { return undefined }
}
