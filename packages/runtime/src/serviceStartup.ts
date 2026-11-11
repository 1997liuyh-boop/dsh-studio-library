/** 工作室启动脚本由本机配置指定；服务及数据库仍由原启动器管理。 */
import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'

/** 每组脚本独立启动；路径、等待预算和日志位置均由配置提供。 */
export interface ServiceStartupConfig {
  label: string
  studioIds: string[]
  command: string
  args: string[]
  cwd: string
  logFile: string
  timeoutMs: number
  /** 停止服务的参数；缺省时 PowerShell -File 脚本自动追加 -Stop（现有启动脚本均支持） */
  stopArgs?: string[]
}

/** 启动失败不撤销已经运行的服务；工作室可继续检查真实健康状态。 */
export interface ServiceStartupFailure {
  kind: 'launch' | 'exit' | 'timeout' | 'cancelled'
  studioIds: string[]
  message: string
  process?: { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean }
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

/**
 * 校验本机配置；未设置表示不启动任何服务。
 * @param input - 插件配置中的启动组列表。
 * @returns 可直接交给子进程执行的配置，错误配置在加载时抛出。
 */
export function resolveServiceStartup(input: unknown): ServiceStartupConfig[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw new Error('工作室自动启动配置必须是列表')
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !('label' in entry) || typeof entry.label !== 'string' || !entry.label.trim()
      || !('studioIds' in entry) || !strings(entry.studioIds) || !entry.studioIds.length
      || !entry.studioIds.every(id => /^[a-z][a-z0-9-]*$/.test(id))
      || !('command' in entry) || typeof entry.command !== 'string' || !isAbsolute(entry.command)
      || !('args' in entry) || !strings(entry.args)
      || !('cwd' in entry) || typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd)
      || !('logFile' in entry) || typeof entry.logFile !== 'string' || !isAbsolute(entry.logFile)
      || !('timeoutMs' in entry) || typeof entry.timeoutMs !== 'number'
      || !Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0) {
      throw new Error('工作室自动启动配置无效：需要名称、工作室标识、绝对路径、字符串参数和正整数超时')
    }
    if ('stopArgs' in entry && entry.stopArgs !== undefined && !strings(entry.stopArgs)) {
      throw new Error('工作室自动启动配置无效：stopArgs 必须是字符串列表')
    }
    return { label: entry.label, studioIds: [...entry.studioIds], command: entry.command,
      args: [...entry.args], cwd: entry.cwd, logFile: entry.logFile, timeoutMs: entry.timeoutMs,
      ...('stopArgs' in entry && strings(entry.stopArgs) ? { stopArgs: [...entry.stopArgs] } : {}) }
  })
}

/**
 * 停止服务所用的参数：优先配置的 stopArgs；PowerShell -File 脚本缺省追加 -Stop；其余无法停止返回 undefined。
 * @param config - 启动组。
 */
export function stopArgsOf(config: ServiceStartupConfig): string[] | undefined {
  if (config.stopArgs) return config.stopArgs
  const shell = basename(config.command).toLowerCase()
  if ((shell === 'pwsh.exe' || shell === 'pwsh' || shell === 'powershell.exe') && config.args.some(arg => arg.toLowerCase() === '-file')) return [...config.args, '-Stop']
  return undefined
}

