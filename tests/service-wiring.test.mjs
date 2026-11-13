import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 宿主模块的最小替身：运行时入口只需要版本号、工具定义等少量接口。 */
const hostStubs = {
  '@deepseek-ai/dsh-app-boot': 'export const getDshRuntimeVersion = () => "0.2.2-rc.1"',
  '@deepseek-ai/dsh-tools': 'export const defineTool = tool => tool',
  '@deepseek-ai/dsh-mcp-client': 'export const Config = value => value; export const name = "mcp"; export const apply = () => {}',
  '@deepseek-ai/dsh-scope': 'export const createScope = () => ({ ctx: {}, dispose: async () => {} })',
}

/** 编译完整的运行时入口（server.ts），宿主依赖替换为替身。 */
async function loadRuntime(dir) {
  const outfile = join(dir, 'runtime.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../packages/runtime/src/server.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'host-stubs', setup(setupBuild) {
      setupBuild.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: args.path, namespace: 'host-stub' }))
      setupBuild.onLoad({ filter: /.*/, namespace: 'host-stub' }, args => ({ contents: hostStubs[args.path] ?? 'export {}', loader: 'js' }))
    } }] })
  return import(pathToFileURL(outfile).href)
}

/** 取一个空闲端口。 */
const freePort = () => new Promise((done, fail) => {
  const server = createServer()
  server.once('error', fail)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)) })
})

/**
 * 生成一个带随包服务的工作室安装包。服务是一段 Node 脚本，行为与影音应用的工作室模式一致：
 * 读取环境变量、监听端口、提供 /health，并在数据目录写下 bridge.json。测试中用 node 充当 Electron。
 */
async function installStudio(dir, label) {
  const source = join(dir, 'profile', 'node_modules', 'dsh-studio-cineflow')
  await mkdir(join(source, 'static'), { recursive: true })
  await mkdir(join(source, 'app', 'electron'), { recursive: true })
  await mkdir(join(source, 'app', 'dist'), { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-studio-cineflow', version: label }))
  await writeFile(join(source, 'static', 'index.html'), '<!doctype html><title>影音</title>')
  await writeFile(join(source, 'app', 'package.json'), JSON.stringify({ main: 'electron/main.cjs' }))
  await writeFile(join(source, 'app', 'dist', 'index.html'), '<!doctype html>' + label)
  await writeFile(join(source, 'app', 'electron', 'main.cjs'), `
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path')
const data = process.env.DSH_STUDIO_CINEFLOW_DATA; const port = Number(process.env.DSH_STUDIO_CINEFLOW_PORT)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ studio: true, label: ${JSON.stringify(label)}, cwd: process.cwd() }))
})
server.listen(port, '127.0.0.1', () => fs.writeFileSync(path.join(data, 'bridge.json'), JSON.stringify({ schemaVersion: 1, origin: 'http://127.0.0.1:' + port, token: 'a'.repeat(64), pid: process.pid })))
`)
  return source
}

/** 宿主上下文替身：记录 effect 的清理函数与注册的路由。 */
function fakeHost() {
  const host = { disposers: [], provided: {}, route: undefined }
  const ctx = {
    provide(name, value) { host.provided[name] = value },
    effect(callback) { host.disposers.push(callback()) },
    on() { return () => {} },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    webServer: { register(route) { host.route = route; return () => {} } },
    tools: { register() {} },
    systemPrompt: { section() {} },
    pluginManager: { listBundles: async () => [], installBundle: async () => ({ application: 'failed' }) },
  }
  /** 向运行时路由发请求，返回状态码与解析后的 JSON。 */
  host.request = (method, path, body) => new Promise((done, fail) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method, url: path, headers: body === undefined ? {} : { 'content-type': 'application/json' } })
    let status = 0
    const res = { headersSent: false, writeHead(code) { status = code; this.headersSent = true }, end(content) {
      try { done({ status, body: content ? JSON.parse(content.toString()) : undefined }) } catch (error) { fail(error) } } }
    host.route.handler(req, res).catch(fail)
  })
  host.dispose = async () => { for (const dispose of host.disposers.reverse()) await dispose?.() }
  return { host, ctx }
}

