/**
 * 本机服务栈：应用、数据库与专用运行时都在用户机器上的固定目录（体积大、依赖数据库，无法随工作室包分发），
 * 由运行时按顺序直接拉起，不经过 PowerShell 启动脚本，也不需要逐条手写启动组。
 * 与随包服务（managedServices）对外是同一套接口：登记、是否可启动、是否正在启动、协调、失败记录。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { nodePlatform, type LaunchedService } from './managedServices'
import type { ServiceStartupFailure } from './serviceStartup'

/** 常驻进程：拉起后等它开始监听端口。 */
export interface StackProcess { name: string; executable: string; args: string[]; cwd: string; port: number; timeoutMs: number }

/** 前置服务：启动命令自己会返回（如 pg_ctl），用状态命令判断是否已在运行。 */
export interface StackPrerequisite {
  name: string
  port: number
  executable: string
  /** 退出码为 0 表示已在运行 */
  statusArgs: string[]
  startArgs: string[]
  timeoutMs: number
}

/** 一个工作室的本机服务栈。 */
export interface StackDefinition {
  studioId: string
  title: string
  /** 各进程的输出写到这里：<name>.log 与 <name>.error.log */
  logDirectory: string
  /** 启动前必须存在的文件或目录；缺失时把 hint 告诉用户 */
  requires: { path: string; hint: string }[]
  /** 进程环境变量；读取本机密钥文件失败时抛出可读的错误 */
  environment(): Promise<Record<string, string>>
  prerequisites: StackPrerequisite[]
  processes: StackProcess[]
  /** 全部返回 2xx 才算就绪 */
  health: string[]
  /** 进程都拉起后等待健康检查通过的毫秒数 */
  timeoutMs: number
}

/** 与操作系统交互的部分，测试时可整体替换。 */
export interface StackPlatform {
  exists(path: string): boolean
  listening(port: number): Promise<boolean>
  /** 运行到结束，返回退出码；无法启动或超时返回 null。 */
  run(executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<number | null>
  launch(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: string; stderr: string }): Promise<LaunchedService>
  /** 地址是否返回 2xx。 */
  ok(url: string): Promise<boolean>
}

/** 自动重试的冷却时间：启动失败后短时间内的状态轮询不再反复拉起进程。 */
const COOLDOWN_MS = 15000
const delay = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })

/** 真实平台实现；拉起进程与端口探测沿用随包服务的实现。 */
export function stackPlatform(): StackPlatform {
  const base = nodePlatform()
  return {
    exists: existsSync,
    listening: port => base.listening(port),
    launch: (executable, args, options) => base.launch(executable, args, options),
    run(executable, args, options) {
      return new Promise(done => {
        // 不接管输出：Windows 上 pg_ctl 拉起的数据库进程会继承管道句柄，接管的话命令永远等不到结束
        const child = spawn(executable, [...args], { env: options.env, windowsHide: true, stdio: 'ignore' })
        const timer = setTimeout(() => { child.kill(); done(null) }, options.timeoutMs)
        child.once('error', () => { clearTimeout(timer); done(null) })
        child.once('exit', code => { clearTimeout(timer); done(code) })
      })
    },
    async ok(url) {
      try { return (await fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'error' })).ok } catch { return false }
    },
  }
}

/** 错误日志的最后一行，帮助界面直接给出原因。 */
async function lastLine(file: string): Promise<string> {
  try {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    return (lines.at(-1) ?? '').slice(0, 300)
  } catch { return '' }
}

/** 本机服务栈管理器：同一工作室的协调串行执行；失败记录按工作室覆盖。已运行的服务不随宿主退出而停止。 */
export class LocalStackServices {
  private readonly definitions = new Map<string, StackDefinition>()
  private readonly attached = new Set<string>()
  private readonly tasks = new Map<string, Promise<ServiceStartupFailure | undefined>>()
  private readonly failures = new Map<string, { failure: ServiceStartupFailure; at: number }>()
  private closed = false

  /**
   * @param definitions - 本机已配置的服务栈。
   * @param platform - 操作系统交互，测试时可替换。
   * @param now - 当前时间，测试时可替换。
   */
  constructor(definitions: readonly StackDefinition[], private readonly platform: StackPlatform = stackPlatform(), private readonly now: () => number = Date.now) {
    for (const definition of definitions) this.definitions.set(definition.studioId, definition)
  }

