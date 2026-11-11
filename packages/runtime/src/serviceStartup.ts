/** 工作室启动脚本由本机配置指定；服务及数据库仍由原启动器管理。 */
import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

/** 每组脚本独立启动；路径、等待预算和日志位置均由配置提供。 */
export interface ServiceStartupConfig {
  label: string
  studioIds: string[]
  command: string
  args: string[]
  cwd: string
  logFile: string
  timeoutMs: number
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
    return { label: entry.label, studioIds: [...entry.studioIds], command: entry.command,
      args: [...entry.args], cwd: entry.cwd, logFile: entry.logFile, timeoutMs: entry.timeoutMs }
  })
}

async function startService(config: ServiceStartupConfig, signal: AbortSignal): Promise<ServiceStartupFailure | undefined> {
  const failure = (kind: ServiceStartupFailure['kind'], reason: string): ServiceStartupFailure => ({
    kind, studioIds: config.studioIds,
    message: config.label + reason + '，请查看日志后重新启动应用：' + config.logFile,
  })
  if (signal.aborted) return failure('cancelled', '自动启动已取消，部分服务可能已运行')
  try {
    await mkdir(dirname(config.logFile), { recursive: true })
    const log = await open(config.logFile, 'a', 0o600)
    try {
      if (signal.aborted) return failure('cancelled', '自动启动已取消，部分服务可能已运行')
      await log.write('\n[' + new Date().toISOString() + '] ' + config.label + '自动启动\n')
      const child = spawn(config.command, config.args, {
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
      if (signal.aborted) return report('cancelled', '自动启动已取消，部分服务可能已运行')
      if (timedOut) return report('timeout', '自动启动超时，部分服务可能已运行')
      if (launchError) return report('launch', '无法自动启动（' + launchError.message + '）')
      if (outcome.exitCode !== 0) return report('exit', '自动启动失败（退出码 ' + String(outcome.exitCode) + '）')
      return undefined
    } finally { await log.close() }
  } catch (error) {
    return failure('launch', '无法自动启动（' + (error instanceof Error ? error.message : String(error)) + '）')
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
    private readonly run: (configs: readonly ServiceStartupConfig[], signal: AbortSignal) => Promise<ServiceStartupFailure[]> = startStudioServices) {}

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
