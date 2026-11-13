import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 编译本机服务栈模块。 */
async function load(t) {
  const dir = await mkdtemp(join(tmpdir(), 'local-stacks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'localStacks.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../packages/runtime/src/localStacks.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' })
  return { dir, stacks: await import(pathToFileURL(outfile).href) }
}

/**
 * 模拟操作系统：进程拉起后开始监听自己的端口；数据库由状态命令的退出码表示是否在运行。
 * missing 列出不存在的路径；crash 指定启动即退出的进程名；mute 指定拉起后不监听端口的进程名。
 */
function fakePlatform() {
  const state = { runs: [], launches: [], listening: new Set(), database: false, missing: new Set(), crash: '', mute: '', startCode: 0, nextPid: 500, unhealthy: new Set() }
  const portOf = args => Number(args[args.indexOf('--port') + 1])
  const platform = {
    exists: path => !state.missing.has(path),
    listening: async port => state.listening.has(port),
    async run(executable, args) {
      state.runs.push([...args].at(-1))
      if (args.at(-1) === 'status') return state.database ? 0 : 3
      if (state.startCode === 0) { state.database = true; state.listening.add(35432) }
      return state.startCode
    },
    async launch(executable, args, options) {
      const name = options.stdout.split(/[\\/]/).pop().replace(/\.log$/, '')
      state.launches.push({ name, executable, args: [...args], cwd: options.cwd, env: options.env })
      const pid = state.nextPid++
      if (state.crash === name) { await writeFile(options.stderr, '启动日志\nError: 数据库连接失败\n'); return { pid, exit: () => ({ code: 1 }) } }
      if (state.mute !== name) state.listening.add(portOf(args))
      return { pid, exit: () => undefined }
    },
    ok: async url => !state.unhealthy.has(url) && state.listening.has(Number(new URL(url).port)),
  }
  return { state, platform }
}

/** 准备一份带密钥文件的数据目录，返回剧工作室的服务栈约定与管理器。 */
async function setup(t, { origin = 'http://127.0.0.1:33102' } = {}) {
  const loaded = await load(t)
  const app = join(loaded.dir, 'apps', 'printfilm'), runtime = join(loaded.dir, 'runtime'), data = join(loaded.dir, 'data')
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'runtime.json'), JSON.stringify({ databasePassword: 'p@ss/word', secretKey: 'secret-key' }))
  const config = loaded.stacks.resolvePrintfilmService({ appDirectory: app, runtimeDirectory: runtime, dataDirectory: data }, {})
  const definition = loaded.stacks.printfilmStack(config, origin, { Path: 'C:\\Windows' }, 'win32')
  const fake = fakePlatform()
  const clock = { offset: 0 }
  // 缩短等待，失败用例不必真的等几十秒
  const quick = { ...definition, timeoutMs: 600, processes: definition.processes.map(item => ({ ...item, timeoutMs: 600 })) }
  const services = new loaded.stacks.LocalStackServices([quick], fake.platform, () => Date.now() + clock.offset)
  return { ...loaded, app, runtime, data, definition: quick, ...fake, services, clock }
}