/** 路径是否位于目录内（Windows 下不区分大小写）。 */
export function isInside(path: string, directory: string): boolean {
  const norm = (value: string) => { const full = resolve(value); return process.platform === 'win32' ? full.toLowerCase() : full }
  const target = norm(path)
  const root = norm(directory)
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function startService(config: ServiceStartupConfig, signal: AbortSignal): Promise<ServiceStartupFailure | undefined> {
  return runService(config, config.args, '启动', signal)
}

/** 执行启动组的停止参数；与启动共用日志、超时和失败报告。 */
async function stopService(config: ServiceStartupConfig, signal: AbortSignal): Promise<ServiceStartupFailure | undefined> {
  const args = stopArgsOf(config)
  if (!args) return { kind: 'launch', studioIds: config.studioIds, message: config.label + '没有可用的停止命令，请手动关闭后再更新' }
  return runService(config, args, '停止', signal)
}

async function runService(config: ServiceStartupConfig, args: readonly string[], verb: '启动' | '停止', signal: AbortSignal): Promise<ServiceStartupFailure | undefined> {
  const failure = (kind: ServiceStartupFailure['kind'], reason: string): ServiceStartupFailure => ({
    kind, studioIds: config.studioIds,
    message: config.label + reason + '，请查看日志后重新启动应用：' + config.logFile,
  })
  if (signal.aborted) return failure('cancelled', '自动'+verb+'已取消，部分服务可能已运行')
  try {
    await mkdir(dirname(config.logFile), { recursive: true })
    const log = await open(config.logFile, 'a', 0o600)
    try {
      if (signal.aborted) return failure('cancelled', '自动'+verb+'已取消，部分服务可能已运行')
      await log.write('\n[' + new Date().toISOString() + '] ' + config.label + '自动' + verb + '\n')
      const child = spawn(config.command, [...args], {
        cwd: config.cwd, windowsHide: true, signal, killSignal: 'SIGKILL', stdio: ['ignore', log.fd, log.fd],
      })
      let timedOut = false
      let launchError: Error | undefined
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, config.timeoutMs)
      const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(done => {
        child.once('error', error => { launchError = error })
        child.once('close', (exitCode, signal) => { clearTimeout(timeout); done({ exitCode, signal }) })
      })
      const report = (kind: ServiceStartupFailure['kind'], reason: string) => ({
        ...failure(kind, reason), process: { ...outcome, timedOut },
      })
      if (signal.aborted) return report('cancelled', '自动'+verb+'已取消，部分服务可能已运行')
      if (timedOut) return report('timeout', '自动'+verb+'超时，部分服务可能已运行')
      if (launchError) return report('launch', '无法自动'+verb+'（' + launchError.message + '）')
      if (outcome.exitCode !== 0) return report('exit', '自动'+verb+'失败（退出码 ' + String(outcome.exitCode) + '）')
      return undefined
    } finally { await log.close() }
  } catch (error) {
    return failure('launch', '无法自动'+verb+'（' + (error instanceof Error ? error.message : String(error)) + '）')
  }
}

/**
 * 并行执行互不依赖的启动组，单组失败保留其他组的结果。
 * @param configs - 已校验的本机启动组；脚本必须可安全重复执行。
 * @param signal - 停用插件时取消协调脚本，不主动停止独立服务。
 * @returns 全部协调进程关闭后的失败报告；服务是否可用仍以健康检查为准。
 */
export async function startStudioServices(configs: readonly ServiceStartupConfig[], signal: AbortSignal): Promise<ServiceStartupFailure[]> {
  const outcomes = await Promise.all(configs.map(config => startService(config, signal)))
  return outcomes.filter((outcome): outcome is ServiceStartupFailure => outcome !== undefined)
}

/**
 * 并行停止多个启动组（执行各自的停止命令）。
 * @param configs - 需要停止的启动组。
 * @param signal - 停用插件时取消。
 * @returns 停止失败的报告。
 */
export async function stopStudioServices(configs: readonly ServiceStartupConfig[], signal: AbortSignal): Promise<ServiceStartupFailure[]> {
  const outcomes = await Promise.all(configs.map(config => stopService(config, signal)))
  return outcomes.filter((outcome): outcome is ServiceStartupFailure => outcome !== undefined)
}

/** 未配置启动脚本的工作室请求一键启动时抛出。 */
export class ServiceNotConfigured extends Error {
  constructor(studioId: string) { super('工作室 ' + studioId + ' 未配置启动脚本，请在 dsh-studio-projects 插件配置中填写 autoStartServices') }
}

/**
 * 工作室服务启动器：宿主启动时与「一键启动」共用；同一启动组运行中不会重复拉起。
 * 失败记录按启动组覆盖，便于界面展示最近一次结果。
 */
