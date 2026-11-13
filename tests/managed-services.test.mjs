import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 编译随包服务模块与注册表。 */
async function load(t) {
  const dir = await mkdtemp(join(tmpdir(), 'managed-services-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const modules = {}
  for (const name of ['managedServices', 'registry']) {
    const outfile = join(dir, name + '.mjs')
    await build({ entryPoints: [fileURLToPath(new URL('../packages/runtime/src/' + name + '.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' })
    modules[name] = await import(pathToFileURL(outfile).href)
  }
  return { dir, ...modules }
}

/** 在临时目录中生成一个带应用目录与依赖的工作室安装包（提升式 node_modules 布局）。 */
async function install(dir, version, { complete = true } = {}) {
  const profile = join(dir, 'profile', 'node_modules')
  const source = join(profile, 'dsh-studio-cineflow')
  await rm(source, { recursive: true, force: true })
  await mkdir(join(source, 'app', 'electron'), { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-studio-cineflow', version, dependencies: { 'xml-lib': '^1.0.0' } }))
  if (complete) {
    await mkdir(join(source, 'app', 'dist'), { recursive: true })
    await writeFile(join(source, 'app', 'package.json'), JSON.stringify({ main: 'electron/main.cjs', version }))
    await writeFile(join(source, 'app', 'electron', 'main.cjs'), '// ' + version)
    await writeFile(join(source, 'app', 'dist', 'index.html'), '<!doctype html>' + version)
  }
  await mkdir(join(profile, 'xml-lib'), { recursive: true })
  await writeFile(join(profile, 'xml-lib', 'package.json'), JSON.stringify({ name: 'xml-lib', version: '1.0.0', dependencies: { '@scope/leaf': '1.0.0' } }))
  await mkdir(join(profile, '@scope', 'leaf'), { recursive: true })
  await writeFile(join(profile, '@scope', 'leaf', 'package.json'), JSON.stringify({ name: '@scope/leaf', version: '1.0.0' }))
  return source
}

/**
 * 模拟操作系统：launch 记录调用并像真实服务一样写下 bridge.json；kill 让进程消失。
 * foreign 可预置一个不是由运行时拉起的健康进程。
 */
function fakePlatform(data, { electron = 'C:/electron/electron.exe', port = 33105 } = {}) {
  const state = { launches: [], killed: [], alive: new Set(), commands: new Map(), nextPid: 1000, crash: false, silent: false }
  const origin = 'http://127.0.0.1:' + port
  const bridge = pid => writeFile(join(data, 'bridge.json'), JSON.stringify({ schemaVersion: 1, origin, token: 'a'.repeat(64), pid }))
  const platform = {
    electron: () => electron ? { path: electron, tried: [electron] } : { tried: ['C:/missing/electron.exe'] },
    async launch(executable, args, options) {
      const pid = state.nextPid++
      state.launches.push({ executable, args: [...args], cwd: options.cwd, env: options.env })
      if (state.crash) { await writeFile(options.stderr, '第一行\nError: Cannot find module x\n'); return { pid, exit: () => ({ code: 1 }) } }
      state.alive.add(pid)
      if (!state.silent) await bridge(pid)
      return { pid, exit: () => undefined }
    },
    alive: pid => state.alive.has(pid),
    kill(pid) { state.killed.push(pid); state.alive.delete(pid) },
    healthy: async () => state.alive.size > 0,
    listening: async () => state.alive.size > 0,
    commandLine: async pid => state.commands.get(pid),
  }
  return { state, platform, bridge }
}

async function setup(t, options) {
  const loaded = await load(t)
  const data = join(loaded.dir, 'data')
  await mkdir(data, { recursive: true })
  const fake = fakePlatform(data, options)
  const definition = { ...loaded.managedServices.cineflowService(data, {}), timeoutMs: 1500 }
  const clock = { offset: 0 }
  const services = new loaded.managedServices.ManagedStudioServices([definition], fake.platform, () => Date.now() + clock.offset)
  return { ...loaded, data, ...fake, definition, services, clock }
}

test('登记后自动启动：服务从数据目录内的独立副本运行，不占用安装目录', async (t) => {
  const { dir, data, state, services } = await setup(t)
  const source = await install(dir, '0.2.7')
  assert.equal(services.has('cineflow'), false)
  assert.equal(services.attach('travel', source), false)
  assert.equal(services.attach('cineflow', source), true)
  assert.equal(services.has('cineflow'), true)
  assert.equal(await services.ensure('cineflow'), undefined)
  assert.equal(state.launches.length, 1)
  const launch = state.launches[0]
  assert.equal(launch.executable, 'C:/electron/electron.exe')
  assert.ok(launch.cwd.startsWith(join(data, 'runtime')), '工作目录在运行副本内')
  assert.ok(!launch.cwd.toLowerCase().startsWith(source.toLowerCase()), '工作目录不在安装目录内')
  assert.deepEqual(launch.args, [launch.cwd])
  assert.equal(launch.env.DSH_STUDIO_CINEFLOW_DATA, data)
  assert.equal(launch.env.DSH_STUDIO_CINEFLOW_PORT, '33105')
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(await readFile(join(launch.cwd, 'dist', 'index.html'), 'utf8'), '<!doctype html>0.2.7')
  // 声明的依赖及其传递依赖随副本一起复制，副本不再回头读取安装目录
  assert.ok(existsSync(join(launch.cwd, '..', 'node_modules', 'xml-lib', 'package.json')))
  assert.ok(existsSync(join(launch.cwd, '..', 'node_modules', '@scope', 'leaf', 'package.json')))
  // 已在运行且安装目录未变：不重复拉起
  assert.equal(await services.ensure('cineflow'), undefined)
  assert.equal(state.launches.length, 1)
  assert.deepEqual(services.report(), [])
})

test('安装目录更新后切换到新版本，并清理旧副本', async (t) => {
  const { dir, data, state, services } = await setup(t)
  const source = await install(dir, '0.2.7')
  services.attach('cineflow', source)
  await services.ensure('cineflow')
  const first = state.launches[0].cwd
  await install(dir, '0.2.9')
  services.attach('cineflow', source)
  assert.equal(await services.ensure('cineflow'), undefined)
  assert.deepEqual(state.killed, [1000])
  assert.equal(state.launches.length, 2)
  assert.notEqual(state.launches[1].cwd, first)
  assert.equal(await readFile(join(state.launches[1].cwd, 'dist', 'index.html'), 'utf8'), '<!doctype html>0.2.9')
  const stages = (await readdir(join(data, 'runtime'))).filter(name => name !== 'current.json')
  assert.equal(stages.length, 1, '只保留当前运行副本')
  assert.ok(stages[0].startsWith('0.2.9-'))
})

test('安装目录残缺时不打断正在运行的服务；服务已停则回到上一份副本', async (t) => {
  const { dir, state, services } = await setup(t)
  const source = await install(dir, '0.2.7')
  services.attach('cineflow', source)
  await services.ensure('cineflow')
  // 模拟更新中断：应用目录被清空
  await install(dir, '0.2.7', { complete: false })
  const kept = await services.ensure('cineflow', { force: true })
  assert.match(kept.message, /安装不完整（缺少 app\/package\.json）.*继续使用正在运行的版本/)
  assert.deepEqual(state.killed, [])
  assert.equal(state.launches.length, 1)
  // 服务进程消失后，从上一份完整副本重新拉起
  state.alive.clear()
  assert.equal(await services.ensure('cineflow', { force: true }), undefined)
  assert.equal(state.launches.length, 2)
  assert.equal(state.launches[1].cwd, state.launches[0].cwd)
})

test('首次安装就不完整：报告缺失文件，不拉起进程', async (t) => {
  const { dir, state, services } = await setup(t)
  services.attach('cineflow', await install(dir, '0.2.7', { complete: false }))
  const failure = await services.ensure('cineflow')
  assert.equal(failure.kind, 'launch')
  assert.deepEqual(failure.studioIds, ['cineflow'])
  assert.match(failure.message, /影音工作室安装不完整（缺少 app\/package\.json）/)
  assert.equal(state.launches.length, 0)
  assert.deepEqual(services.report().map(item => item.message), [failure.message])
})

test('旧脚本留在安装目录内运行的进程被替换；用户自行启动的服务保持不动', async (t) => {
  const { dir, state, services, bridge } = await setup(t)
  const source = await install(dir, '0.2.7')
  services.attach('cineflow', source)
  // 用户从别处自行启动的服务：不是本运行时拉起、命令行也不在安装目录内
  state.alive.add(77); await bridge(77)
  state.commands.set(77, '"C:\\electron\\electron.exe" "D:\\dev\\CineFlow"')
  assert.equal(await services.ensure('cineflow'), undefined)
  assert.deepEqual(state.killed, [])
  assert.equal(state.launches.length, 0)
  // 旧启动脚本在安装目录内拉起的进程：会占用目录，替换为独立副本。
  // Windows 的路径不区分大小写，命令行里的大小写可能与登记的不同；其他平台区分大小写，按原样比较
  const application = join(source, 'app')
  state.commands.set(77, '"C:\\electron\\electron.exe" "' + (process.platform === 'win32' ? application.toUpperCase() : application) + '"')
  assert.equal(await services.ensure('cineflow'), undefined)
  assert.deepEqual(state.killed, [77])
  assert.equal(state.launches.length, 1)
  assert.ok(!state.launches[0].cwd.toLowerCase().startsWith(source.toLowerCase()))
})

test('找不到 Electron、启动即退出、超时都给出可读原因；失败后短时间内不反复拉起', async (t) => {
  const missing = await setup(t, { electron: null })
  missing.services.attach('cineflow', await install(missing.dir, '0.2.7'))
  const noElectron = await missing.services.ensure('cineflow')
  assert.match(noElectron.message, /未找到可用的 Electron.*DSH_STUDIO_ELECTRON.*C:\/missing\/electron\.exe/)
  assert.equal(missing.state.launches.length, 0)

  const { dir, state, services, clock } = await setup(t)
  services.attach('cineflow', await install(dir, '0.2.7'))
  state.crash = true
  const crashed = await services.ensure('cineflow')
  assert.equal(crashed.kind, 'exit')
  assert.match(crashed.message, /启动后退出（退出码 1）：Error: Cannot find module x/)
  // 冷却期内的状态轮询直接返回上次失败，不再拉起进程
  assert.equal(await services.ensure('cineflow'), crashed)
  assert.equal(state.launches.length, 1)
  // 用户主动点击启动不受冷却限制；服务迟迟不写连接信息则超时并结束该进程
  state.crash = false; state.silent = true
  const timedOut = await services.ensure('cineflow', { force: true })
  assert.equal(timedOut.kind, 'timeout')
  assert.deepEqual(state.killed, [1001])
  // 冷却结束后自动重试，成功后清除失败记录
  state.silent = false; clock.offset = 60000
  assert.equal(await services.ensure('cineflow'), undefined)
  assert.deepEqual(services.report(), [])
})

test('端口被其他程序占用时不启动；撤销登记后不再协调', async (t) => {
  const { dir, state, services } = await setup(t)
  services.attach('cineflow', await install(dir, '0.2.7'))
  state.alive.add(5)
  const busy = await services.ensure('cineflow')
  assert.match(busy.message, /端口 33105 已被其他程序占用/)
  assert.equal(state.launches.length, 0)
  services.detach('cineflow')
  assert.equal(services.has('cineflow'), false)
  assert.equal(await services.ensure('cineflow', { force: true }), undefined)
  assert.equal(state.launches.length, 0)
})

test('并发协调只拉起一次，并报告正在启动', async (t) => {
  const { dir, state, services } = await setup(t)
  services.attach('cineflow', await install(dir, '0.2.7'))
  const first = services.ensure('cineflow')
  const second = services.ensure('cineflow')
  assert.equal(services.starting('cineflow'), true)
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined])
  assert.equal(state.launches.length, 1)
  assert.equal(services.starting('cineflow'), false)
})

test('Electron 查找顺序：显式配置、环境变量、DSH_HOME 共用目录；打包宿主不可用', async (t) => {
  const { managedServices } = await load(t)
  const source = join('C:', 'profile', 'node_modules', 'dsh-studio-cineflow')
  const binary = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron'
  const shared = join('C:', 'home', '.dsh', 'electron', binary)
  const host = join('D:', 'dsh', 'DeepSeek Harness.exe')
  const packaged = join('D:', 'dsh', 'resources', 'app.asar')
  const find = (configured, env, files, hostIsElectron = true) => managedServices.locateElectron(source, configured, env, path => files.includes(path), host, hostIsElectron)
  assert.equal(find('X:/custom/electron.exe', { DSH_HOME: join('C:', 'home', '.dsh') }, ['X:/custom/electron.exe', shared]).path, 'X:/custom/electron.exe')
  assert.equal(find(undefined, { DSH_STUDIO_ELECTRON: 'Y:/env/electron.exe', DSH_HOME: join('C:', 'home', '.dsh') }, ['Y:/env/electron.exe', shared]).path, 'Y:/env/electron.exe')
  assert.equal(find(undefined, { DSH_HOME: join('C:', 'home', '.dsh') }, [shared, host, packaged]).path, shared)
  // 打包安装的宿主总是启动自带应用，不能当作 Electron 使用
  const none = find(undefined, { DSH_HOME: join('C:', 'home', '.dsh') }, [host, packaged])
  assert.equal(none.path, undefined)
  assert.ok(none.tried.includes(shared))
  // 开发模式由裸 Electron 启动宿主时可直接复用
  assert.equal(find(undefined, { DSH_HOME: join('C:', 'home', '.dsh') }, [host]).path, host)
  assert.equal(find(undefined, { DSH_HOME: join('C:', 'home', '.dsh') }, [host], false).path, undefined)
})

test('注册表在登记与撤销时通知监听者；旧的撤销函数不会移除新的登记', async (t) => {
  const { registry } = await load(t)
  const projects = new registry.StudioProjects()
  const events = []
  const unwatch = projects.watch((event, page) => { events.push(event + ':' + page.id) })
  const remove = projects.register({ id: 'cineflow', root: 'C:/pkg/static' })
  remove()
  const again = projects.register({ id: 'cineflow', root: 'C:/pkg/static' })
  remove()
  assert.equal(projects.has('cineflow'), true)
  assert.deepEqual(events, ['register:cineflow', 'unregister:cineflow', 'register:cineflow'])
  unwatch()
  again()
  assert.deepEqual(events.length, 3)
  assert.equal(projects.has('cineflow'), false)
})

/** 在临时目录中生成一个带 Bun 应用的短剧工作室安装包：构建产物内部自带运行时依赖，Bun 由可选依赖安装在同级 node_modules。 */
async function installMedia(dir, version, { app = true, bunPackage = '@oven/bun-windows-x64' } = {}) {
  const profile = join(dir, 'profile', 'node_modules')
  const source = join(profile, 'dsh-studio-media')
  await rm(source, { recursive: true, force: true })
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-studio-media', version, optionalDependencies: { [bunPackage]: '1.4.3' } }))
  if (app) {
    await mkdir(join(source, 'app', 'build', 'server', 'node_modules', 'sql.js'), { recursive: true })
    await mkdir(join(source, 'app', 'build', 'web'), { recursive: true })
    await mkdir(join(source, 'app', 'node_modules', 'dev-only'), { recursive: true })
    await writeFile(join(source, 'app', 'build', 'server', 'index.js'), '// ' + version)
    await writeFile(join(source, 'app', 'build', 'server', 'node_modules', 'sql.js', 'package.json'), '{"name":"sql.js"}')
    await writeFile(join(source, 'app', 'build', 'web', 'index.html'), '<title>Toonflow</title>')
    await writeFile(join(source, 'app', 'node_modules', 'dev-only', 'package.json'), '{"name":"dev-only"}')
  }
  await mkdir(join(profile, bunPackage, 'bin'), { recursive: true })
  await writeFile(join(profile, bunPackage, 'package.json'), JSON.stringify({ name: bunPackage, version: '1.4.3' }))
  await writeFile(join(profile, bunPackage, 'bin', 'bun.exe'), 'bun')
  return source
}

/** 短剧服务的环境：服务不写 bridge.json，首页能访问即就绪；external 表示有一个不是运行时拉起的服务在监听。 */
async function setupMedia(t) {
  const loaded = await load(t)
  const data = join(loaded.dir, 'toonflow-data'), stateDirectory = join(loaded.dir, 'media-state')
  const state = { launches: [], killed: [], alive: new Set(), nextPid: 2000, external: false, bun: true }
  const platform = {
    electron: () => ({ tried: [] }),
    bun: stage => state.bun ? { path: join(stage, 'node_modules', '@oven', 'bun-windows-x64', 'bin', 'bun.exe'), tried: [] } : { tried: ['X:/missing/bun.exe'] },
    async launch(executable, args, options) {
      const pid = state.nextPid++
      state.launches.push({ executable, args: [...args], cwd: options.cwd, env: options.env, stdout: options.stdout })
      state.alive.add(pid)
      return { pid, exit: () => undefined }
    },
    alive: pid => state.alive.has(pid),
    kill(pid) { state.killed.push(pid); state.alive.delete(pid) },
    healthy: async () => false,
    responds: async (origin, marker) => { state.origin = origin; state.marker = marker; return state.external || state.alive.size > 0 },
    listening: async () => state.external || state.alive.size > 0,
    commandLine: async () => undefined,
  }
  const definition = { ...loaded.managedServices.toonflowService(data, stateDirectory, 'http://127.0.0.1:33101'), timeoutMs: 1500 }
  const services = new loaded.managedServices.ManagedStudioServices([definition], platform)
  return { ...loaded, data, stateDirectory, state, definition, services }
}

test('短剧随包服务：用 Bun 运行副本里的入口，构建产物自带的依赖一起复制，数据与运行副本分开', async (t) => {
  const { dir, data, stateDirectory, state, services } = await setupMedia(t)
  const source = await installMedia(dir, '0.3.0')
  assert.equal(services.attach('media', source), true)
  assert.equal(await services.ensure('media'), undefined)
  assert.equal(state.launches.length, 1)
  const launch = state.launches[0]
  const stage = join(launch.cwd, '..')
  assert.ok(stage.startsWith(join(stateDirectory, 'runtime')), '运行副本在状态目录内，不在数据目录内')
  assert.ok(!existsSync(join(data, 'runtime')), '数据目录里没有运行副本')
  assert.equal(launch.executable, join(stage, 'node_modules', '@oven', 'bun-windows-x64', 'bin', 'bun.exe'))
  assert.deepEqual(launch.args, ['run', join(launch.cwd, 'build', 'server', 'index.js')])
  assert.equal(launch.env.TOONFLOW_DATA_DIR, data)
  assert.equal(launch.env.TOONFLOW_SERVER_PORT, '33101')
  assert.equal(launch.env.TOONFLOW_SERVER_HOST, '127.0.0.1')
  assert.equal(launch.env.TOONFLOW_STUDIO_DSH, '1')
  assert.equal(launch.stdout, join(stateDirectory, 'service.log'))
  // 构建产物内部的 node_modules 是运行时依赖，必须跟着走；应用根目录下开发时装的依赖不复制
  assert.ok(existsSync(join(launch.cwd, 'build', 'server', 'node_modules', 'sql.js', 'package.json')))
  assert.ok(!existsSync(join(launch.cwd, 'node_modules')))
  // Bun 作为可选依赖随副本复制，运行期间不占用安装目录
  assert.ok(existsSync(join(stage, 'node_modules', '@oven', 'bun-windows-x64', 'bin', 'bun.exe')))
  assert.equal(state.origin, 'http://127.0.0.1:33101')
  assert.ok(state.marker.test('<title>Toonflow</title>'))
  // 已在运行且安装目录未变：不重复拉起
  assert.equal(await services.ensure('media'), undefined)
  assert.equal(state.launches.length, 1)
  // 更新到新版本：停掉旧进程，从新副本启动
  await installMedia(dir, '0.3.1')
  assert.equal(await services.ensure('media'), undefined)
  assert.equal(state.launches.length, 2)
  assert.deepEqual(state.killed, [2000])
  assert.ok(state.launches[1].cwd.includes('0.3.1-'))
})

test('短剧：旧版工作室包不带应用时不纳入管理；用户自行启动的服务直接沿用；找不到 Bun 给出处理办法', async (t) => {
  const { dir, state, services } = await setupMedia(t)
  const legacy = await installMedia(dir, '0.2.5', { app: false })
  assert.equal(services.attach('media', legacy), false)
  assert.equal(services.has('media'), false)
  assert.equal(await services.ensure('media'), undefined)
  assert.equal(state.launches.length, 0)

  const source = await installMedia(dir, '0.3.0')
  assert.equal(services.attach('media', source), true)
  state.external = true
  assert.equal(await services.ensure('media'), undefined)
  assert.equal(state.launches.length, 0, '已有服务在提供首页时不再拉起，也不去停它')
  assert.deepEqual(state.killed, [])
  state.external = false

  state.bun = false
  const failure = await services.ensure('media', { force: true })
  assert.equal(failure.kind, 'launch')
  assert.match(failure.message, /AI短剧工作台未找到可用的 Bun：请重新安装该工作室.*DSH_STUDIO_BUN.*bunPath.*X:\/missing\/bun\.exe/)
  assert.equal(state.launches.length, 0)
})

test('短剧服务约定：访问地址不在本机或端口无效时不由运行时管理', async (t) => {
  const { managedServices } = await load(t)
  const make = origin => managedServices.toonflowService('/data', '/state', origin)
  assert.equal(make('https://toonflow.example.com'), undefined)
  assert.equal(make('http://192.168.1.8:33101'), undefined)
  assert.equal(make('http://127.0.0.1:80'), undefined)
  assert.equal(make('not a url'), undefined)
  assert.equal(make('http://localhost:34001').port, 34001)
  assert.equal(make('http://localhost:34001').env.TOONFLOW_SERVER_PORT, '34001')
})

test('Bun 查找顺序：显式配置、环境变量、运行副本、安装目录各级 node_modules、DSH_HOME 共用目录', async (t) => {
  const { managedServices } = await load(t)
  const stage = join('C:', 'state', 'runtime', '0.3.0-abc'), source = join('C:', 'profile', 'node_modules', 'dsh-studio-media')
  const home = join('C:', 'home', '.dsh')
  const staged = join(stage, 'node_modules', '@oven', 'bun-windows-x64', 'bin', 'bun.exe')
  // 安装目录向上查找用的是解析后的绝对路径（非 Windows 系统上 C: 开头的路径会落在当前目录下），期望值按同样方式得出
  const hoisted = join(resolve(source, '..'), '@oven', 'bun-windows-x64', 'bin', 'bun.exe')
  const baseline = join(resolve(source, '..'), '@oven', 'bun-windows-x64-baseline', 'bin', 'bun.exe')
  const shared = join(home, 'bun', 'bun.exe')
  const find = (configured, env, files) => managedServices.locateBun(stage, source, configured, { DSH_HOME: home, ...env }, path => files.includes(path), 'win32', 'x64')
  assert.equal(find('X:/custom/bun.exe', {}, ['X:/custom/bun.exe', staged]).path, 'X:/custom/bun.exe')
  assert.equal(find(undefined, { DSH_STUDIO_BUN: 'Y:/env/bun.exe' }, ['Y:/env/bun.exe', staged]).path, 'Y:/env/bun.exe')
  assert.equal(find(undefined, {}, [staged, hoisted, shared]).path, staged)
  assert.equal(find(undefined, {}, [hoisted, shared]).path, hoisted)
  assert.equal(find(undefined, {}, [baseline, shared]).path, baseline)
  assert.equal(find(undefined, {}, [shared]).path, shared)
  const none = find(undefined, {}, [])
  assert.equal(none.path, undefined)
  assert.ok(none.tried.includes(staged) && none.tried.includes(shared))
  assert.deepEqual(managedServices.bunPackages('darwin', 'arm64'), ['@oven/bun-darwin-aarch64'])
  assert.deepEqual(managedServices.bunPackages('linux', 'x64'), ['@oven/bun-linux-x64', '@oven/bun-linux-x64-baseline'])
  assert.equal(managedServices.locateBun('/s', '/p/node_modules/x', undefined, { DSH_HOME: '/h' }, path => path === join('/h', 'bun', 'bun'), 'linux', 'arm64').path, join('/h', 'bun', 'bun'))
})

test('卸载前停止随包服务：只停确认是自己拉起的进程，之后不再协调', async (t) => {
  const { dir, data, state, services } = await setup(t)
  const source = await install(dir, '0.2.7')
  services.attach('cineflow', source)
  await services.ensure('cineflow')
  const pid = state.launches.length ? 1000 : undefined
  assert.ok(state.alive.has(pid))
  // 查不到命令行：无法确认是自己拉起的，不动它
  await services.shutdown('cineflow')
  assert.deepEqual(state.killed, [])
  assert.equal(services.has('cineflow'), false, '撤销登记，状态轮询不会再把它拉起来')
  // 命令行指向别处（用户自行启动的同类进程碰巧占了这个进程号）：不动
  services.attach('cineflow', source)
  state.commands.set(pid, 'C:/somewhere/else/electron.exe C:/apps/cineflow')
  await services.shutdown('cineflow')
  assert.deepEqual(state.killed, [])
  // 命令行指向运行副本：停止
  services.attach('cineflow', source)
  state.commands.set(pid, 'C:/electron/electron.exe ' + join(data, 'runtime', '0.2.7-abc', 'app'))
  await services.shutdown('cineflow')
  assert.deepEqual(state.killed, [pid])
  assert.equal(await services.ensure('cineflow'), undefined)
  assert.equal(state.launches.length, 1, '撤销登记后不再拉起')
  // 没有约定的工作室直接返回
  await services.shutdown('travel')
})