test('工作室登记后自动启动随包服务；服务中断后「重新连接」自动拉起；运行期间安装目录可替换', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'service-wiring-'))
  const data = join(dir, 'data')
  const saved = { ...process.env }
  const readBridge = async () => JSON.parse(await readFile(join(data, 'bridge.json'), 'utf8'))
  t.after(async () => {
    try { process.kill((await readBridge()).pid) } catch { /* 服务已退出 */ }
    for (const key of ['DSH_STUDIO_CINEFLOW_PORT', 'DSH_STUDIO_SKIP_APPS', 'DSH_STUDIO_CINEFLOW_DATA', 'DSH_STUDIO_ELECTRON']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
    }
    // 服务进程退出后其工作目录才能删除
    await new Promise(done => setTimeout(done, 500))
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const port = await freePort()
  process.env.DSH_STUDIO_CINEFLOW_PORT = String(port)
  delete process.env.DSH_STUDIO_SKIP_APPS
  delete process.env.DSH_STUDIO_CINEFLOW_DATA
  delete process.env.DSH_STUDIO_ELECTRON
  const runtime = await loadRuntime(dir)
  const source = await installStudio(dir, '0.2.7')
  const { host, ctx } = fakeHost()
  await runtime.apply(ctx, { electronPath: process.execPath, cineflowDataDirectory: data,
    toonflowDataDirectory: join(dir, 'toonflow'), updates: { directory: join(dir, 'updates') },
    toonflowUrl: 'http://127.0.0.1:9', printfilmUrl: 'http://127.0.0.1:9' })
  t.after(() => host.dispose())
  const cineflow = async path => (await host.request('GET', path)).body
  const service = async () => (await cineflow('/studio-projects/control/services')).services.find(item => item.id === 'cineflow')

  // 尚未安装影音工作室：没有可启动的服务，也不会报错
  assert.equal((await service()).startable, false)
  assert.equal((await cineflow('/studio-projects/integrations')).find(item => item.id === 'cineflow').ready, false)

  // 安装（登记）后无需任何配置即自动启动；页面读取连接状态时等待启动完成
  const unregister = host.provided.studioProjects.register({ id: 'cineflow', name: '影音工作室', root: join(source, 'static') })
  const status = (await cineflow('/studio-projects/integrations')).find(item => item.id === 'cineflow')
  assert.equal(status.ready, true)
  assert.equal(status.startupError, undefined)
  assert.equal(status.url, 'http://127.0.0.1:' + port)
  const first = await readBridge()
  const health = await (await fetch(status.url + '/health')).json()
  assert.equal(health.label, '0.2.7')
  assert.ok(health.cwd.startsWith(join(data, 'runtime')), '服务从数据目录内的独立副本运行')
  assert.deepEqual({ ...(await service()), title: undefined }, { id: 'cineflow', title: undefined, ready: true, startable: true, starting: false })

  // 服务运行期间安装目录可以整体替换（Windows 上被占用的目录无法改名）
  await rename(source, source + '.swap')
  await rename(source + '.swap', source)

  // 服务意外退出后，页面「重新连接」（重新读取连接状态）会自动拉起
  process.kill(first.pid)
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fetch(status.url + '/health', { signal: AbortSignal.timeout(500) }) } catch { break }
    await new Promise(done => setTimeout(done, 100))
  }
  const recovered = (await cineflow('/studio-projects/integrations')).find(item => item.id === 'cineflow')
  assert.equal(recovered.ready, true)
  const second = await readBridge()
  assert.notEqual(second.pid, first.pid)

  // 控制台「一键启动」对随包服务同样可用；服务已在运行时不重复拉起
  const started = await host.request('POST', '/studio-projects/control/start', { studio: 'cineflow' })
  assert.equal(started.status, 200)
  assert.deepEqual(started.body.failures, [])
  assert.equal((await readBridge()).pid, second.pid)

  // 更新：安装目录换成新版本并重新登记后，服务自动切换
  unregister()
  assert.equal((await service()).startable, false)
  await installStudio(dir, '0.2.9')
  host.provided.studioProjects.register({ id: 'cineflow', name: '影音工作室', root: join(source, 'static') })
  let label = ''
  for (let attempt = 0; attempt < 100 && label !== '0.2.9'; attempt++) {
    try { label = (await (await fetch(status.url + '/health', { signal: AbortSignal.timeout(500) })).json()).label } catch { /* 切换期间端口短暂不可用 */ }
    if (label !== '0.2.9') await new Promise(done => setTimeout(done, 100))
  }
  assert.equal(label, '0.2.9')
  assert.equal((await cineflow('/studio-projects/integrations')).find(item => item.id === 'cineflow').ready, true)
})

