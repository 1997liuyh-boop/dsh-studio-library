// 工作室库随包子插件（dsh-worktable、dsh-studio-projects）的重复安装检测与清理。
//
// 为什么需要：profile 里另有一份同名包时（插件市场的 dsh-studio-library#worktable / #runtime 条目、
// 上游同名的 dsh-worktable，或安装失败时留下的依赖），工作室库自带的版本会被盖住，之后无论怎么升级工作室库，
// 控制室等功能都停在那一份的旧版本。盖住的途径有两条，必须一起处理：
// 1. 宿主按包名先从 profile 根目录解析插件：profile 顶层有同名目录，加载的就是它；
// 2. profile 的 bundles 登记了同名包：它的补丁插入同 id 的条目，覆盖工作室库的条目。
//
// 处理方式：
// - 顶层同名目录换成指向工作室库自带副本的目录联接（Windows 用 junction，其他系统用目录符号链接），
//   原目录挪进 node_modules/.dsh-studio-library-duplicates/ 备份。这样无论宿主走哪条途径，加载的都是工作室库自带的版本，
//   依赖也按真实路径从工作室库里解析；以后升级工作室库，联接自动指向新版本。
// - 从 profile 的 package.json 去掉对这些包的直接依赖与 bundles 登记。安装脚本运行在 pnpm 过程中，pnpm 结束时会整份写回
//   package.json，所以这一步只在运行时（DSH 启动后）做。
// 宿主插件管理器移除不了这些重复包：它们与工作室库自带的那份 id、包名完全相同，管理器会判定「正在使用」。
// 只在工作室库已安装、且自带了对应子插件时处理；单独安装子插件（没装工作室库）属于正常用法，不动。
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

export const LIBRARY = 'dsh-studio-library'
/** 被替换下来的重复目录存放处（profile 的 node_modules 下，以点开头，宿主不会解析到）。 */
export const BACKUP_DIR = '.dsh-studio-library-duplicates'
/** 每个包名最多保留的备份份数，更早的删除。 */
const KEEP_BACKUPS = 2
/** 本仓库地址：用来区分「插件市场里本仓库的子包」与「别的作者的同名包」。 */
const OWN_REPOSITORY = /1997liuyh-boop\/dsh-studio-library/i

/**
 * @typedef {object} Duplicate
 * @property {string} name 包名。
 * @property {string} bundledVersion 工作室库自带的版本。
 * @property {string} [version] profile 顶层那份的版本；目录不存在或读不出时缺省。
 * @property {'library' | 'other'} source library：本仓库（插件市场的子包条目）；other：别的作者的同名包。
 * @property {string} [repository] 顶层那份声明的仓库地址或依赖来源，供界面显示。
 * @property {boolean} present profile 顶层有同名目录且不是指向工作室库自带副本的联接（它会盖住自带的版本）。
 * @property {boolean} declared profile 的 package.json 直接依赖了它。
 * @property {boolean} selected profile 的 bundles 登记了它。
 * @property {boolean} linked profile 顶层已经是指向工作室库自带副本的联接。
 */

/** 读取 JSON；文件不存在或损坏时返回 undefined。 */
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
}

/** 路径本身是否存在（不跟随链接，失效的联接也算存在）。 */
async function occupied(path) {
  try { await lstat(path); return true } catch { return false }
}

/** 解析联接与 Windows 短路径后再比较，避免同一目录被误判为两份。 */
async function samePath(a, b) {
  try { return (await realpath(a)) === (await realpath(b)) } catch { return false }
}

/**
 * 从某个目录向上找 profile 根目录：package.json 里声明了 dsh.profile 的那一层。
 * @param {string} start 起点（工作室库或运行时的安装目录）。
 * @returns {Promise<string | undefined>}
 */