test('登记后按顺序拉起：数据库 → 缓存 → 接口 → 前台 → 管理后台，环境变量与原启动脚本一致', async (t) => {
  const { app, runtime, data, state, services } = await setup(t)
  assert.equal(services.has('film'), false)
  assert.equal(services.attach('media'), false)
  assert.equal(services.attach('film'), true)
  assert.equal(services.has('film'), true)
  assert.equal(await services.ensure('film'), undefined)
  assert.deepEqual(state.runs, ['status', 'start'])
  assert.deepEqual(state.launches.map(item => item.name), ['garnet', 'printfilm-api', 'printfilm-web', 'printfilm-admin'])
  const [garnet, api, web, admin] = state.launches
  assert.equal(garnet.executable, join(runtime, 'garnet', 'net10.0', 'GarnetServer.exe'))
  assert.equal(api.executable, join(app, '.venv', 'Scripts', 'python.exe'))
  assert.equal(api.cwd, join(app, 'backend'))
  assert.deepEqual(api.args, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '33104'])
  assert.equal(web.executable, join(runtime, 'node', 'bin', 'node.exe'))
  assert.deepEqual(web.args, [join(app, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', '33102', '--strictPort'])
  assert.equal(admin.args.at(-2), '33103')
  // 密码按 URL 编码写进连接串，密钥来自数据目录的 runtime.json
  assert.equal(api.env.DATABASE_URL, 'postgresql+asyncpg://printfilm:p%40ss%2Fword@127.0.0.1:35432/printfilm')
  assert.equal(api.env.SECRET_KEY, 'secret-key')
  assert.equal(api.env.REDIS_URL, 'redis://127.0.0.1:36379/0')
  assert.equal(api.env.PUBLIC_BASE_URL, 'http://127.0.0.1:33102')
  assert.equal(api.env.STUDIO_SINGLE_USER, 'true')
  assert.equal(api.env.DOTNET_ROOT, join(runtime, 'dotnet'))
  // 沿用已有的 Path 键，把 ffmpeg 放在最前
  assert.ok(api.env.Path.startsWith(join(runtime, 'ffmpeg')))
  assert.ok(api.env.Path.endsWith('C:\\Windows'))
  assert.equal(garnet.args[garnet.args.indexOf('--logdir') + 1], join(data, 'garnet'))
  assert.deepEqual(services.report(), [])
})

test('整套服务已在运行时什么也不做；只缺一部分时只补缺的那几个', async (t) => {
  const { state, services } = await setup(t)
  services.attach('film')
  await services.ensure('film')
  state.runs.length = 0; state.launches.length = 0
  assert.equal(await services.ensure('film'), undefined)
  assert.deepEqual(state.runs, [])
  assert.deepEqual(state.launches, [])
  // 接口进程退出了：数据库、缓存与两个页面保持原样，只重新拉起接口
  state.listening.delete(33104)
  assert.equal(await services.ensure('film'), undefined)
  assert.deepEqual(state.runs, ['status'])
  assert.deepEqual(state.launches.map(item => item.name), ['printfilm-api'])
})

test('没有初始化、数据库起不来、进程启动即退出、启动超时都给出可读原因', async (t) => {
  const { data, runtime, state, services, clock } = await setup(t)
  services.attach('film')
  const retry = () => { clock.offset += 20000; return services.ensure('film') }

  state.missing.add(join(data, 'postgres', 'PG_VERSION'))
  const uninitialized = await services.ensure('film')
  assert.equal(uninitialized.kind, 'launch')
  assert.match(uninitialized.message, /AI剧工作台无法启动：缺少 .*PG_VERSION。请先按剧工作室说明准备应用与数据库/)
  assert.deepEqual(state.launches, [])
  // 失败后短时间内的状态轮询不反复尝试，用户主动点击则立即重试
  assert.equal(await services.ensure('film'), uninitialized)
  assert.equal(services.report().length, 1)
  state.missing.clear()

  state.startCode = 1
  const database = await services.ensure('film', { force: true })
  assert.equal(database.kind, 'exit')
  assert.match(database.message, /数据库 启动失败（退出码 1）/)
  state.startCode = 0

  state.listening.add(35432)
  const occupied = await retry()
  assert.match(occupied.message, /无法启动 数据库：端口 35432 已被其他程序占用/)
  state.listening.delete(35432)

  state.crash = 'printfilm-api'
  const crashed = await retry()
  assert.equal(crashed.kind, 'exit')
  assert.match(crashed.message, /printfilm-api 启动后退出（退出码 1）：Error: 数据库连接失败/)
  assert.match(crashed.message, /printfilm-api\.error\.log/)
  state.crash = ''

  state.mute = 'printfilm-web'
  const silent = await retry()
  assert.equal(silent.kind, 'timeout')
  assert.match(silent.message, /printfilm-web 启动超时，请检查端口 33102/)
  state.mute = ''

  state.missing.add(join(runtime, 'node', 'bin', 'node.exe'))
  const missing = await retry()
  assert.match(missing.message, /缺少 printfilm-web 的运行文件/)
  state.missing.clear()

  assert.equal(await retry(), undefined)
  assert.deepEqual(services.report(), [])
})

test('进程都起来了但健康检查不过：报告未就绪与日志目录', async (t) => {
  const { data, state, services } = await setup(t)
  services.attach('film')
  state.unhealthy.add('http://127.0.0.1:33104/api/health')
  const failure = await services.ensure('film')
  assert.equal(failure.kind, 'timeout')
  assert.ok(failure.message.includes('启动后未就绪') && failure.message.includes(join(data, 'logs')))
})

test('并发协调只执行一次；撤销登记后不再协调', async (t) => {
  const { state, services } = await setup(t)
  services.attach('film')
  const first = services.ensure('film'), second = services.ensure('film')
  assert.equal(first, second)
  assert.equal(services.starting('film'), true)
  await first
  assert.equal(services.starting('film'), false)
  assert.equal(state.launches.length, 4)
  services.detach('film')
  assert.equal(services.has('film'), false)
  state.listening.clear(); state.database = false
  assert.equal(await services.ensure('film'), undefined)
  assert.equal(state.launches.length, 4)
})

test('本机目录配置：三个目录都要是绝对路径；环境变量可补齐；都不给表示本机没有这套服务', async (t) => {
  const { stacks } = await load(t)
  assert.equal(stacks.resolvePrintfilmService(undefined, {}), undefined)
  const absolute = process.platform === 'win32' ? 'D:\\studio' : '/studio'
  const fromEnv = stacks.resolvePrintfilmService(undefined, { DSH_STUDIO_PRINTFILM_APP: join(absolute, 'app'), DSH_STUDIO_PRINTFILM_RUNTIME: join(absolute, 'runtime'), DSH_STUDIO_PRINTFILM_DATA: join(absolute, 'data') })
  assert.equal(fromEnv.appDirectory, join(absolute, 'app'))
  const mixed = stacks.resolvePrintfilmService({ appDirectory: join(absolute, 'other') }, { DSH_STUDIO_PRINTFILM_RUNTIME: join(absolute, 'runtime'), DSH_STUDIO_PRINTFILM_DATA: join(absolute, 'data') })
  assert.equal(mixed.appDirectory, join(absolute, 'other'))
  assert.throws(() => stacks.resolvePrintfilmService({ appDirectory: join(absolute, 'app') }, {}), /都必须是绝对路径/)
  assert.throws(() => stacks.resolvePrintfilmService({ appDirectory: 'relative/app', runtimeDirectory: absolute, dataDirectory: absolute }, {}), /都必须是绝对路径/)
  assert.throws(() => stacks.resolvePrintfilmService('D:/studio', {}), /必须是对象/)
})

test('访问地址不在本机时不由运行时管理；其他系统上的可执行文件名不带 .exe', async (t) => {
  const { stacks } = await load(t)
  const config = { appDirectory: '/apps/printfilm', runtimeDirectory: '/runtime', dataDirectory: '/data' }
  assert.equal(stacks.printfilmStack(config, 'https://film.example.com', {}, 'linux'), undefined)
  assert.equal(stacks.printfilmStack(config, 'http://192.168.1.8:33102', {}, 'linux'), undefined)
  const definition = stacks.printfilmStack(config, 'http://localhost:34000', { DSH_STUDIO_NODE: '/usr/bin/node' }, 'linux')
  assert.equal(definition.processes.find(item => item.name === 'printfilm-web').port, 34000)
  assert.equal(definition.processes.find(item => item.name === 'printfilm-web').executable, '/usr/bin/node')
  assert.ok(definition.processes.find(item => item.name === 'printfilm-api').executable.endsWith(join('.venv', 'bin', 'python')))
  assert.ok(definition.prerequisites[0].executable.endsWith(join('pgsql', 'bin', 'pg_ctl')))
  assert.deepEqual(definition.health, ['http://127.0.0.1:34000', 'http://127.0.0.1:33103', 'http://127.0.0.1:33104/api/health'])
})
