import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const hostRoot=process.env.DSH_HARNESS_ROOT ?? fileURLToPath(new URL('../../../deepseek-harness/',import.meta.url))
const { Context } = await import(pathToFileURL(join(hostRoot,'vendor/cordis/lib/index.js')).href)
const { default: Loader } = await import(pathToFileURL(join(hostRoot,'vendor/loader/lib/index.js')).href)
const studio = await import(new URL('../packages/worktable/lib/index.js', import.meta.url))
const travel = await import(new URL('../../dsh-studio-travel/studios/travel/lib/index.js', import.meta.url))
const knowledge = await import(new URL('../../dsh-studio-knowledge/studios/knowledge/lib/index.js', import.meta.url))
const media = await import(new URL('../../dsh-studio-media/studios/media/lib/index.js', import.meta.url))
const fitness = await import(new URL('../../dsh-studio-fitness/studios/fitness/lib/index.js', import.meta.url))
const film = await import(new URL('../../dsh-studio-film/studios/film/lib/index.js', import.meta.url))
const cineflow = await import(new URL('../../dsh-studio-cineflow/studios/cineflow/lib/index.js', import.meta.url))
const live = await import(new URL('../../dsh-studio-live/studios/live/lib/index.js', import.meta.url))

test('真实 Loader 加载、禁用和重载后清理工作室路由', async () => {
  const routes = new Map()
  const ctx = new Context()
  ctx.provide('sessions', {})
  ctx.provide('connection', { admit: req => req.headers.cookie === 'owner'
    ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } })
  ctx.provide('webServer', { register(route) {
    assert.equal(routes.has(route.path), false, '重载不应留下重复路由')
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  } })
  const fiber = ctx.plugin(Loader)
  await fiber.await()
  const originalImport = ctx.loader.internal.import
  ctx.loader.internal.import = (specifier, ...options) => specifier === 'studio-local'
    ? Promise.resolve(studio) : Reflect.apply(originalImport, ctx.loader.internal, [specifier, ...options])
  try {
    await ctx.loader.create({ id: 'studio-local', name: 'studio-local' })
    await ctx.loader.await()
    const entry = [...ctx.loader.entries()].find(item => item.options.id === 'studio-local')
    assert.ok(entry)
    await entry.fiber.await()
    assert.ok(routes.size > 5)
    const response = () => ({ status: 0, body: '', writeHead(status) { this.status = status }, end(body = '') { this.body = body } })
    const unauthenticated = response()
    await routes.get(studio.HEALTH_PATH).handler({ headers: {} }, unauthenticated)
    assert.equal(unauthenticated.status, 401)
    const authenticated = response()
    await routes.get(studio.HEALTH_PATH).handler({ headers: { cookie: 'owner' } }, authenticated)
    assert.equal(authenticated.status, 200)
    assert.equal(JSON.parse(authenticated.body).ok, true)
    await entry.update({ disabled: true })
    await ctx.loader.await()
    assert.equal(routes.size, 0)
    await entry.update({ disabled: false })
    await ctx.loader.await()
    await entry.fiber.await()
    assert.ok(routes.size > 5)
  } finally {
    ctx.loader.internal.import = originalImport
    await fiber.dispose()
  }
  assert.equal(routes.size, 0)
})


test('七个工作室插件独立注册并在禁用后释放授权', async () => {
  const privateRoot=await mkdtemp(join(tmpdir(),'studio-loader-atlas-'))
  const previousRoot=process.env.STARMAP_PRIVATE_ROOT
  process.env.STARMAP_PRIVATE_ROOT=privateRoot
  const ctx = new Context()
  const active = new Set()
  const fibers = []
  ctx.provide('tools', {})
  ctx.provide('studioProjects', { register({id}) {
    assert.equal(active.has(id), false)
    active.add(id)
    return () => active.delete(id)
  } })
  try {
    for (const [id, plugin] of [['travel', travel], ['knowledge', knowledge], ['media', media], ['fitness', fitness], ['film', film], ['cineflow',cineflow], ['live', live]]) {
      const fiber = ctx.plugin(plugin)
      fibers.push(fiber)
      await fiber.await()
      assert.deepEqual([...active], [id])
      await fiber.dispose()
      assert.equal(active.size, 0)
    }
  } finally {
    for (const fiber of fibers) await fiber.dispose()
    if (previousRoot===undefined) delete process.env.STARMAP_PRIVATE_ROOT
    else process.env.STARMAP_PRIVATE_ROOT=previousRoot
    await rm(privateRoot,{recursive:true,force:true})
  }
})
