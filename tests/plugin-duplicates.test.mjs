import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BACKUP_DIR, cleanDuplicates, findDuplicates, findProfileDir } from '../scripts/plugin-duplicates.mjs'
import { linkDuplicates } from '../scripts/install.mjs'

const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

/**
 * 一个装了工作室库的 profile：库自带 dsh-worktable 0.6.5 与 dsh-studio-projects 0.5.4；
 * 另按 options 在顶层放同名副本、在 package.json 里声明依赖与 bundles。
 */
async function profile(t, { topWorktable = true, topProjects = false, declare = ['dsh-worktable', 'dsh-studio-projects'], select = ['dsh-worktable'], library = true, bundled = true, repository = 'https://github.com/1997liuyh-boop/dsh-studio-library.git' } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'plugin-duplicates-')))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const modules = join(dir, 'node_modules')
  await mkdir(modules, { recursive: true })
  await json(join(dir, 'package.json'), {
    name: 'dsh-profile-desktop', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-studio-library', ...select] } },
    dependencies: { 'dsh-studio-library': 'file:lib.tgz', 'dsh-pet': '0.4.8', ...Object.fromEntries(declare.map(name => [name, 'github:1997liuyh-boop/dsh-studio-library#path:/packages/' + (name === 'dsh-worktable' ? 'worktable' : 'runtime')])) },
  })
  const libraryDir = join(modules, 'dsh-studio-library')
  if (library) {
    await mkdir(libraryDir, { recursive: true })
    await json(join(libraryDir, 'package.json'), { name: 'dsh-studio-library', version: '0.1.25', bundleDependencies: ['dsh-worktable', 'dsh-studio-projects'] })
    if (bundled) for (const [name, version] of [['dsh-worktable', '0.6.5'], ['dsh-studio-projects', '0.5.4']]) {
      await mkdir(join(libraryDir, 'node_modules', name), { recursive: true })
      await json(join(libraryDir, 'node_modules', name, 'package.json'), { name, version })
    }
  }
  const top = async (name, version) => {
    await mkdir(join(modules, name, 'lib'), { recursive: true })
    await json(join(modules, name, 'package.json'), { name, version, repository: { type: 'git', url: repository } })
    await writeFile(join(modules, name, 'lib', 'index.js'), 'export {}\n')
  }
  if (topWorktable) await top('dsh-worktable', '0.6.3')
  if (topProjects) await top('dsh-studio-projects', '0.5.2')
  return { dir, modules, libraryDir, read: async () => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) }
}

/** 顶层同名路径是否已是指向工作室库自带副本的联接。 */
async function linkedToBundled(modules, name) {
  return (await lstat(join(modules, name))).isSymbolicLink()
    && (await realpath(join(modules, name))) === (await realpath(join(modules, 'dsh-studio-library', 'node_modules', name)))
}

test('findProfileDir：从工作室库自带的子插件目录向上找到声明了 dsh.profile 的那一层', async (t) => {
  const { dir, libraryDir } = await profile(t)
  assert.equal(await findProfileDir(join(libraryDir, 'node_modules', 'dsh-studio-projects', 'lib')), dir)
  assert.equal(await findProfileDir(join(dir, 'node_modules', 'dsh-worktable')), dir)
})

test('findDuplicates：顶层副本、直接依赖与 bundles 登记都算；区分本仓库的子包与别的作者的同名包', async (t) => {
  const { dir } = await profile(t)
  const found = await findDuplicates(dir)
  assert.deepEqual(found.map(item => [item.name, item.version, item.bundledVersion, item.source, item.present, item.declared, item.selected, item.linked]), [
    ['dsh-worktable', '0.6.3', '0.6.5', 'library', true, true, true, false],
    ['dsh-studio-projects', undefined, '0.5.4', 'library', false, true, false, false],
  ])
  const other = await profile(t, { declare: [], select: [], repository: 'https://github.com/Aisland-SJL/dsh-worktable.git' })
  const [upstream] = await findDuplicates(other.dir)
  assert.equal(upstream.source, 'other')
  assert.equal(upstream.repository, 'https://github.com/Aisland-SJL/dsh-worktable.git')
})

