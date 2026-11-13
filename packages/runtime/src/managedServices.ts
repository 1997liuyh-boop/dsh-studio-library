/**
 * 随工作室包分发的本机服务：运行时直接拉起，不依赖 PowerShell 脚本，也不需要手写启动配置。
 * 服务从数据目录下的独立副本运行——安装目录没有进程占用，pnpm 随时可以替换；
 * 安装目录内容变化（更新、重装）后，下一次协调会自动切换到新版本。
 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ServiceStartupFailure } from './serviceStartup'

/** 一个随包服务的约定：应用目录、数据目录、端口与握手方式均由工作室决定。 */
export interface ManagedServiceDefinition {
  studioId: string
  title: string
  /** 包内应用目录（相对安装目录），连同依赖一起复制到运行副本 */
  app: string
  /** 应用目录内必须存在的文件（相对应用目录）；缺失表示安装不完整 */
  requires: readonly string[]
  /** 数据目录：服务在其中写入 bridge.json，运行副本位于其 runtime 子目录 */
  dataDirectory: string
  port: number
  /** 传给服务进程的环境变量 */
  env: Record<string, string>
  /** 等待服务就绪的毫秒数 */
  timeoutMs: number
  /** 启动方式：缺省为 Electron 应用（以应用目录为参数启动）；bun 表示用 Bun 运行应用目录内的入口脚本 */
  runner?: { kind: 'bun'; entry: string }
  /**
   * 就绪判定：缺省读取服务写在数据目录的 bridge.json 并检查其 /health；
   * http 表示服务固定监听 port，首页返回 200 且内容匹配 marker 即就绪（服务自己不写连接信息）。
   */
  ready?: { kind: 'http'; marker: RegExp }
  /** 运行副本、进程记录与日志所在目录；缺省与 dataDirectory 相同。数据目录属于应用自己时单独指定，避免混在一起。 */
  stateDirectory?: string
  /** 应用目录是否可缺：为真时，安装包里没有应用目录的旧版工作室不纳入管理（仍由用户自行启动服务） */
  optional?: boolean
}

/** 运行副本、进程记录与日志所在目录。 */
const stateOf = (definition: ManagedServiceDefinition) => definition.stateDirectory ?? definition.dataDirectory

/** 已拉起的服务进程；exit 返回退出信息，仍在运行时返回 undefined。 */
export interface LaunchedService { pid: number; exit(): { code: number | null } | undefined }

/** 与操作系统交互的部分，测试时可整体替换。 */
export interface ServicePlatform {
  /** 查找可用的 Electron 程序；tried 为已尝试的位置，用于提示。 */
  electron(source: string): { path?: string; tried: string[] }
  launch(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: string; stderr: string }): Promise<LaunchedService>
  alive(pid: number): boolean
  kill(pid: number): void
  healthy(origin: string): Promise<boolean>
  listening(port: number): Promise<boolean>
  /** 进程命令行；查询不到返回 undefined。 */
  commandLine(pid: number): Promise<string | undefined>
  /** 查找可用的 Bun 程序：stage 为运行副本，source 为安装目录；tried 为已尝试的位置。只有 runner 为 bun 的服务用到。 */
  bun?(stage: string, source: string): { path?: string; tried: string[] }
  /** 地址首页是否返回 200 且内容匹配 marker。只有 ready 为 http 的服务用到。 */
  responds?(origin: string, marker: RegExp): Promise<boolean>
}

interface ServiceRecord { schemaVersion: 1; pid: number; stage: string; fingerprint: string; version: string; source: string; startedAt: string }
interface Installed { version: string; fingerprint: string; missing?: string }
interface Bridge { origin: string; pid: number }

/** 运行副本写入完成的标记；没有它的目录视为残缺。 */
const STAGED = '.staged.json'
/** 自动重试的冷却时间：启动失败后短时间内的状态轮询不再反复拉起进程。 */
const COOLDOWN_MS = 15000
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const delay = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })
const fold = (path: string) => { const full = resolve(path); return process.platform === 'win32' ? full.toLowerCase() : full }
const isFile = async (path: string) => { try { return (await stat(path)).isFile() } catch { return false } }

/** Electron 程序在各平台上的文件名。 */
function electronBinary(): string {
  return process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron'
}

