// 工作室版本信息共享存储：本地版本、仓库地址、GitHub Release 版本与更新状态，控制室卡片与工作室状态弹窗共用
import { useEffect, useState } from 'react'

/** 单个工作室的版本与更新信息。 */
export interface StudioReleaseInfo {
  /** 本地安装的版本 */
  version?: string
  /** 来源：github = 从 GitHub 安装；local = 本机目录 */
  source?: 'github' | 'local'
  /** GitHub 仓库地址或本机目录 */
  address?: string
  /** 检查状态：idle / available / latest / unpublished / incompatible / unconfigured / failed */
  state?: string
  /** 检查失败的原因代码（rate-limit / network / metadata / size），仅 state 为 failed 时有 */
  error?: string
  /** GitHub Release 上更新的版本（有新版本时才有） */
  latest?: string
  /** 是否可一键更新 */
  hasUpdate: boolean
  /** 最近一次更新的阶段（downloading / restart-required / complete / failed …） */
  phase?: string
}

/** 存储快照。 */
export interface StudioInfoSnapshot {
  info: Record<string, StudioReleaseInfo>
  /** 正在更新的工作室标识 */
  upgrading: string | null
  /** 最近一次更新失败的原因 */
  error: string
}

let snapshot: StudioInfoSnapshot = { info: {}, upgrading: null, error: '' }
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null

function publish(next: Partial<StudioInfoSnapshot>) {
  snapshot = { ...snapshot, ...next }
  listeners.forEach(listener => { try { listener() } catch {} })
}

function mergeInfo(patch: Record<string, Partial<StudioReleaseInfo>>) {
  const info = { ...snapshot.info }
  for (const [id, value] of Object.entries(patch)) info[id] = { hasUpdate: false, ...info[id], ...value }
  publish({ info })
}

/** 侧栏 / 控制室卡片标识（studio-film）→ 工作室标识（film）。 */
export function studioIdOf(cardId: string): string {
  return cardId.startsWith('studio-') ? cardId.slice('studio-'.length) : cardId
}

/** 失败的检查过这么久才重试：避开刚触发的限流或超时。 */
export const CHECK_RETRY_MS = 60 * 1000
/** 成功的检查结果保留这么久：GitHub 未登录接口每小时 60 次，每个工作室一次检查占一次。 */
export const CHECK_STALE_MS = 15 * 60 * 1000

/**
 * 这一行现在是否该向 GitHub 重新检查。
 * 运行时把检查结果留在内存里直到 DSH 退出：只查「从未检查过」的话，一次超时会让这个工作室整个会话都不再提示更新，
 * 之后发布的新版本也看不到。所以失败的过一分钟重试，其余结果过期后重查；force 为真时（用户点「检查更新」）全部重查。
 * @param row 更新报告里的一行。
 * @param now 当前时间戳（毫秒）。
 */
export function dueForCheck(row: any, now: number, force = false): boolean {
  if (typeof row?.id !== 'string' || row.state === 'unconfigured') return false
  if (force || row.state === 'idle') return true
  const checkedAt = typeof row.checkedAt === 'string' ? Date.parse(row.checkedAt) : Number.NaN
  // 没有检查时间就无从判断是否过期：失败的重试，其余保持原样
  if (Number.isNaN(checkedAt)) return row.state === 'failed'
  return now - checkedAt >= (row.state === 'failed' ? CHECK_RETRY_MS : CHECK_STALE_MS)
}

/**
 * 逐个工作室发起检查，各自完成后把自己那一行交给 apply。并行发出：每个检查最长 15 秒，排队的话后面的工作室要等很久。
 * 每个响应都带整张报告，但只取被检查的那一行，先发后到的响应不会把别的行盖回旧状态。
 * @returns 实际发起检查的工作室标识。
 */
