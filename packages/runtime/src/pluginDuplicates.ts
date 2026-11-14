/**
 * 启动时自动清理工作室库子插件的重复安装（详见 scripts/plugin-duplicates.mjs）。
 * 清理结果在本次运行内累积：替换过顶层目录（换成指向工作室库自带副本的联接）就说明当前加载的不是自带的版本，需要重启 DSH。
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// 纯 JS 模块（安装脚本与运行时共用），由 esbuild 打包进运行时
import { cleanDuplicates, findProfileDir } from '../../../scripts/plugin-duplicates.mjs'

/** 一处重复安装：包名、两份的版本与来源。 */
export interface DuplicateInstall {
  name: string
  bundledVersion: string
  version?: string
  /** library：插件市场里本仓库的子包条目；other：别的作者的同名包 */
  source: 'library' | 'other'
  repository?: string
  present: boolean
  declared: boolean
  selected: boolean
  linked: boolean
}

/** 控制台读取的清理报告。 */
export interface DuplicateReport {
  /** 本次运行清理过的重复安装（按包名去重） */
  cleaned: DuplicateInstall[]
  /** 清理失败的项目与原因（包名或 package.json） */
  failures: { name: string; message: string }[]
  /** 是否需要重启 DSH 才能换成工作室库自带的版本 */
  restartRequired: boolean
  /** 找不到 profile 目录时为 false，此时不做任何处理 */
  available: boolean
}

type Cleaner = (profileDir: string) => Promise<{ duplicates: DuplicateInstall[]; replaced: { name: string; backup?: string }[]; manifestChanged: boolean; failures: { name: string; message: string }[] }>

/** 运行时自身所在目录；打包后的单文件取不到时为 undefined。 */
function ownDirectory(): string | undefined {
  try { return dirname(fileURLToPath(import.meta.url)) } catch { return undefined }
}

export class DuplicateInstalls {
  private profileDir: Promise<string | undefined> | undefined
  private readonly cleaned = new Map<string, DuplicateInstall>()
  private failures: { name: string; message: string }[] = []
  private restartRequired = false
  private running: Promise<DuplicateReport> | undefined

  /**
   * @param start - 查找 profile 的起点，默认为运行时安装目录。
   * @param clean - 清理实现，测试时替换。
   */
  constructor(private readonly start: string | undefined = ownDirectory(), private readonly clean: Cleaner = cleanDuplicates as Cleaner) {}

  private locate(): Promise<string | undefined> {
    this.profileDir ??= this.start ? findProfileDir(this.start).catch(() => undefined) : Promise.resolve(undefined)
    return this.profileDir
  }

  /** 检测并清理；并发调用共用同一次执行。 */
  run(): Promise<DuplicateReport> {
    this.running ??= this.execute().finally(() => { this.running = undefined })
    return this.running
  }

  private async execute(): Promise<DuplicateReport> {
    const profileDir = await this.locate()
    if (!profileDir) return this.report(false)
    try {
      const result = await this.clean(profileDir)
      for (const item of result.duplicates) this.cleaned.set(item.name, item)
      // 原本加载的是被替换掉的那份，或登记的条目原先找不到包：都要重启才会加载工作室库自带的版本
      if (result.replaced.length) this.restartRequired = true
      this.failures = result.failures
    } catch (error) {
      this.failures = [{ name: 'profile', message: error instanceof Error ? error.message : String(error) }]
    }
    return this.report(true)
  }

  private report(available: boolean): DuplicateReport {
    return { cleaned: [...this.cleaned.values()], failures: this.failures, restartRequired: this.restartRequired, available }
  }
}