test('cleanDuplicates：顶层副本换成指向自带副本的联接（原目录备份），去掉依赖与 bundles 登记，其余依赖不动；再跑一次没有可清理的', async (t) => {
  const { dir, modules, read } = await profile(t, { topProjects: true })
  const result = await cleanDuplicates(dir, { now: new Date('2026-11-14T10:00:00Z') })
  assert.deepEqual(result.failures, [])
  assert.equal(result.manifestChanged, true)
  assert.deepEqual(result.replaced.map(item => [item.name, !!item.backup]), [['dsh-worktable', true], ['dsh-studio-projects', true]])
  assert.ok(await linkedToBundled(modules, 'dsh-worktable'))
  assert.ok(await linkedToBundled(modules, 'dsh-studio-projects'))
  assert.equal(JSON.parse(await readFile(join(modules, 'dsh-worktable', 'package.json'), 'utf8')).version, '0.6.5', '经由顶层路径读到的是自带版本')
  const manifest = await read()
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-studio-library', 'dsh-pet'])
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-studio-library'])
  assert.deepEqual((await readdir(join(modules, BACKUP_DIR))).sort(), ['dsh-studio-projects-2026-11-14T10-00-00-000Z', 'dsh-worktable-2026-11-14T10-00-00-000Z'])
  assert.equal(JSON.parse(await readFile(join(modules, BACKUP_DIR, 'dsh-worktable-2026-11-14T10-00-00-000Z', 'package.json'), 'utf8')).version, '0.6.3')
  const again = await cleanDuplicates(dir)
  assert.deepEqual(again.duplicates, [])
  assert.deepEqual(again.replaced, [])
})

test('cleanDuplicates：manifest 为 false 时只换联接、不改 package.json，声明了但没有目录的也补上联接；下次启动只需去掉登记', async (t) => {
  const { dir, modules, read } = await profile(t)
  const before = await readFile(join(dir, 'package.json'), 'utf8')
  const result = await cleanDuplicates(dir, { manifest: false })
  assert.equal(result.manifestChanged, false)
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), before)
  assert.deepEqual(result.replaced.map(item => [item.name, !!item.backup]), [['dsh-worktable', true], ['dsh-studio-projects', false]])
  assert.ok(await linkedToBundled(modules, 'dsh-worktable'))
  assert.ok(await linkedToBundled(modules, 'dsh-studio-projects'), '登记的条目要能找到包，否则连工作室库的条目一起失效')
  assert.ok((await read()).dependencies['dsh-worktable'], '依赖声明留给下次启动的运行时')
  const runtime = await cleanDuplicates(dir)
  assert.deepEqual(runtime.replaced, [], '运行时不再替换目录，也就不需要再重启')
  assert.equal(runtime.manifestChanged, true)
  assert.deepEqual(runtime.duplicates.map(item => [item.name, item.linked]), [['dsh-worktable', true], ['dsh-studio-projects', true]])
})

test('没装工作室库（单独安装子插件是正常用法）或库里没带子插件时不处理', async (t) => {
  const standalone = await profile(t, { library: false })
  assert.deepEqual(await findDuplicates(standalone.dir), [])
  assert.deepEqual((await cleanDuplicates(standalone.dir)).replaced, [])
  assert.equal((await lstat(join(standalone.modules, 'dsh-worktable'))).isSymbolicLink(), false)
  const broken = await profile(t, { bundled: false })
  assert.deepEqual(await findDuplicates(broken.dir), [], '库里没有子插件时联接会指向空目录')
})

test('备份只保留最近两份', async (t) => {
  const { dir, modules } = await profile(t, { declare: [], select: [] })
  for (const [index, hour] of ['01', '02', '03'].entries()) {
    if (index) {
      await rm(join(modules, 'dsh-worktable'), { force: true })
      await mkdir(join(modules, 'dsh-worktable'), { recursive: true })
      await json(join(modules, 'dsh-worktable', 'package.json'), { name: 'dsh-worktable', version: '0.6.3' })
    }
    await cleanDuplicates(dir, { now: new Date(`2026-11-14T${hour}:00:00Z`) })
  }
  assert.deepEqual((await readdir(join(modules, BACKUP_DIR))).sort(), ['dsh-worktable-2026-11-14T02-00-00-000Z', 'dsh-worktable-2026-11-14T03-00-00-000Z'])
  assert.ok(await linkedToBundled(modules, 'dsh-worktable'))
})

