import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 编译卸载模块，并准备若干已登记的工作室安装目录。 */
async function setup(t, { running = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-removal-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'studioRemoval.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../packages/runtime/src/studioRemoval.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' })
  const { StudioRemovals, StudioRemovalFailure } = await import(pathToFileURL(outfile).href)
  const pages = []
  const install = async (id, name = 'dsh-studio-' + id) => {
    const source = join(dir, 'profile', 'node_modules', name)
    await mkdir(join(source, 'static'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    pages.push({ id, name: id, root: join(source, 'static') })
    return name
  }
  // 插件管理器替身：running 里的包「自启动起就在运行」，移除时返回 stop-profile；停用后下次启动（restart）才不再运行
  const state = { calls: [], bundles: new Map(), running: new Set(running), removeError: undefined, disableFails: false }
  const manager = {
    listBundles: async () => [...state.bundles.entries()].map(([name, bundle]) => ({ name, ...bundle })),
    async removeBundle(name) {
      state.calls.push('remove:' + name)
      if (state.removeError) return { application: 'failed', stage: 'remove', target: name, changed: false, error: state.removeError }
      if (state.running.has(name)) return { application: 'failed', stage: 'remove', target: name, changed: false, error: { code: 'stop-profile' } }
      state.bundles.delete(name)
      return { application: 'restart-required', stage: 'remove', target: name, changed: true }
    },
    async setBundleEnabled(name, enabled) {
      state.calls.push((enabled ? 'enable:' : 'disable:') + name)
      if (state.disableFails) return { application: 'failed', stage: 'enable', target: name, changed: false, error: { code: 'operation-error', diagnostic: '第一行\n写入 package.json 失败' } }
      state.bundles.get(name).enabled = enabled
      return { application: 'restart-required', stage: 'enable', target: name, changed: true }
    },
  }
  const registry = { entries: () => pages }
  const stopped = []
  const updates = join(dir, 'updates')
  const create = () => new StudioRemovals(registry, manager, updates, async id => { stopped.push(id); state.calls.push('stop:' + id) })
  const add = async (id, name) => { const pkg = await install(id, name); state.bundles.set(pkg, { enabled: true, installed: true, removable: true }); return pkg }
  /** 模拟完整重启：停用的包不再运行，页面不再登记。 */
  const restart = () => {
    for (const [name, bundle] of state.bundles) if (!bundle.enabled) { state.running.delete(name); const index = pages.findIndex(page => page.root.includes(name)); if (index >= 0) pages.splice(index, 1) }
    state.calls.length = 0
    return create()
  }
  return { dir, updates, state, stopped, pages, add, create, restart, StudioRemovalFailure }
}

test('没有在运行的工作室直接移除；先停它的本机服务，再交给插件管理器', async (t) => {
  const { state, stopped, add, create } = await setup(t)
  await add('media')
  const removals = create()
  const outcome = await removals.remove('media')
  assert.deepEqual({ ...outcome }, { id: 'media', packageName: 'dsh-studio-media', state: 'restart-required' })
  assert.deepEqual(state.calls, ['stop:media', 'remove:dsh-studio-media'])
  assert.deepEqual(stopped, ['media'])
  assert.deepEqual(await removals.pendingIds(), [])
})

test('正在运行的工作室：先停用并记为待卸载，重启后自动完成移除', async (t) => {
  const { updates, state, add, create, restart } = await setup(t, { running: ['dsh-studio-design'] })
  await add('design')
  const removals = create()
  const outcome = await removals.remove('design')
  assert.equal(outcome.state, 'pending-restart')
  assert.deepEqual(state.calls, ['stop:design', 'remove:dsh-studio-design', 'disable:dsh-studio-design'])
  assert.equal(state.bundles.get('dsh-studio-design').enabled, false)
  assert.deepEqual(await removals.pendingIds(), ['design'])
  const saved = JSON.parse(await readFile(join(updates, 'removals.json'), 'utf8'))
  assert.equal(saved[0].packageName, 'dsh-studio-design')
  // 没重启就再启动一次运行时（例如只是重载插件）：它还在运行，移除不了，记录保留
  const same = create()
  await same.resume()
  assert.deepEqual(await same.pendingIds(), ['design'])
  // 完整重启后：工作室不再运行，resume 完成移除并清掉记录
  const next = restart()
  await next.resume()
  assert.deepEqual(state.calls, ['remove:dsh-studio-design'])
  assert.equal(state.bundles.has('dsh-studio-design'), false)
  assert.deepEqual(await next.pendingIds(), [])
  assert.deepEqual(JSON.parse(await readFile(join(updates, 'removals.json'), 'utf8')), [])
})

test('待卸载期间用户重新启用了工作室：放弃卸载，不再移除', async (t) => {
  const { state, add, create, restart } = await setup(t, { running: ['dsh-studio-film'] })
  await add('film')
  await create().remove('film')
  state.bundles.get('dsh-studio-film').enabled = true
  const next = restart()
  await next.resume()
  assert.deepEqual(state.calls, [])
  assert.equal(state.bundles.has('dsh-studio-film'), true)
  assert.deepEqual(await next.pendingIds(), [])
})

test('不能卸载的情况给出可读原因：找不到、工作室库自身、插件管理器拒绝、停用失败', async (t) => {
  const { state, add, create, StudioRemovalFailure } = await setup(t, { running: ['dsh-studio-live'] })
  await add('library', 'dsh-studio-library')
  await add('odd', 'some-other-plugin')
  await add('travel')
  await add('live')
  const removals = create()
  await assert.rejects(removals.remove('missing'), error => error instanceof StudioRemovalFailure && error.code === 'unknown' && /没有找到这个工作室/.test(error.message))
  await assert.rejects(removals.remove('library'), error => error.code === 'protected' && /不能在控制台卸载/.test(error.message))
  await assert.rejects(removals.remove('odd'), error => error.code === 'protected')
  assert.deepEqual(state.calls, [], '被拒绝的请求不触碰插件管理器，也不停服务')
  state.removeError = { code: 'not-removable' }
  await assert.rejects(removals.remove('travel'), error => error.code === 'not-removable' && /由 DSH 安装包或其他插件提供/.test(error.message))
  state.removeError = undefined
  state.disableFails = true
  await assert.rejects(removals.remove('live'), error => error.code === 'operation-error' && error.message === '插件管理器执行卸载时出错：写入 package.json 失败')
  assert.deepEqual(await removals.pendingIds(), [], '停用失败时不记待卸载')
})

test('没有插件管理器时拒绝卸载；待卸载记录损坏时按没有记录处理', async (t) => {
  const { dir, updates } = await setup(t)
  const { StudioRemovals } = await import(pathToFileURL(join(dir, 'studioRemoval.mjs')).href)
  const removals = new StudioRemovals({ entries: () => [] }, undefined, updates)
  await assert.rejects(removals.remove('media'), error => error.code === 'unavailable')
  await mkdir(updates, { recursive: true })
  await writeFile(join(updates, 'removals.json'), '{ 不是 JSON')
  const broken = new StudioRemovals({ entries: () => [] }, { listBundles: async () => [], removeBundle: async () => ({}), setBundleEnabled: async () => ({}) }, updates)
  assert.deepEqual(await broken.pendingIds(), [])
  await broken.resume()
  // 记录里混进了不该卸载的包名：读取时过滤掉
  await writeFile(join(updates, 'removals.json'), JSON.stringify([{ id: 'library', packageName: 'dsh-studio-library' }, { id: 'x', packageName: '../evil' }, { id: 'media', packageName: 'dsh-studio-media' }]))
  const filtered = new StudioRemovals({ entries: () => [] }, undefined, updates)
  assert.deepEqual(await filtered.pendingIds(), ['media'])
})