/**
 * 依次尝试：显式配置、DSH_STUDIO_ELECTRON、DSH_HOME/electron（桌面插件共用的独立 Electron）、
 * 安装目录各级 node_modules 中的 electron 包、以及开发模式下的宿主程序本身。
 * 打包安装的宿主（同级有 resources/app.asar）总是启动自带应用，不能用来运行工作室服务。
 */
export function locateElectron(source: string, configured: string | undefined, env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync, execPath: string = process.execPath, hostIsElectron = !!process.versions.electron): { path?: string; tried: string[] } {
  const binary = electronBinary()
  const candidates: string[] = []
  if (configured) candidates.push(configured)
  if (env.DSH_STUDIO_ELECTRON) candidates.push(env.DSH_STUDIO_ELECTRON)
  candidates.push(join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'electron', binary))
  for (let dir = resolve(source); ; dir = dirname(dir)) {
    candidates.push(join(dir, 'node_modules', 'electron', 'dist', binary))
    if (dirname(dir) === dir) break
  }
  if (hostIsElectron && !exists(join(dirname(execPath), 'resources', 'app.asar'))) candidates.push(execPath)
  const tried = [...new Set(candidates)]
  const path = tried.find(candidate => exists(candidate))
  return { ...(path ? { path } : {}), tried }
}

/** 当前平台对应的 Bun 分发包（npm 上的 @oven/bun-*，包内 bin 目录就是可执行文件）。 */
export function bunPackages(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x64'
  const system = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  const base = '@oven/bun-' + system + '-' + cpu
  // 不支持 AVX2 的老 x64 处理器安装的是 baseline 版本
  return cpu === 'x64' ? [base, base + '-baseline'] : [base]
}

/**
 * 依次尝试：显式配置、DSH_STUDIO_BUN、运行副本里随依赖复制过来的 Bun、安装目录各级 node_modules 中的 Bun 分发包、
 * DSH_HOME/bun（手动放置的共用 Bun）。工作室包把各平台的 Bun 声明为可选依赖，宿主安装时只会装上当前平台那一个。
 */
export function locateBun(stage: string, source: string, configured: string | undefined, env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform, arch: string = process.arch): { path?: string; tried: string[] } {
  const binary = platform === 'win32' ? 'bun.exe' : 'bun'
  const packages = bunPackages(platform, arch)
  const candidates: string[] = []
  if (configured) candidates.push(configured)
  if (env.DSH_STUDIO_BUN) candidates.push(env.DSH_STUDIO_BUN)
  for (const name of packages) candidates.push(join(stage, 'node_modules', name, 'bin', binary))
  for (let dir = resolve(source); ; dir = dirname(dir)) {
    for (const name of packages) candidates.push(join(dir, 'node_modules', name, 'bin', binary))
    if (dirname(dir) === dir) break
  }
  candidates.push(join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'bun', binary))
  const tried = [...new Set(candidates)]
  const path = tried.find(candidate => exists(candidate))
  return { ...(path ? { path } : {}), tried }
}

/** 真实平台实现。 */
export function nodePlatform(configuredElectron?: string, configuredBun?: string): ServicePlatform {
  return {
    electron: source => locateElectron(source, configuredElectron),
    bun: (stage, source) => locateBun(stage, source, configuredBun),
    async responds(origin, marker) {
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(2500), redirect: 'error' })
        return response.ok && marker.test((await response.text()).slice(0, 100000))
      } catch { return false }
    },
    async launch(executable, args, options) {
      const stdout = await open(options.stdout, 'w')
      const stderr = await open(options.stderr, 'w')
      try {
        // detached：服务独立于宿主存活；退出桌面不会带走正在播放或投屏的服务
        const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env, detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] })
        let exited: { code: number | null } | undefined
        child.once('exit', code => { exited = { code } })
        await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail) })
        child.on('error', () => { /* 启动成功后的信号错误不影响宿主 */ })
        child.unref()
        if (child.pid === undefined) throw new Error('未取得进程标识')
        return { pid: child.pid, exit: () => exited }
      } finally { await stdout.close(); await stderr.close() }
    },
    alive(pid) {
      try { process.kill(pid, 0); return true }
      catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM' }
    },
    kill(pid) { process.kill(pid) },
    async healthy(origin) {
      try {
        const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(2500), redirect: 'error' })
        return response.ok && (await response.json() as { studio?: unknown }).studio === true
      } catch { return false }
    },
    listening(port) {
      return new Promise(done => {
        const socket = connect({ host: '127.0.0.1', port })
        const finish = (value: boolean) => { socket.destroy(); done(value) }
        socket.setTimeout(1000, () => finish(false))
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
      })
    },
    commandLine(pid) {
      // 系统自带的 Windows PowerShell 5.1 即可查询，不要求安装 PowerShell 7
      const [command, args] = process.platform === 'win32'
        ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(Math.trunc(pid))}').CommandLine`]] as const
        : ['ps', ['-o', 'command=', '-p', String(Math.trunc(pid))]] as const
      return new Promise(done => {
        execFile(command, [...args], { windowsHide: true, timeout: 10000, encoding: 'utf8' }, (error, stdout) => { done(error || !stdout.trim() ? undefined : stdout.trim()) })
      })
    },
  }
}