  /** 工作室登记时调用；没有为它配置服务栈返回 false。重新登记会清除上一次的失败冷却。 */
  attach(studioId: string): boolean {
    if (!this.definitions.has(studioId)) return false
    this.attached.add(studioId)
    this.failures.delete(studioId)
    return true
  }

  /** 工作室停用或卸载：不再协调，已运行的服务保持原样。 */
  detach(studioId: string): void {
    this.attached.delete(studioId)
  }

  /** 该工作室是否有可由运行时启动的本机服务栈。 */
  has(studioId: string): boolean {
    return this.attached.has(studioId)
  }

  /** 该工作室的服务是否正在启动。 */
  starting(studioId: string): boolean {
    return this.tasks.has(studioId)
  }

  /** 最近一次失败记录。 */
  report(): ServiceStartupFailure[] {
    return [...this.failures.values()].map(entry => entry.failure)
  }

  /**
   * 协调指定工作室的服务栈：都在运行则什么也不做，否则按顺序补齐。
   * @param options - force 为 true 时忽略失败冷却（用户主动点击启动）。
   * @returns 失败记录；服务可用时返回 undefined。
   */
  ensure(studioId: string, options: { force?: boolean } = {}): Promise<ServiceStartupFailure | undefined> {
    const definition = this.definitions.get(studioId)
    if (!definition || !this.attached.has(studioId) || this.closed) return Promise.resolve(undefined)
    const running = this.tasks.get(studioId)
    if (running) return running
    const last = this.failures.get(studioId)
    if (!options.force && last && this.now() - last.at < COOLDOWN_MS) return Promise.resolve(last.failure)
    const task = this.reconcile(definition)
      .catch(error => this.failure(definition, 'launch', '无法自动启动（' + (error instanceof Error ? error.message : String(error)) + '）'))
      .then(failure => {
        if (failure) this.failures.set(studioId, { failure, at: this.now() })
        else this.failures.delete(studioId)
        return failure
      })
      .finally(() => { this.tasks.delete(studioId) })
    this.tasks.set(studioId, task)
    return task
  }

  /** 协调全部已登记的服务栈。 */
  async ensureAll(options: { force?: boolean } = {}): Promise<ServiceStartupFailure[]> {
    const outcomes = await Promise.all([...this.attached].map(id => this.ensure(id, options)))
    return outcomes.filter((outcome): outcome is ServiceStartupFailure => outcome !== undefined)
  }

  /** 停用插件：不再发起新的协调，等待进行中的收尾；已运行的服务不停止。 */
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.tasks.values())
  }

  private failure(definition: StackDefinition, kind: ServiceStartupFailure['kind'], reason: string): ServiceStartupFailure {
    return { kind, studioIds: [definition.studioId], message: definition.title + reason }
  }

  private async healthy(definition: StackDefinition): Promise<boolean> {
    return (await Promise.all(definition.health.map(url => this.platform.ok(url)))).every(Boolean)
  }

  private async reconcile(definition: StackDefinition): Promise<ServiceStartupFailure | undefined> {
    if (await this.healthy(definition)) return undefined
    for (const item of definition.requires) if (!this.platform.exists(item.path)) return this.failure(definition, 'launch', '无法启动：缺少 ' + item.path + '。' + item.hint)
    const env: NodeJS.ProcessEnv = { ...process.env, ...await definition.environment() }
    await mkdir(definition.logDirectory, { recursive: true })
    for (const item of definition.prerequisites) {
      if (!this.platform.exists(item.executable)) return this.failure(definition, 'launch', '无法启动：缺少 ' + item.name + ' 的运行文件 ' + item.executable)
      if (await this.platform.run(item.executable, item.statusArgs, { env, timeoutMs: 15000 }) === 0) continue
      if (await this.platform.listening(item.port)) return this.failure(definition, 'launch', '无法启动 ' + item.name + '：端口 ' + String(item.port) + ' 已被其他程序占用')
      const code = await this.platform.run(item.executable, item.startArgs, { env, timeoutMs: item.timeoutMs })
      if (code !== 0) return this.failure(definition, code === null ? 'timeout' : 'exit', '的 ' + item.name + ' 启动失败' + (code === null ? '（超时或无法执行）' : '（退出码 ' + String(code) + '）') + '；日志目录：' + definition.logDirectory)
    }
    for (const item of definition.processes) {
      // 端口已有监听：可能是上次启动留下的，也可能是用户自己启动的，都直接沿用，由最后的健康检查把关
      if (await this.platform.listening(item.port)) continue
      if (!this.platform.exists(item.executable)) return this.failure(definition, 'launch', '无法启动：缺少 ' + item.name + ' 的运行文件 ' + item.executable)
      const errorLog = join(definition.logDirectory, item.name + '.error.log')
      let child: LaunchedService
      try { child = await this.platform.launch(item.executable, item.args, { cwd: item.cwd, env, stdout: join(definition.logDirectory, item.name + '.log'), stderr: errorLog }) }
      catch (error) { return this.failure(definition, 'launch', '的 ' + item.name + ' 无法启动（' + (error instanceof Error ? error.message : String(error)) + '）') }
      const deadline = this.now() + item.timeoutMs
      let listening = false
      while (!listening && this.now() < deadline) {
        const exit = child.exit()
        if (exit) {
          const detail = await lastLine(errorLog)
          return this.failure(definition, 'exit', '的 ' + item.name + ' 启动后退出（退出码 ' + String(exit.code) + '）' + (detail ? '：' + detail : '') + '；日志：' + errorLog)
        }
        if (this.closed) return this.failure(definition, 'cancelled', '自动启动已取消，服务可能仍在启动')
        listening = await this.platform.listening(item.port)
        if (!listening) await delay(250)
      }
      if (!listening) return this.failure(definition, 'timeout', '的 ' + item.name + ' 启动超时，请检查端口 ' + String(item.port) + ' 与日志：' + errorLog)
    }
    const deadline = this.now() + definition.timeoutMs
    while (this.now() < deadline) {
      if (await this.healthy(definition)) return undefined
      if (this.closed) return this.failure(definition, 'cancelled', '自动启动已取消，服务可能仍在启动')
      await delay(300)
    }
    return this.failure(definition, 'timeout', '启动后未就绪，请查看日志目录：' + definition.logDirectory)
  }
}

