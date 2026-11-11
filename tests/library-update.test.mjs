import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { create as createTar } from 'tar'

/** 编译运行时更新模块与 Release 资产脚本。 */
async function load(t) {
  const dir = await mkdtemp(join(tmpdir(), 'library-update-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'updates.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../packages/runtime/src/studioUpdates.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' })
  const updates = await import(pathToFileURL(outfile).href)
  const assets = await import(new URL('../scripts/release-assets.mjs', import.meta.url).href)
  return { dir, updates, assets }
}

/** 生成只含 package/package.json 的最小安装包。 */
async function tarball(dir, pkg) {
  const source = join(dir, 'pack')
  await mkdir(join(source, 'package'), { recursive: true })
  await writeFile(join(source, 'package', 'package.json'), JSON.stringify(pkg))
  const file = join(dir, `${pkg.name}-${pkg.version}.tgz`)
  await createTar({ gzip: true, file, cwd: source, portable: true }, ['package'])
  return readFile(file)
}

test('findLibraryRoot 从运行时目录向上找到主插件根目录', async (t) => {
  const { dir, updates } = await load(t)
  const library = join(dir, 'node_modules', 'dsh-studio-library')
  const runtimeLib = join(library, 'node_modules', 'dsh-studio-projects', 'lib')
  await mkdir(runtimeLib, { recursive: true })
  await writeFile(join(library, 'package.json'), JSON.stringify({ name: 'dsh-studio-library', version: '0.1.8' }))
  await writeFile(join(runtimeLib, '..', 'package.json'), JSON.stringify({ name: 'dsh-studio-projects', version: '0.5.2' }))
  assert.equal(updates.findLibraryRoot(runtimeLib), library)
  assert.equal(updates.findLibraryRoot(join(dir, 'elsewhere')), undefined)
})

test('Release 清单与运行时读取格式一致', async (t) => {
  const { assets } = await load(t)
  const pack = assets.parsePackOutput('> prepare\n已生成 [2] 个归档\n[\n  { "name": "dsh-studio-library", "version": "0.1.9", "filename": "dsh-studio-library-0.1.9.tgz" }\n]\n')
  assert.equal(pack.filename, 'dsh-studio-library-0.1.9.tgz')
  const manifest = assets.releaseManifest(pack, Buffer.from('x'), { dsh: '0.2.2-rc.1', dshReleases: { '0.2.2-rc.1': 'experimental' } })
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(manifest.artifacts[0].dshVersions, ['0.2.2-rc.1'])
  assert.equal(manifest.artifacts[0].sha256, createHash('sha256').update('x').digest('hex'))
})

test('主插件读取 GitHub Release 后显示有更新，并校验下载后交给宿主安装', async (t) => {
  const { dir, updates, assets } = await load(t)
  const libraryRoot = join(dir, 'library')
  await mkdir(libraryRoot, { recursive: true })
  await writeFile(join(libraryRoot, 'package.json'), JSON.stringify({ name: 'dsh-studio-library', version: '0.1.8', repository: { type: 'git', url: 'https://github.com/owner/dsh-studio-library.git' } }))
  const bytes = await tarball(dir, { name: 'dsh-studio-library', version: '0.1.9' })
  const manifest = assets.releaseManifest({ name: 'dsh-studio-library', version: '0.1.9', filename: 'dsh-studio-library-0.1.9.tgz' }, bytes, { dsh: '0.2.2-rc.1', dshReleases: { '0.2.2-rc.1': 'experimental' } })
  const download = 'https://github.com/owner/dsh-studio-library/releases/download/v0.1.9/'
  const request = async (url) => {
    if (url.startsWith('https://api.github.com/repos/owner/dsh-studio-library/releases')) return new Response(JSON.stringify([{ draft: false, prerelease: false, assets: [
      { name: 'manifest.json', browser_download_url: download + 'manifest.json' },
      { name: 'dsh-studio-library-0.1.9.tgz', browser_download_url: download + 'dsh-studio-library-0.1.9.tgz' },
    ] }]))
    if (url === download + 'manifest.json') return new Response(JSON.stringify(manifest))
    if (url === download + 'dsh-studio-library-0.1.9.tgz') return new Response(bytes)
    return new Response('', { status: 404 })
  }
  const installs = []
  const manager = {
    listBundles: async () => [{ name: 'dsh-studio-library', version: '0.1.8', installed: true, enabled: true }],
    installBundle: async (file, options) => { installs.push([file, options]); return { application: 'restart-required', bundle: 'dsh-studio-library', version: '0.1.9' } },
  }
  const registry = { entries: () => [] }
  const options = { ...updates.resolveUpdates({ directory: join(dir, 'updates') }), libraryRoot }
  const service = new updates.StudioUpdates(registry, manager, '0.2.2-rc.1', options, request)
  t.after(() => service.dispose())
  await service.initialize()
  const before = await service.list()
  assert.deepEqual(before.studios.map(row => [row.id, row.version, row.state]), [['library', '0.1.8', 'idle']])
  await service.check('library')
  const checked = (await service.list()).studios[0]
  assert.equal(checked.state, 'available')
  assert.equal(checked.latest, '0.1.9')
  await service.install('library', '0.1.9')
  assert.equal(installs.length, 1)
  assert.match(installs[0][0], /dsh-studio-library-0\.1\.9\.tgz$/)
  assert.deepEqual(installs[0][1], { enabled: true })
  assert.equal((await service.list()).studios[0].operation.phase, 'restart-required')
})

test('兼容性：单个版本号视为最低版本，高于它的 DSH 都适配', async (t) => {
  const { updates } = await load(t)
  const { hostCompatible } = updates
  assert.equal(hostCompatible('0.2.2-rc.1', '0.2.1-rc.2'), true)
  assert.equal(hostCompatible('0.2.1-rc.2', '0.2.1-rc.2'), true)
  assert.equal(hostCompatible('0.3.0', '0.2.1-rc.2'), true)
  assert.equal(hostCompatible('0.2.0', '0.2.1-rc.2'), false)
  assert.equal(hostCompatible('0.2.1-rc.1', '0.2.1-rc.2'), false)
  assert.equal(hostCompatible('0.2.2-rc.1', '>=0.2.1-rc.2 <0.3.0'), true)
  assert.equal(hostCompatible('0.3.0', '>=0.2.1-rc.2 <0.3.0'), false)
  assert.equal(hostCompatible('0.2.0', '0.2.5', ['0.2.0']), true)
  assert.equal(hostCompatible('0.2.2-rc.1', ''), true)
})

test('ownBuildApprovals 只挑出本包自己的 allowBuilds 键', async (t) => {
  const { updates } = await load(t)
  const pending = ['dsh-studio-library@file:C:/updates/a.tgz', 'dsh-studio-library', 'node-pty@1.3.0', 'dsh-studio-library-evil@1.0.0', 'dsh-studio-library']
  assert.deepEqual(updates.ownBuildApprovals(pending, 'dsh-studio-library'), ['dsh-studio-library@file:C:/updates/a.tgz', 'dsh-studio-library'])
  assert.deepEqual(updates.ownBuildApprovals(undefined, 'dsh-studio-library'), [])
})

test('构建脚本被拦时自动批准本包的键并重试，其他依赖不代为批准', async (t) => {
  const { dir, updates, assets } = await load(t)
  const libraryRoot = join(dir, 'library')
  await mkdir(libraryRoot, { recursive: true })
  await writeFile(join(libraryRoot, 'package.json'), JSON.stringify({ name: 'dsh-studio-library', version: '0.1.8', repository: { type: 'git', url: 'https://github.com/owner/dsh-studio-library.git' } }))
  const bytes = await tarball(dir, { name: 'dsh-studio-library', version: '0.1.9' })
  const manifest = assets.releaseManifest({ name: 'dsh-studio-library', version: '0.1.9', filename: 'dsh-studio-library-0.1.9.tgz' }, bytes)
  const download = 'https://github.com/owner/dsh-studio-library/releases/download/v0.1.9/'
  const request = async (url) => {
    if (url.startsWith('https://api.github.com/repos/owner/dsh-studio-library/releases')) return new Response(JSON.stringify([{ draft: false, prerelease: false, assets: [
      { name: 'manifest.json', browser_download_url: download + 'manifest.json' },
      { name: 'dsh-studio-library-0.1.9.tgz', browser_download_url: download + 'dsh-studio-library-0.1.9.tgz' },
    ] }]))
    if (url === download + 'manifest.json') return new Response(JSON.stringify(manifest))
    if (url === download + 'dsh-studio-library-0.1.9.tgz') return new Response(bytes)
    return new Response('', { status: 404 })
  }
  const installs = []
  const manager = {
    listBundles: async () => [{ name: 'dsh-studio-library', version: '0.1.8', installed: true, enabled: true }],
    installBundle: async (file, options) => {
      installs.push([file, options])
      if (!options.approvedBuilds) return { application: 'failed', error: { code: 'operation-error' }, pendingBuilds: ['dsh-studio-library@file:' + file, 'node-pty@1.3.0'] }
      return { application: 'restart-required', bundle: 'dsh-studio-library', version: '0.1.9' }
    },
  }
  const options = { ...updates.resolveUpdates({ directory: join(dir, 'updates') }), libraryRoot }
  const service = new updates.StudioUpdates({ entries: () => [] }, manager, '0.2.2-rc.1', options, request)
  t.after(() => service.dispose())
  await service.initialize()
  await service.check('library')
  await service.install('library', '0.1.9')
  assert.equal(installs.length, 2)
  assert.deepEqual(installs[1][1], { enabled: true, approvedBuilds: ['dsh-studio-library@file:' + installs[0][0]] })
  assert.equal((await service.list()).studios[0].operation.phase, 'restart-required')
})