/** 读取服务写下的连接信息；只接受本机回环地址。 */
async function readBridge(dataDirectory: string): Promise<Bridge | undefined> {
  try {
    const descriptor = JSON.parse(await readFile(join(dataDirectory, 'bridge.json'), 'utf8'))
    const url = new URL(descriptor.origin)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) return undefined
    return { origin: url.origin, pid: descriptor.pid }
  } catch { return undefined }
}

async function readRecord(dataDirectory: string): Promise<ServiceRecord | undefined> {
  try {
    const saved = JSON.parse(await readFile(join(dataDirectory, 'runtime', 'current.json'), 'utf8'))
    if (saved?.schemaVersion !== 1 || !Number.isSafeInteger(saved.pid) || typeof saved.stage !== 'string' || !/^[0-9A-Za-z.+-]{1,96}$/.test(saved.stage)
      || typeof saved.fingerprint !== 'string' || typeof saved.version !== 'string' || typeof saved.source !== 'string') return undefined
    return saved
  } catch { return undefined }
}

async function writeRecord(dataDirectory: string, record: ServiceRecord): Promise<void> {
  const directory = join(dataDirectory, 'runtime')
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, '.current-' + randomUUID() + '.json')
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, join(directory, 'current.json'))
}

/**
 * 读取安装目录的版本与内容指纹（应用目录内各文件的路径、大小与修改时间）。
 * 只做 stat，不打开文件，避免与正在进行的包替换互相妨碍。
 */
export async function inspectInstall(source: string, definition: ManagedServiceDefinition): Promise<Installed> {
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (typeof pkg?.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(pkg.version)) version = pkg.version
  } catch { /* 清单缺失时仍按内容指纹区分 */ }
  const hash = createHash('sha256').update(version + '\n')
  const root = join(source, definition.app)
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let names: string[]
    try { names = (await readdir(directory)).sort() } catch { return }
    for (const name of names) {
      if (name === 'node_modules') continue
      try {
        const info = await stat(join(directory, name))
        if (info.isDirectory()) await walk(join(directory, name), prefix + name + '/')
        else hash.update(prefix + name + '\0' + String(info.size) + '\0' + String(Math.trunc(info.mtimeMs)) + '\n')
      } catch { /* 遍历期间被删除的文件不计入 */ }
    }
  }
  await walk(root, '')
  let missing: string | undefined
  for (const file of definition.requires) if (!missing && !(await isFile(join(root, file)))) missing = definition.app + '/' + file
  return { version, fingerprint: hash.digest('hex'), ...(missing ? { missing } : {}) }
}

/** 运行副本是否完整：写入标记与必需文件都在。 */
async function stageComplete(stage: string, definition: ManagedServiceDefinition): Promise<boolean> {
  if (!(await isFile(join(stage, STAGED)))) return false
  for (const file of definition.requires) if (!(await isFile(join(stage, definition.app, file)))) return false
  return true
}

/**
 * 把安装包声明的依赖及其传递依赖复制到运行副本的 node_modules，使副本不再回头读取安装目录。
 * 按 Node 的查找顺序逐级向上找 node_modules；找不到的依赖跳过，由服务自己的日志暴露。
 */