/** 剧工作室（PRINTFILM）本机目录：应用源码、专用运行时（数据库、缓存、Node、ffmpeg）与数据。 */
export interface PrintfilmServiceConfig { appDirectory: string; runtimeDirectory: string; dataDirectory: string }

/**
 * 读取剧工作室的本机目录配置：插件配置优先，其次环境变量 DSH_STUDIO_PRINTFILM_APP / _RUNTIME / _DATA。
 * 三个目录要么都给、要么都不给；都不给表示本机没有准备这套服务，返回 undefined。
 */
export function resolvePrintfilmService(input: unknown, env: NodeJS.ProcessEnv = process.env): PrintfilmServiceConfig | undefined {
  const fromEnv = { appDirectory: env.DSH_STUDIO_PRINTFILM_APP, runtimeDirectory: env.DSH_STUDIO_PRINTFILM_RUNTIME, dataDirectory: env.DSH_STUDIO_PRINTFILM_DATA }
  if (input === undefined && Object.values(fromEnv).every(value => !value)) return undefined
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) throw new Error('工作室 printfilmService 配置必须是对象')
  const source = { ...fromEnv, ...(input as Record<string, unknown> | undefined) }
  const result = {} as PrintfilmServiceConfig
  for (const key of ['appDirectory', 'runtimeDirectory', 'dataDirectory'] as const) {
    const value = source[key]
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('工作室 printfilmService 配置无效：appDirectory、runtimeDirectory、dataDirectory 都必须是绝对路径')
    result[key] = resolve(value)
  }
  return result
}

/**
 * 剧工作室的服务栈：PostgreSQL → Garnet（缓存）→ 后端接口 → 前台与管理后台两个页面服务。
 * 端口与原启动脚本一致：页面取自工作室访问地址，其余固定（管理后台 33103、接口 33104、数据库 35432、缓存 36379）。
 * @param origin - 工作室页面访问前台的地址；不是本机回环地址（服务部署在别处）时返回 undefined，不由运行时管理。
 */