export class StudioServiceLauncher {
  private readonly abort = new AbortController()
  private readonly running = new Map<string, Promise<ServiceStartupFailure[]>>()
  private failures: ServiceStartupFailure[] = []

  /**
   * @param configs - 已校验的启动组。
   * @param run - 实际执行启动组的函数，测试时可替换。
   */
  constructor(private readonly configs: readonly ServiceStartupConfig[],
    private readonly run: (configs: readonly ServiceStartupConfig[], signal: AbortSignal) => Promise<ServiceStartupFailure[]> = startStudioServices,
    private readonly stopRun: (configs: readonly ServiceStartupConfig[], signal: AbortSignal) => Promise<ServiceStartupFailure[]> = stopStudioServices) {}

  /**
   * 在安装目录内运行的启动组：命令、脚本参数或工作目录位于该目录中。
   * 这类服务运行时会占用安装目录，Windows 上 pnpm 无法替换，更新前必须先停止。
   */
  groupsInside(studioId: string, directory: string): ServiceStartupConfig[] {
    return this.configs.filter(config => config.studioIds.includes(studioId)
      && (isInside(config.cwd, directory) || isInside(config.command, directory)
        || config.args.some(arg => isAbsolute(arg) && isInside(arg, directory))))
  }

  /**
   * 更新前停止占用安装目录的服务；正在进行的启动先等它结束，避免与停止交错。
   * @returns 已停止的启动组（供更新后重启）与停止失败的报告。
   */
  async stopForUpdate(studioId: string, directory: string): Promise<{ stopped: ServiceStartupConfig[]; failures: ServiceStartupFailure[] }> {
    const groups = this.groupsInside(studioId, directory)
    if (!groups.length) return { stopped: [], failures: [] }
    await Promise.allSettled(groups.map(config => this.running.get(config.label)).filter(task => task !== undefined))
    const failures = await this.stopRun(groups, this.abort.signal)
    return { stopped: groups, failures }
  }

  /** 更新后重新启动之前停止的启动组。 */
  restart(groups: readonly ServiceStartupConfig[]): Promise<ServiceStartupFailure[]> {
    return this.startGroups(groups)
  }

  /** 该工作室是否配置了启动脚本。 */
  startable(studioId: string): boolean {
    return this.configs.some(config => config.studioIds.includes(studioId))
  }

  /** 该工作室的启动组是否正在运行。 */
  starting(studioId: string): boolean {
    return this.configs.some(config => config.studioIds.includes(studioId) && this.running.has(config.label))
  }

  /** 最近一次启动失败记录。 */
  report(): ServiceStartupFailure[] {
    return [...this.failures]
  }

  /**
   * 启动指定工作室所在的启动组；不传则启动全部。
   * @param studioId - 工作室标识。
   * @returns 本次涉及启动组的失败记录。
   */
  async start(studioId?: string): Promise<ServiceStartupFailure[]> {
    const groups = this.configs.filter(config => !studioId || config.studioIds.includes(studioId))
    if (studioId && !groups.length) throw new ServiceNotConfigured(studioId)
    return this.startGroups(groups)
  }

  /** 启动指定启动组：同组运行中复用任务，失败记录按启动组覆盖。 */
  private async startGroups(groups: readonly ServiceStartupConfig[]): Promise<ServiceStartupFailure[]> {
    const results = await Promise.all(groups.map(config => {
      let task = this.running.get(config.label)
      if (!task) {
        task = this.run([config], this.abort.signal).finally(() => this.running.delete(config.label))
        this.running.set(config.label, task)
      }
      return task
    }))
    const touched = new Set(groups.flatMap(config => config.studioIds))
    const latest = results.flat()
    this.failures = [...this.failures.filter(failure => !failure.studioIds.some(id => touched.has(id))), ...latest]
    return latest
  }

  /** 停用插件时取消协调脚本（不主动停止已运行的服务），并等待收尾。 */
  async dispose(): Promise<void> {
    this.abort.abort()
    await Promise.allSettled(this.running.values())
  }
}