export async function checkStudios(ids: readonly string[], apply: (report: any, id: string) => void, signal?: AbortSignal): Promise<void> {
  await Promise.all(ids.map(async id => {
    const checked = await fetch('/studio-projects/updates/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }), signal }).catch(() => null)
    if (!checked?.ok || signal?.aborted) return
    const report = await checked.json().catch(() => null)
    const row = (Array.isArray(report?.studios) ? report.studios : []).find((item: any) => item?.id === id)
    if (row) apply({ studios: [row] }, id)
  }))
}

/** 更新报告 → 信息补丁，并列出现在该检查的工作室（从未检查、上次失败或结果过期；force 为真时全部）。 */
export function readUpdateReport(report: any, now = Date.now(), force = false): { patch: Record<string, Partial<StudioReleaseInfo>>; idle: string[] } {
  const patch: Record<string, Partial<StudioReleaseInfo>> = {}
  const idle: string[] = []
  for (const row of Array.isArray(report?.studios) ? report.studios : []) {
    if (typeof row?.id !== 'string') continue
    patch[row.id] = {
      hasUpdate: row.state === 'available',
      ...(typeof row.state === 'string' ? { state: row.state } : {}),
      ...(typeof row.version === 'string' ? { version: row.version } : {}),
      latest: typeof row.latest === 'string' ? row.latest : undefined,
      error: row.state === 'failed' && typeof row.error === 'string' ? row.error : undefined,
      phase: typeof row.operation?.phase === 'string' ? row.operation.phase : undefined,
    }
    if (dueForCheck(row, now, force)) idle.push(row.id)
  }
  return { patch, idle }
}

/** 目录接口 → 版本与地址补丁。 */
function readCatalog(data: any): Record<string, Partial<StudioReleaseInfo>> {
  const patch: Record<string, Partial<StudioReleaseInfo>> = {}
  for (const row of Array.isArray(data?.studios) ? data.studios : []) {
    if (typeof row?.id !== 'string') continue
    patch[row.id] = {
      ...(typeof row.version === 'string' ? { version: row.version } : {}),
      source: row.source === 'github' ? 'github' : 'local',
      ...(typeof row.address === 'string' ? { address: row.address } : {}),
    }
  }
  return patch
}

/**
 * 读取版本与地址，再读取更新状态；从未检查、上次失败或结果过期的工作室向 GitHub Release 重新检查。
 * 并发调用复用同一次加载。
 */
export function refreshStudioInfo(): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    try {
      const catalog = await fetch('/studio-projects/control/studios', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
      if (catalog) mergeInfo(readCatalog(catalog))
      const report = await fetch('/studio-projects/updates', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
      if (!report) return
      const first = readUpdateReport(report)
      mergeInfo(first.patch)
      await checkStudios(first.idle, row => mergeInfo(readUpdateReport(row).patch))
    } finally { loading = null }
  })()
  return loading
}

/** 一键更新到已检查出的版本：下载、校验后交给宿主安装。 */
export async function upgradeStudio(id: string, version: string): Promise<void> {
  if (snapshot.upgrading) return
  publish({ upgrading: id, error: '' })
  try {
    const response = await fetch('/studio-projects/updates/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, version }) })
    let data: any = null
    try { data = await response.json() } catch {}
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'HTTP ' + response.status)
    mergeInfo(readUpdateReport(data).patch)
  } catch (error) {
    publish({ error: error instanceof Error ? error.message : String(error) })
  } finally { publish({ upgrading: null }) }
}

/** 订阅存储变化。 */
export function subscribeStudioInfo(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 读取当前快照。 */
export function getStudioInfo(): StudioInfoSnapshot {
  return snapshot
}

/** React 钩子：挂载时触发一次加载，并随存储更新重新渲染。 */
export function useStudioInfo(): StudioInfoSnapshot {
  const [current, setCurrent] = useState(snapshot)
  useEffect(() => {
    const unsubscribe = subscribeStudioInfo(() => setCurrent(snapshot))
    setCurrent(snapshot)
    void refreshStudioInfo()
    return unsubscribe
  }, [])
  return current
}

/** 版本状态的展示类别：available = 有更新；latest = 已是最新；其余为说明文字。 */
export function releaseLabelKind(item?: StudioReleaseInfo): 'available' | 'latest' | 'checking' | 'restart' | 'other' | 'none' {
  if (!item) return 'none'
  if (item.phase === 'restart-required') return 'restart'
  if (item.hasUpdate && item.latest) return 'available'
  if (item.state === 'latest') return 'latest'
  if (!item.state || item.state === 'idle') return 'checking'
  return 'other'
}