export function printfilmStack(config: PrintfilmServiceConfig, origin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): StackDefinition | undefined {
  let url: URL
  try { url = new URL(origin) } catch { return undefined }
  const webPort = Number(url.port || '80')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !Number.isSafeInteger(webPort) || webPort < 1024 || webPort > 65535) return undefined
  const adminPort = 33103, apiPort = 33104, databasePort = 35432, cachePort = 36379
  const exe = (name: string) => platform === 'win32' ? name + '.exe' : name
  const { appDirectory: app, runtimeDirectory: runtime, dataDirectory: data } = config
  const web = 'http://127.0.0.1:' + String(webPort), admin = 'http://127.0.0.1:' + String(adminPort), api = 'http://127.0.0.1:' + String(apiPort)
  const secrets = join(data, 'runtime.json')
  const databaseDirectory = join(data, 'postgres')
  const cacheDirectory = join(data, 'garnet')
  const pgControl = join(runtime, 'pgsql', 'bin', exe('pg_ctl'))
  const node = env.DSH_STUDIO_NODE || join(runtime, 'node', 'bin', exe('node'))
  const python = platform === 'win32' ? join(app, '.venv', 'Scripts', 'python.exe') : join(app, '.venv', 'bin', 'python')
  const preview = (directory: string, port: number) => [join(app, directory, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
  const prepared = '请先按剧工作室说明准备应用与数据库（README「服务配置」）。'
  return {
    studioId: 'film', title: 'AI剧工作台', logDirectory: join(data, 'logs'), timeoutMs: 40000,
    requires: [
      { path: secrets, hint: prepared },
      { path: join(databaseDirectory, 'PG_VERSION'), hint: prepared },
      { path: join(app, 'backend'), hint: prepared },
      { path: join(app, 'frontend', 'dist'), hint: '请先构建前台页面。' },
      { path: join(app, 'admin', 'dist'), hint: '请先构建管理后台页面。' },
    ],
    async environment() {
      let saved: { databasePassword?: unknown; secretKey?: unknown }
      try { saved = JSON.parse(await readFile(secrets, 'utf8')) } catch { throw new Error('无法读取 ' + secrets) }
      if (typeof saved?.databasePassword !== 'string' || !saved.databasePassword || typeof saved.secretKey !== 'string' || !saved.secretKey) throw new Error(secrets + ' 缺少 databasePassword 或 secretKey')
      const password = encodeURIComponent(saved.databasePassword)
      // Windows 的 PATH 变量名大小写不固定，沿用已有的那个键，避免出现两个 PATH
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
      const origins = web + ',' + admin
      return {
        DOTNET_ROOT: join(runtime, 'dotnet'), PYTHONUTF8: '1',
        [pathKey]: join(runtime, 'ffmpeg') + delimiter + (env[pathKey] ?? ''),
        DATABASE_URL: 'postgresql+asyncpg://printfilm:' + password + '@127.0.0.1:' + String(databasePort) + '/printfilm',
        DATABASE_URL_SYNC: 'postgresql+psycopg2://printfilm:' + password + '@127.0.0.1:' + String(databasePort) + '/printfilm',
        SECRET_KEY: saved.secretKey, REDIS_URL: 'redis://127.0.0.1:' + String(cachePort) + '/0',
        CORS_ORIGINS: origins, PUBLIC_BASE_URL: web, CDN_BASE: api + '/static', PRINTFILM_API_ORIGIN: api,
        // 默认单用户模式；设为 0 可恢复原邮箱登录
        STUDIO_LOCAL_ORIGINS: origins, STUDIO_SINGLE_USER: env.DSH_STUDIO_PRINTFILM_SINGLE_USER === '0' ? 'false' : 'true', ARK_MOCK: 'false',
      }
    },
    prerequisites: [{
      name: '数据库', port: databasePort, executable: pgControl, timeoutMs: 60000,
      statusArgs: ['-D', databaseDirectory, 'status'],
      startArgs: ['-D', databaseDirectory, '-l', join(data, 'postgres.log'), '-o', '-p ' + String(databasePort) + ' -h 127.0.0.1', '-w', 'start'],
    }],
    processes: [
      { name: 'garnet', executable: join(runtime, 'garnet', 'net10.0', exe('GarnetServer')), cwd: runtime, port: cachePort, timeoutMs: 25000,
        args: ['--port', String(cachePort), '--bind', '127.0.0.1', '--memory', '128m', '--storage-tier', '--logdir', cacheDirectory, '--checkpointdir', cacheDirectory, '--aof', '--recover'] },
      { name: 'printfilm-api', executable: python, cwd: join(app, 'backend'), port: apiPort, timeoutMs: 60000,
        args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort)] },
      { name: 'printfilm-web', executable: node, cwd: join(app, 'frontend'), port: webPort, timeoutMs: 25000, args: preview('frontend', webPort) },
      { name: 'printfilm-admin', executable: node, cwd: join(app, 'admin'), port: adminPort, timeoutMs: 25000, args: preview('admin', adminPort) },
    ],
    health: [web, admin, api + '/api/health'],
  }
}
