/** 子插件重复安装的清理报告（运行时启动时自动清理，控制台只负责展示与重试）。 */

/** 一处重复安装 */
export interface DuplicateInstall {
  /** 包名，如 dsh-worktable */
  name: string
  /** 工作室库自带的版本 */
  bundledVersion: string
  /** 被挪走的那份的版本；只清理了依赖声明时缺省 */
  version?: string
  /** library：插件市场里本仓库的子包条目；other：别的作者的同名包 */
  source: 'library' | 'other'
  /** 被挪走的那份声明的仓库地址或依赖来源 */
  repository?: string
}

/** 清理报告 */
export interface DuplicateReport {
  /** 本次运行清理过的重复安装 */
  cleaned: DuplicateInstall[]
  /** 清理失败的项目与原因 */
  failures: { name: string; message: string }[]
  /** 是否需要重启 DSH 才能换成工作室库自带的版本 */
  restartRequired: boolean
}

/** 把接口返回的任意值收窄成报告；格式不对（旧版运行时没有这个接口）时返回 null。 */
export function readDuplicateReport(value: unknown): DuplicateReport | null {
  const data = value as Partial<DuplicateReport> | null
  if (!data || !Array.isArray(data.cleaned) || !Array.isArray(data.failures)) return null
  const cleaned = data.cleaned.filter((item): item is DuplicateInstall => typeof item?.name === 'string' && typeof item?.bundledVersion === 'string')
  const failures = data.failures.filter((item): item is { name: string; message: string } => typeof item?.name === 'string' && typeof item?.message === 'string')
  return { cleaned, failures, restartRequired: data.restartRequired === true }
}

/**
 * 读取清理报告；retry 为真时请求运行时重新清理（上次目录被占用没挪走时用）。
 * 旧版运行时没有这个接口，返回 null。
 */
export async function fetchDuplicateReport(signal?: AbortSignal, retry = false): Promise<DuplicateReport | null> {
  const response = await fetch('/studio-projects/control/duplicates', retry
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal }
    : { cache: 'no-store', signal })
  if (!response.ok) return null
  return readDuplicateReport(await response.json())
}