async function copyDependencies(source: string, target: string): Promise<void> {
  const found = new Map<string, string>()
  const queue: { name: string; from: string }[] = []
  const enqueue = async (directory: string) => {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      for (const name of Object.keys({ ...pkg?.dependencies, ...pkg?.optionalDependencies })) if (PACKAGE_NAME.test(name)) queue.push({ name, from: directory })
    } catch { /* 没有清单的目录没有依赖 */ }
  }
  const locate = async (name: string, from: string): Promise<string | undefined> => {
    const starts = [from]
    try { const real = await realpath(from); if (real !== from) starts.unshift(real) } catch { /* 无法解析时只按原路径查找 */ }
    for (const start of starts) {
      for (let directory = start; ; directory = dirname(directory)) {
        const candidate = join(directory, 'node_modules', name)
        if (await isFile(join(candidate, 'package.json'))) return realpath(candidate)
        if (dirname(directory) === directory) break
      }
    }
    return undefined
  }
  await enqueue(source)
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (found.has(next.name)) continue
    const directory = await locate(next.name, next.from)
    if (!directory) continue
    found.set(next.name, directory)
    await enqueue(directory)
  }
  for (const [name, directory] of found) {
    const destination = join(target, name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(directory, destination, { recursive: true, dereference: true })
  }
}

/** 错误日志的最后一行，帮助界面直接给出原因。 */
async function lastLine(file: string): Promise<string> {
  try {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    return (lines.at(-1) ?? '').slice(0, 300)
  } catch { return '' }
}

/** 影音工作室：Electron 应用，以环境变量进入工作室模式并在数据目录写入连接信息。 */
export function cineflowService(dataDirectory: string, env: NodeJS.ProcessEnv = process.env): ManagedServiceDefinition {
  const requested = Number(env.DSH_STUDIO_CINEFLOW_PORT)
  const port = Number.isSafeInteger(requested) && requested >= 1024 && requested <= 65535 ? requested : 33105
  return { studioId: 'cineflow', title: '影音工作室', app: 'app', requires: ['package.json', 'electron/main.cjs', 'dist/index.html'],
    dataDirectory, port, env: { DSH_STUDIO_CINEFLOW_DATA: dataDirectory, DSH_STUDIO_CINEFLOW_PORT: String(port) }, timeoutMs: 30000 }
}

/**
 * 短剧工作室（Toonflow）：Bun 运行的本机服务，应用构建产物随工作室包分发（app/build）。
 * 服务按自身位置找 build/web 等目录，不依赖启动位置；数据（数据库、素材、工作区）在 dataDirectory，
 * 运行副本与日志在 stateDirectory，两者分开，清理运行副本不会碰到用户数据。
 * @param origin - 工作室页面访问服务的地址；不是本机回环地址（服务部署在别处）时返回 undefined，不由运行时管理。
 */
export function toonflowService(dataDirectory: string, stateDirectory: string, origin: string): ManagedServiceDefinition | undefined {
  let url: URL
  try { url = new URL(origin) } catch { return undefined }
  const port = Number(url.port || '80')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) return undefined
  return { studioId: 'media', title: 'AI短剧工作台', app: 'app', optional: true, requires: ['build/server/index.js', 'build/web/index.html'],
    runner: { kind: 'bun', entry: 'build/server/index.js' }, ready: { kind: 'http', marker: /toonflow/i },
    dataDirectory, stateDirectory, port, timeoutMs: 60000,
    env: { TOONFLOW_STUDIO_DSH: '1', TOONFLOW_SERVER_HOST: '127.0.0.1', TOONFLOW_SERVER_PORT: String(port), TOONFLOW_DATA_DIR: dataDirectory } }
}

/**
 * 随包服务管理器：工作室注册时登记安装目录，随后按需协调——未运行则启动，
 * 安装目录有变化则切换版本，旧脚本遗留在安装目录内运行的进程替换为独立副本。
 * 同一工作室的协调串行执行；失败记录按工作室覆盖。
 */
export class ManagedStudioServices {
  private readonly definitions = new Map<string, ManagedServiceDefinition>()
  private readonly sources = new Map<string, string>()
  private readonly tasks = new Map<string, Promise<ServiceStartupFailure | undefined>>()
  private readonly failures = new Map<string, { failure: ServiceStartupFailure; at: number }>()
  private closed = false

  /**
   * @param definitions - 本运行时认识的随包服务。
   * @param platform - 操作系统交互，测试时可替换。
   * @param now - 当前时间，测试时可替换。
   */
  constructor(definitions: readonly ManagedServiceDefinition[], private readonly platform: ServicePlatform = nodePlatform(),
    private readonly now: () => number = Date.now) {
    for (const definition of definitions) this.definitions.set(definition.studioId, definition)
  }

