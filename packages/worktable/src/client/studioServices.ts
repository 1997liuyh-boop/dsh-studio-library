/** 依赖本机服务的工作室：连接状态读取与一键启动（控制台弹窗与控制室状态弹窗共用）。 */

/** 单个本机服务的状态。 */
export interface StudioServiceState {
  /** 工作室标识（如 media / film / cineflow） */
  id: string
  /** 服务名称 */
  title?: string
  /** 是否已连接 */
  ready: boolean
  /** 是否配置了启动脚本，可一键启动 */
  startable: boolean
  /** 启动脚本是否正在运行 */
  starting: boolean
  /** 最近一次启动失败原因 */
  error?: string
}

/** 规整服务端返回的服务列表。 */
function parseServices(data: any): StudioServiceState[] {
  return (Array.isArray(data?.services) ? data.services : [])
    .filter((row: any) => typeof row?.id === 'string')
    .map((row: any) => ({
      id: row.id,
      title: typeof row.title === 'string' ? row.title : undefined,
      ready: row.ready === true,
      startable: row.startable === true,
      starting: row.starting === true,
      error: typeof row.error === 'string' ? row.error : undefined,
    }))
}

/** 读取全部本机服务状态。 */
export async function fetchStudioServices(signal?: AbortSignal): Promise<StudioServiceState[]> {
  const response = await fetch('/studio-projects/control/services', { cache: 'no-store', signal })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return parseServices(await response.json())
}

/**
 * 一键启动：等待启动脚本结束后返回最新服务状态。
 * @param studio - 工作室标识；不传则启动全部已配置服务。
 * @throws 启动失败时抛出带原因的错误。
 */
export async function startStudioServices(studio?: string, signal?: AbortSignal): Promise<StudioServiceState[]> {
  const response = await fetch('/studio-projects/control/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(studio ? { studio } : {}), signal,
  })
  let data: any = null
  try { data = await response.json() } catch {}
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'HTTP ' + response.status)
  const failures = Array.isArray(data?.failures) ? data.failures : []
  if (failures.length) throw new Error(failures.map((failure: any) => String(failure?.message ?? '')).filter(Boolean).join('；') || '启动失败')
  return parseServices(data)
}