test('DSH_STUDIO_SKIP_APPS=1 时不自动启动，仍可手动一键启动', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'service-wiring-skip-'))
  const data = join(dir, 'data')
  const saved = { ...process.env }
  t.after(async () => {
    try { process.kill(JSON.parse(await readFile(join(data, 'bridge.json'), 'utf8')).pid) } catch { /* 服务未启动 */ }
    for (const key of ['DSH_STUDIO_CINEFLOW_PORT', 'DSH_STUDIO_SKIP_APPS', 'DSH_STUDIO_CINEFLOW_DATA', 'DSH_STUDIO_ELECTRON']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
    }
    await new Promise(done => setTimeout(done, 500))
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  process.env.DSH_STUDIO_CINEFLOW_PORT = String(await freePort())
  process.env.DSH_STUDIO_SKIP_APPS = '1'
  delete process.env.DSH_STUDIO_CINEFLOW_DATA
  delete process.env.DSH_STUDIO_ELECTRON
  const runtime = await loadRuntime(dir)
  const source = await installStudio(dir, '0.2.7')
  const { host, ctx } = fakeHost()
  await runtime.apply(ctx, { electronPath: process.execPath, cineflowDataDirectory: data,
    toonflowDataDirectory: join(dir, 'toonflow'), updates: { directory: join(dir, 'updates') },
    toonflowUrl: 'http://127.0.0.1:9', printfilmUrl: 'http://127.0.0.1:9' })
  t.after(() => host.dispose())
  host.provided.studioProjects.register({ id: 'cineflow', name: '影音工作室', root: join(source, 'static') })
  const integrations = (await host.request('GET', '/studio-projects/integrations')).body
  assert.equal(integrations.find(item => item.id === 'cineflow').ready, false)
  const started = await host.request('POST', '/studio-projects/control/start', { studio: 'cineflow' })
  assert.deepEqual(started.body.failures, [])
  assert.equal(started.body.services.find(item => item.id === 'cineflow').ready, true)
})