test('删除顶层联接（例如 pnpm 之后清理不再声明的包）不会删掉工作室库自带的文件', async (t) => {
  const { dir, modules } = await profile(t, { declare: [], select: [] })
  await cleanDuplicates(dir)
  assert.ok(await linkedToBundled(modules, 'dsh-worktable'))
  await rm(join(modules, 'dsh-worktable'), { recursive: true, force: true })
  assert.equal(JSON.parse(await readFile(join(modules, 'dsh-studio-library', 'node_modules', 'dsh-worktable', 'package.json'), 'utf8')).version, '0.6.5')
})

test('顶层是指向别处的链接（例如开发时的本地链接）时只记下指向，不搬动目标', async (t) => {
  const { dir, modules } = await profile(t, { topWorktable: false, declare: [], select: [] })
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  await json(join(elsewhere, 'package.json'), { name: 'dsh-worktable', version: '0.0.1' })
  await symlink(elsewhere, join(modules, 'dsh-worktable'), linkType)
  const result = await cleanDuplicates(dir, { now: new Date('2026-11-14T11:00:00Z') })
  assert.deepEqual(result.failures, [])
  assert.ok(await linkedToBundled(modules, 'dsh-worktable'))
  assert.equal(JSON.parse(await readFile(join(elsewhere, 'package.json'), 'utf8')).version, '0.0.1', '链接目标原封不动')
  assert.match(await readFile(join(modules, BACKUP_DIR, 'dsh-worktable-2026-11-14T11-00-00-000Z.link.txt'), 'utf8'), /elsewhere/)
})

test('安装脚本：还原子插件后把顶层旧副本换成联接；找不到 profile 时什么都不做', async (t) => {
  const { libraryDir, modules } = await profile(t)
  await linkDuplicates(libraryDir)
  assert.ok(await linkedToBundled(modules, 'dsh-worktable'))
  const lonely = await realpath(await mkdtemp(join(tmpdir(), 'plugin-duplicates-none-')))
  t.after(() => rm(lonely, { recursive: true, force: true }))
  await linkDuplicates(lonely)
})

test('运行时：清理报告在本次运行内累积，替换过目录就一直提示需要重启；找不到 profile 时不可用', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'plugin-duplicates-runtime-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'pluginDuplicates.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../packages/runtime/src/pluginDuplicates.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' })
  const { DuplicateInstalls } = await import(pathToFileURL(outfile).href)
  const { libraryDir } = await profile(t)
  const installs = new DuplicateInstalls(join(libraryDir, 'node_modules', 'dsh-studio-projects'))
  const first = await installs.run()
  assert.equal(first.available, true)
  assert.equal(first.restartRequired, true)
  assert.deepEqual(first.cleaned.map(item => item.name), ['dsh-worktable', 'dsh-studio-projects'])
  const second = await installs.run()
  assert.equal(second.restartRequired, true, '重启前一直提示')
  assert.deepEqual(second.cleaned.map(item => item.name), ['dsh-worktable', 'dsh-studio-projects'])
  const none = await new DuplicateInstalls(dir).run()
  assert.equal(none.available, false)
  let calls = 0
  const failing = new DuplicateInstalls(libraryDir, async () => { calls += 1; throw new Error('磁盘只读') })
  const report = await failing.run()
  assert.deepEqual(report.failures, [{ name: 'profile', message: '磁盘只读' }])
  assert.equal(calls, 1)
})

test('运行时：安装脚本已换好联接时只去掉登记，不需要重启', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'plugin-duplicates-runtime2-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'pluginDuplicates.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../packages/runtime/src/pluginDuplicates.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' })
  const { DuplicateInstalls } = await import(pathToFileURL(outfile).href)
  const { dir: profileDir, libraryDir, read } = await profile(t)
  await cleanDuplicates(profileDir, { manifest: false })
  const report = await new DuplicateInstalls(libraryDir).run()
  assert.equal(report.restartRequired, false)
  assert.deepEqual(report.failures, [])
  assert.deepEqual(Object.keys((await read()).dependencies), ['dsh-studio-library', 'dsh-pet'])
})