export async function findProfileDir(start) {
  let dir = resolve(start)
  for (let depth = 0; depth < 16; depth += 1) {
    const manifest = await readJson(join(dir, 'package.json'))
    if (manifest?.dsh?.profile && typeof manifest.dsh.profile === 'object') return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * 找出 profile 里会盖住工作室库自带子插件的重复安装。
 * @param {string} profileDir profile 根目录。
 * @returns {Promise<Duplicate[]>}
 */
export async function findDuplicates(profileDir) {
  const libraryDir = join(profileDir, 'node_modules', LIBRARY)
  const library = await readJson(join(libraryDir, 'package.json'))
  if (library?.name !== LIBRARY || !Array.isArray(library.bundleDependencies)) return []
  const manifest = (await readJson(join(profileDir, 'package.json'))) ?? {}
  const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const result = []
  for (const name of library.bundleDependencies) {
    if (typeof name !== 'string' || !/^dsh-[a-z0-9-]+$/.test(name)) continue
    const bundledDir = join(libraryDir, 'node_modules', name)
    const bundled = await readJson(join(bundledDir, 'package.json'))
    // 工作室库没带这个子插件（例如还原失败）时不处理，免得指向一个空目录
    if (bundled?.name !== name) continue
    const topDir = join(profileDir, 'node_modules', name)
    const linked = await samePath(topDir, bundledDir)
    const present = !linked && await occupied(topDir)
    const top = present ? await readJson(join(topDir, 'package.json')) : undefined
    const spec = typeof dependencies[name] === 'string' ? dependencies[name] : undefined
    const declared = spec !== undefined
    const selected = bundles.includes(name)
    if (!present && !declared && !selected) continue
    const repositoryField = top?.repository
    const repository = (typeof repositoryField === 'string' ? repositoryField : typeof repositoryField?.url === 'string' ? repositoryField.url : undefined) ?? spec
    result.push({
      name,
      bundledVersion: String(bundled.version ?? ''),
      ...(typeof top?.version === 'string' ? { version: top.version } : {}),
      source: OWN_REPOSITORY.test(String(repository ?? '')) ? 'library' : 'other',
      ...(repository ? { repository } : {}),
      present,
      declared,
      selected,
      linked,
    })
  }
  return result
}

/** 原子写回 package.json，保留原换行符。 */
async function writeManifest(path, value, newline) {
  const temporary = join(dirname(path), '.package-' + randomUUID() + '.json')
  await writeFile(temporary, (JSON.stringify(value, null, 2) + '\n').replace(/\n/g, newline))
  await rename(temporary, path)
}

/** 每个包名只留最近 KEEP_BACKUPS 份备份。 */
async function pruneBackups(backupRoot, name) {
  let entries
  try { entries = await readdir(backupRoot) } catch { return }
  const mine = entries.filter(entry => entry.startsWith(name + '-')).sort().reverse()
  for (const stale of mine.slice(KEEP_BACKUPS)) await rm(join(backupRoot, stale), { recursive: true, force: true }).catch(() => {})
}

/** 在 path 处建立指向 target 的目录联接。 */
async function link(target, path) {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * 把顶层同名目录换成指向工作室库自带副本的联接，原目录挪去备份；联接建不起来时把原目录放回去。
 * @returns {Promise<string | undefined>} 备份位置；原本没有目录时为 undefined。
 */
async function replaceWithLink(profileDir, name, bundledDir, stamp) {
  const topDir = join(profileDir, 'node_modules', name)
  let backup
  if (await occupied(topDir)) {
    const backupRoot = join(profileDir, 'node_modules', BACKUP_DIR)
    await mkdir(backupRoot, { recursive: true })
    backup = join(backupRoot, `${name}-${stamp}`)
    if (await occupied(backup)) backup += '-' + randomUUID().slice(0, 8)
    const stats = await lstat(topDir)
    if (stats.isSymbolicLink()) {
      // 指向别处的链接只记下指向，不把目标整份搬走
      await writeFile(backup + '.link.txt', await realpath(topDir).catch(() => '（失效的链接）') + '\n')
      await rm(topDir, { force: true })
      backup += '.link.txt'
    } else await rename(topDir, backup)
  }
  try { await link(bundledDir, topDir) }
  catch (error) {
    // 联接失败（例如文件系统不支持）：退回到复制一份，至少保证加载的是自带的版本
    try { await cp(bundledDir, topDir, { recursive: true }) }
    catch {
      if (backup && !backup.endsWith('.link.txt')) await rename(backup, topDir).catch(() => {})
      throw error
    }
  }
  if (backup) await pruneBackups(dirname(backup), name)
  return backup
}

/**
 * 清理重复安装。
 * @param {string} profileDir profile 根目录。
 * @param {{ manifest?: boolean, now?: Date }} [options]
 *   manifest：是否改 profile 的 package.json（默认是）。安装脚本运行在 pnpm 过程中，pnpm 结束时会整份写回 package.json，
 *   所以安装脚本传 false，只换联接，依赖与 bundles 登记交给下次启动的运行时去掉。
 * @returns {Promise<{ duplicates: Duplicate[], replaced: { name: string, backup?: string }[], manifestChanged: boolean, failures: { name: string, message: string }[] }>}
 *   replaced 里原本有目录的项（backup 非空）说明当前加载的是被替换掉的那份，需要重启 DSH 才会换成工作室库自带的版本。
 */
export async function cleanDuplicates(profileDir, options = {}) {
  const { manifest: editManifest = true, now = new Date() } = options
  const duplicates = await findDuplicates(profileDir)
  const replaced = []
  const failures = []
  let manifestChanged = false
  if (!duplicates.length) return { duplicates, replaced, manifestChanged, failures }
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const libraryModules = join(profileDir, 'node_modules', LIBRARY, 'node_modules')
  for (const item of duplicates) {
    // 顶层有别的目录：换成联接。没有目录但仍声明或登记着：也建联接，否则登记的条目找不到包，连工作室库的条目一起失效
    const needsLink = item.present || (!item.linked && (item.declared || item.selected))
    if (!needsLink) continue
    try { replaced.push({ name: item.name, backup: await replaceWithLink(profileDir, item.name, join(libraryModules, item.name), stamp) }) }
    catch (error) { failures.push({ name: item.name, message: error instanceof Error ? error.message : String(error) }) }
  }
  if (editManifest && duplicates.some(item => item.declared || item.selected)) {
    const path = join(profileDir, 'package.json')
    try {
      const text = await readFile(path, 'utf8')
      const value = JSON.parse(text)
      const names = new Set(duplicates.map(item => item.name))
      if (value.dependencies && typeof value.dependencies === 'object') for (const name of names) delete value.dependencies[name]
      if (Array.isArray(value.dsh?.profile?.bundles)) value.dsh.profile.bundles = value.dsh.profile.bundles.filter(item => !names.has(item))
      await writeManifest(path, value, text.includes('\r\n') ? '\r\n' : '\n')
      manifestChanged = true
    } catch (error) {
      failures.push({ name: 'package.json', message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { duplicates, replaced, manifestChanged, failures }
}