test('控制台服务面板：短剧带应用目录时可启动，旧版短剧包不可；剧配置了本机目录后可启动', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'service-wiring-studios-'))
  const saved = { ...process.env }
  const keys = ['DSH_STUDIO_SKIP_APPS', 'DSH_STUDIO_PRINTFILM_APP', 'DSH_STUDIO_PRINTFILM_RUNTIME', 'DSH_STUDIO_PRINTFILM_DATA', 'DSH_STUDIO_TOONFLOW_URL', 'DSH_STUDIO_PRINTFILM_URL']
  t.after(async () => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  for (const key of keys) delete process.env[key]
  // 只看接线，不真的拉起进程
  process.env.DSH_STUDIO_SKIP_APPS = '1'
  const runtime = await loadRuntime(dir)
  const studio = async (name, withApp) => {
    const source = join(dir, 'profile', 'node_modules', name)
    await mkdir(join(source, 'static'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    if (withApp) { await mkdir(join(source, 'app', 'build', 'server'), { recursive: true }); await writeFile(join(source, 'app', 'build', 'server', 'index.js'), '') }
    return join(source, 'static')
  }
  const base = { cineflowDataDirectory: join(dir, 'cineflow'), toonflowDataDirectory: join(dir, 'toonflow'), updates: { directory: join(dir, 'updates') },
    toonflowUrl: 'http://127.0.0.1:' + String(await freePort()), printfilmUrl: 'http://127.0.0.1:' + String(await freePort()) }
  const states = async host => Object.fromEntries((await host.request('GET', '/studio-projects/control/services')).body.services.map(item => [item.id, item.startable]))

  // 没有配置剧的本机目录、短剧是不带应用的旧包：两者都不可由运行时启动
  const plain = fakeHost()
  await runtime.apply(plain.ctx, base)
  t.after(() => plain.host.dispose())
  plain.host.provided.studioProjects.register({ id: 'media', name: 'AI短剧工作台', root: await studio('dsh-studio-media', false) })
  plain.host.provided.studioProjects.register({ id: 'film', name: 'AI剧工作台', root: await studio('dsh-studio-film', false) })
  assert.deepEqual(await states(plain.host), { media: false, film: false, cineflow: false })

  // 短剧带 app 目录、剧配置了本机目录：两者都显示可启动；停用后恢复
  const managed = fakeHost()
  await runtime.apply(managed.ctx, { ...base, printfilmService: { appDirectory: join(dir, 'apps', 'printfilm'), runtimeDirectory: join(dir, 'runtime'), dataDirectory: join(dir, 'data', 'printfilm') } })
  t.after(() => managed.host.dispose())
  const unregisterMedia = managed.host.provided.studioProjects.register({ id: 'media', name: 'AI短剧工作台', root: await studio('dsh-studio-media', true) })
  managed.host.provided.studioProjects.register({ id: 'film', name: 'AI剧工作台', root: await studio('dsh-studio-film', false) })
  assert.deepEqual(await states(managed.host), { media: true, film: true, cineflow: false })
  // 一键启动剧：本机目录还没准备好，给出缺少的文件而不是「未配置」
  const started = await managed.host.request('POST', '/studio-projects/control/start', { studio: 'film' })
  assert.equal(started.status, 200)
  assert.match(started.body.failures[0].message, /AI剧工作台无法启动：缺少 .*runtime\.json/)
  assert.match(started.body.services.find(item => item.id === 'film').error, /runtime\.json/)
  unregisterMedia()
  assert.equal((await states(managed.host)).media, false)

  // 配置写错时在加载阶段就报错，不带着错误配置运行
  await assert.rejects(runtime.apply(fakeHost().ctx, { ...base, printfilmService: { appDirectory: 'relative/path' } }), /printfilmService 配置无效/)
  await assert.rejects(runtime.apply(fakeHost().ctx, { ...base, bunPath: 'bun.exe' }), /bunPath 必须是绝对路径/)
})

test('卸载路由：校验来源与参数，把结果与失败原因原样交给页面；待卸载的工作室在列表里带标记', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'service-wiring-uninstall-'))
  const saved = process.env.DSH_STUDIO_SKIP_APPS
  t.after(async () => {
    if (saved === undefined) delete process.env.DSH_STUDIO_SKIP_APPS; else process.env.DSH_STUDIO_SKIP_APPS = saved
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  process.env.DSH_STUDIO_SKIP_APPS = '1'
  const runtime = await loadRuntime(dir)
  const source = join(dir, 'profile', 'node_modules', 'dsh-studio-travel')
  await mkdir(join(source, 'static'), { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-studio-travel', version: '1.2.0' }))
  const { host, ctx } = fakeHost()
  const calls = []
  ctx.pluginManager = {
    listBundles: async () => [],
    installBundle: async () => ({ application: 'failed' }),
    removeBundle: async name => { calls.push('remove:' + name); return { application: 'failed', error: { code: 'stop-profile' } } },
    setBundleEnabled: async (name, enabled) => { calls.push((enabled ? 'enable:' : 'disable:') + name); return { application: 'restart-required' } },
  }
  await runtime.apply(ctx, { cineflowDataDirectory: join(dir, 'cineflow'), toonflowDataDirectory: join(dir, 'toonflow'), updates: { directory: join(dir, 'updates') },
    toonflowUrl: 'http://127.0.0.1:9', printfilmUrl: 'http://127.0.0.1:9' })
  t.after(() => host.dispose())
  host.provided.studioProjects.register({ id: 'travel', name: '旅行', root: join(source, 'static') })
  assert.equal((await host.request('GET', '/studio-projects/control/uninstall')).status, 405)
  assert.equal((await host.request('POST', '/studio-projects/control/uninstall', { id: '../x' })).status, 400)
  const missing = await host.request('POST', '/studio-projects/control/uninstall', { id: 'nothing' })
  assert.equal(missing.status, 404)
  assert.match(missing.body.error, /没有找到这个工作室/)
  const before = (await host.request('GET', '/studio-projects/control/studios')).body.studios.find(row => row.id === 'travel')
  assert.equal(before.pendingRemoval, undefined)
  const removed = await host.request('POST', '/studio-projects/control/uninstall', { id: 'travel' })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.body, { id: 'travel', packageName: 'dsh-studio-travel', state: 'pending-restart' })
  assert.deepEqual(calls, ['remove:dsh-studio-travel', 'disable:dsh-studio-travel'])
  const after = (await host.request('GET', '/studio-projects/control/studios')).body.studios.find(row => row.id === 'travel')
  assert.equal(after.pendingRemoval, true)
})