  /**
   * 登记工作室的安装目录；没有对应服务约定的工作室返回 false。
   * 重新登记（更新后重新加载）会清除上一次的失败冷却，立即可以重试。
   */
  attach(studioId: string, source: string): boolean {
    const definition = this.definitions.get(studioId)
    if (!definition) return false
    // 旧版工作室包不带应用目录：服务仍由用户自行启动，不显示「一键启动」也不报安装不完整
    if (definition.optional && !existsSync(join(resolve(source), definition.app))) { this.sources.delete(studioId); return false }
    this.sources.set(studioId, resolve(source))
    this.failures.delete(studioId)
    return true
  }

  /** 工作室停用或卸载：不再协调，已运行的服务保持原样。 */
  detach(studioId: string): void {
    this.sources.delete(studioId)
  }

  /** 该工作室是否有可由运行时启动的随包服务。 */
  has(studioId: string): boolean {
    return this.definitions.has(studioId) && this.sources.has(studioId)
  }

  /** 该工作室的服务是否正在启动或切换版本。 */
  starting(studioId: string): boolean {
    return this.tasks.has(studioId)
  }

  /** 最近一次失败记录。 */
  report(): ServiceStartupFailure[] {
    return [...this.failures.values()].map(entry => entry.failure)
  }

  /**
   * 协调指定工作室的服务。
   * @param studioId - 工作室标识；未登记时直接返回。
   * @param options - force 为 true 时忽略失败冷却（用户主动点击启动）。
   * @returns 失败记录；服务可用时返回 undefined。
   */
  ensure(studioId: string, options: { force?: boolean } = {}): Promise<ServiceStartupFailure | undefined> {
    const definition = this.definitions.get(studioId)
    const source = this.sources.get(studioId)
    if (!definition || !source || this.closed) return Promise.resolve(undefined)
    const running = this.tasks.get(studioId)
    if (running) return running
    const last = this.failures.get(studioId)
    if (!options.force && last && this.now() - last.at < COOLDOWN_MS) return Promise.resolve(last.failure)
    const task = this.reconcile(definition, source)
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

  /** 协调全部已登记的服务。 */
  async ensureAll(options: { force?: boolean } = {}): Promise<ServiceStartupFailure[]> {
    const outcomes = await Promise.all([...this.sources.keys()].map(id => this.ensure(id, options)))
    return outcomes.filter((outcome): outcome is ServiceStartupFailure => outcome !== undefined)
  }

  /** 停用插件：不再发起新的协调，等待进行中的收尾；已运行的服务不停止。 */
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.tasks.values())
  }

  private failure(definition: ManagedServiceDefinition, kind: ServiceStartupFailure['kind'], reason: string): ServiceStartupFailure {
    return { kind, studioIds: [definition.studioId], message: definition.title + reason }
  }

  /**
   * 当前正在提供服务的进程；没有健康的服务时返回 undefined。
   * ours 为本运行时的启动记录（进程确实是它拉起的）；pid 缺省表示服务在运行但查不到是谁启动的。
   */
  private async current(definition: ManagedServiceDefinition, record: ServiceRecord | undefined): Promise<{ pid?: number; ours?: ServiceRecord } | undefined> {
    if (definition.ready) {
      if (!(await this.platform.responds?.(this.origin(definition), definition.ready.marker))) return undefined
      // 服务不写连接信息：记录里的进程还活着，就认为正在监听的是它
      const ours = record && this.platform.alive(record.pid) ? record : undefined
      return ours ? { pid: ours.pid, ours } : {}
    }
    const bridge = await readBridge(definition.dataDirectory)
    if (!bridge || !(await this.platform.healthy(bridge.origin))) return undefined
    return { pid: bridge.pid, ...(record?.pid === bridge.pid ? { ours: record } : {}) }
  }

  /** 以 HTTP 首页判定就绪的服务所在地址。 */
  private origin(definition: ManagedServiceDefinition): string {
    return 'http://127.0.0.1:' + String(definition.port)
  }

  private async reconcile(definition: ManagedServiceDefinition, source: string): Promise<ServiceStartupFailure | undefined> {
    const state = stateOf(definition)
    const [record, installed] = await Promise.all([readRecord(state), inspectInstall(source, definition)])
    const running = await this.current(definition, record)
    const incomplete = installed.missing ? '安装不完整（缺少 ' + installed.missing + '），请在工作室控制台重新安装或更新' : undefined
    if (running) {
      const ours = running.ours
      // 另一个 profile 中的同名工作室启动的服务：直接复用，不互相抢占
      if (ours && fold(ours.source) !== fold(source)) return undefined
      if (ours && ours.fingerprint === installed.fingerprint) return undefined
      if (!ours) {
        // 不是本运行时拉起的进程：只有旧启动脚本留下的「在安装目录内运行」的进程才替换，其余（用户自行启动）不动
        if (running.pid === undefined) return undefined
        const command = await this.platform.commandLine(running.pid)
        if (!command || !this.runsInside(command, source)) return undefined
      }
      if (incomplete) return this.failure(definition, 'launch', incomplete + '；当前继续使用正在运行的版本')
      const stage = await this.stage(definition, source, installed)
      if (typeof stage !== 'string') return stage
      if (running.pid !== undefined && !(await this.stop(definition, running.pid))) return this.failure(definition, 'timeout', '旧版本未能停止，请稍后重新连接')
      return this.start(definition, source, stage, installed)
    }
    if (await this.platform.listening(definition.port)) return this.failure(definition, 'launch', '无法启动：端口 ' + String(definition.port) + ' 已被其他程序占用')
    if (incomplete) {
      // 安装目录残缺（例如更新中断）：上一次的运行副本还在就继续用它，服务不因此中断
      const previous = record ? join(state, 'runtime', record.stage) : undefined
      if (record && previous && await stageComplete(previous, definition)) return this.start(definition, record.source, previous, record)
      return this.failure(definition, 'launch', incomplete)
    }
    const stage = await this.stage(definition, source, installed)
    if (typeof stage !== 'string') return stage
    return this.start(definition, source, stage, installed)
  }

  /** 命令行是否指向安装目录内（Windows 下不区分大小写与斜杠方向）。 */
  private runsInside(command: string, source: string): boolean {
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase().replaceAll('/', '\\') : value
    return normalize(command).includes(normalize(resolve(source)))
  }

  /**
   * 准备运行副本：同一版本与内容指纹的副本直接复用。
   * 复制期间安装目录又发生变化（更新正在进行）则放弃本次，稍后重试。
   */
  private async stage(definition: ManagedServiceDefinition, source: string, installed: Installed): Promise<string | ServiceStartupFailure> {
    const runtime = join(stateOf(definition), 'runtime')
    const target = join(runtime, installed.version + '-' + installed.fingerprint.slice(0, 12))
    if (await stageComplete(target, definition)) return target
    const temporary = join(runtime, '.staging-' + randomUUID())
    try {
      await rm(target, { recursive: true, force: true })
      await mkdir(temporary, { recursive: true })
      const application = join(source, definition.app)
      const skipped = fold(join(application, 'node_modules'))
      await cp(application, join(temporary, definition.app), { recursive: true, dereference: true, filter: path => fold(path) !== skipped })
      await copyDependencies(source, join(temporary, 'node_modules'))
      const after = await inspectInstall(source, definition)
      if (after.fingerprint !== installed.fingerprint) return this.failure(definition, 'launch', '的安装目录正在变化（可能正在更新），请稍后重新连接')
      await writeFile(join(temporary, STAGED), JSON.stringify({ version: installed.version, fingerprint: installed.fingerprint }) + '\n')
      if (!(await stageComplete(temporary, definition))) return this.failure(definition, 'launch', '的运行副本不完整，请重新安装或更新后再试')
      await rename(temporary, target)
      return target
    } catch (error) {
      return this.failure(definition, 'launch', '无法准备运行副本（' + (error instanceof Error ? error.message : String(error)) + '）')
    } finally { await rm(temporary, { recursive: true, force: true }).catch(() => { /* 残留的临时目录下次清理 */ }) }
  }

  /**
   * 卸载工作室前调用：停止由本运行时拉起的服务，并不再协调它。
   * 只停确认是自己拉起的进程——启动记录里的进程还活着，且命令行指向运行副本；
   * 用户自行启动的服务、查不到命令行的进程都不动。
   */
  async shutdown(studioId: string): Promise<void> {
    const definition = this.definitions.get(studioId)
    if (!definition) return
    this.sources.delete(studioId)
    await this.tasks.get(studioId)?.catch(() => undefined)
    const state = stateOf(definition)
    const record = await readRecord(state)
    if (!record || !this.platform.alive(record.pid)) return
    const command = await this.platform.commandLine(record.pid)
    if (!command || !this.runsInside(command, join(state, 'runtime'))) return
    await this.stop(definition, record.pid)
  }

  /** 结束旧进程并等待其退出、端口释放。 */
  private async stop(definition: ManagedServiceDefinition, pid: number): Promise<boolean> {
    try { this.platform.kill(pid) } catch { /* 进程已自行退出 */ }
    const deadline = this.now() + 10000
    while (this.now() < deadline) {
      if (!this.platform.alive(pid) && !(await this.platform.listening(definition.port))) return true
      await delay(200)
    }
    return false
  }

  /** 从运行副本拉起服务，等待它写下连接信息并通过健康检查。 */
  private async start(definition: ManagedServiceDefinition, source: string, stage: string, installed: { version: string; fingerprint: string }): Promise<ServiceStartupFailure | undefined> {
    const data = definition.dataDirectory
    const state = stateOf(definition)
    const application = join(stage, definition.app)
    let executable: string, args: string[]
    if (definition.runner?.kind === 'bun') {
      const located = this.platform.bun?.(stage, source) ?? { tried: [] }
      if (!located.path) {
        return this.failure(definition, 'launch', '未找到可用的 Bun：请重新安装该工作室（Bun 随工作室的可选依赖安装），或设置环境变量 DSH_STUDIO_BUN，或在 dsh-studio-projects 插件配置的 bunPath 中填写 Bun 程序路径（已尝试：' + located.tried.join('、') + '）')
      }
      executable = located.path
      args = ['run', join(application, definition.runner.entry)]
    } else {
      const located = this.platform.electron(source)
      if (!located.path) {
        return this.failure(definition, 'launch', '未找到可用的 Electron：请设置环境变量 DSH_STUDIO_ELECTRON，或在 dsh-studio-projects 插件配置的 electronPath 中填写 Electron 程序路径（已尝试：' + located.tried.join('、') + '）')
      }
      executable = located.path
      args = [application]
    }
    const errorLog = join(state, 'service.error.log')
    // 宿主以 Node 模式运行 Electron 时会带上 ELECTRON_RUN_AS_NODE，服务必须以完整 Electron 启动
    const env: NodeJS.ProcessEnv = { ...process.env, ...definition.env }
    delete env.ELECTRON_RUN_AS_NODE
    let child: LaunchedService
    try {
      await mkdir(data, { recursive: true })
      await mkdir(state, { recursive: true })
      child = await this.platform.launch(executable, args, { cwd: application, env, stdout: join(state, 'service.log'), stderr: errorLog })
    } catch (error) {
      return this.failure(definition, 'launch', '无法启动（' + (error instanceof Error ? error.message : String(error)) + '）')
    }
    await writeRecord(state, { schemaVersion: 1, pid: child.pid, stage: stage.slice(join(state, 'runtime').length + 1), fingerprint: installed.fingerprint, version: installed.version, source, startedAt: new Date().toISOString() })
    const deadline = this.now() + definition.timeoutMs
    while (this.now() < deadline) {
      const exit = child.exit()
      if (exit) {
        const detail = await lastLine(errorLog)
        return this.failure(definition, 'exit', '启动后退出（退出码 ' + String(exit.code) + '）' + (detail ? '：' + detail : '') + '；日志：' + errorLog)
      }
      let ready: boolean
      if (definition.ready) ready = await this.platform.responds?.(this.origin(definition), definition.ready.marker) ?? false
      else { const bridge = await readBridge(data); ready = bridge?.pid === child.pid && await this.platform.healthy(bridge.origin) }
      if (ready) {
        await this.prune(definition, stage)
        return undefined
      }
      if (this.closed) return this.failure(definition, 'cancelled', '自动启动已取消，服务可能仍在启动')
      await delay(250)
    }
    try { this.platform.kill(child.pid) } catch { /* 进程已自行退出 */ }
    return this.failure(definition, 'timeout', '启动超时，请检查端口 ' + String(definition.port) + ' 与日志：' + errorLog)
  }

  /** 清理不再使用的运行副本与中断留下的临时目录；被占用的目录留到下次。 */
  private async prune(definition: ManagedServiceDefinition, keep: string): Promise<void> {
    const runtime = join(stateOf(definition), 'runtime')
    let names: string[]
    try { names = await readdir(runtime) } catch { return }
    for (const name of names) {
      const path = join(runtime, name)
      if (fold(path) === fold(keep) || name === 'current.json') continue
      await rm(path, { recursive: true, force: true }).catch(() => { /* 旧进程尚未完全退出时目录仍被占用 */ })
    }
  }
}
