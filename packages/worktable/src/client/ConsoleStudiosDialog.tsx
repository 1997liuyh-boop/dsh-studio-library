import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { WorktableKey } from './locales'
import { fetchStudioServices, startStudioServices, type StudioServiceState } from './studioServices'
import { checkStudios, dueForCheck } from './studioInfo'

type Translate = (key: WorktableKey, params?: Record<string, string>) => string

/** 空状态插图（体积较大，按地址加载而不打包进插件）。 */
export const CONSOLE_EMPTY_IMAGE = 'https://img.aigengtu.com/meme/2279.gif'

/** 控制台列表中的一个子工作室。 */
export interface ConsoleStudioItem {
  /** 侧栏项目标识（如 studio-film），用于排序回写 */
  id: string
  /** 工作室标识（如 film），用于读取版本与地址 */
  studioId: string
  /** 显示名称 */
  name: string
  /** 图标（emoji） */
  icon?: string
}

/** 单个工作室的版本、地址与更新状态。 */
interface StudioInfo {
  version?: string
  source?: 'github' | 'local'
  address?: string
  hasUpdate?: boolean
  /** 可升级到的版本 */
  latest?: string
  /** 更新检查状态（available / latest / failed …） */
  state?: string
  /** 检查失败的原因代码（rate-limit / network / metadata / size） */
  error?: string
  /** 卸载结果：removed 已卸载；restart-required 已卸载、重启后生效；pending-restart 已停用、下次启动时完成卸载 */
  removal?: 'removed' | 'restart-required' | 'pending-restart'
  /** 最近一次升级的阶段（downloading / restart-required / failed …） */
  phase?: string
  /** 最近一次升级失败的原因代码（operation / service-stop / metadata / recheck …） */
  phaseError?: string
}

/** 工作室库主插件在更新列表中的标识（与运行时一致）。 */
const LIBRARY_ID = 'library'

type InfoTable = Record<string, StudioInfo>

/** 合并一张信息表到现有表。 */
function merge(base: InfoTable, patch: InfoTable): InfoTable {
  const next: InfoTable = { ...base }
  for (const [id, info] of Object.entries(patch)) next[id] = { ...next[id], ...info }
  return next
}

/** 读取版本号与来源地址（逐个工作室容错）。 */
async function loadCatalog(signal: AbortSignal): Promise<InfoTable> {
  const response = await fetch('/studio-projects/control/studios', { cache: 'no-store', signal })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const data = await response.json()
  const table: InfoTable = {}
  for (const row of Array.isArray(data?.studios) ? data.studios : []) {
    if (typeof row?.id !== 'string') continue
    table[row.id] = {
      version: typeof row.version === 'string' ? row.version : undefined,
      source: row.source === 'github' ? 'github' : 'local',
      address: typeof row.address === 'string' ? row.address : undefined,
      // 上次点了卸载、还在等重启的工作室：重新打开弹窗时继续显示这个状态
      ...(row.pendingRemoval === true ? { removal: 'pending-restart' as const } : {}),
    }
  }
  return table
}

/** 更新报告 → 有更新标记表；同时返回现在该检查的工作室（从未检查、上次失败或结果过期；force 为真时全部）。 */
function readUpdates(report: any, force = false): { table: InfoTable; idle: string[] } {
  const table: InfoTable = {}
  const idle: string[] = []
  const now = Date.now()
  for (const row of Array.isArray(report?.studios) ? report.studios : []) {
    if (typeof row?.id !== 'string') continue
    table[row.id] = { hasUpdate: row.state === 'available', ...(typeof row.version === 'string' ? { version: row.version } : {}),
      ...(typeof row.state === 'string' ? { state: row.state } : {}), error: row.state === 'failed' && typeof row.error === 'string' ? row.error : undefined,
      ...(typeof row.latest === 'string' ? { latest: row.latest } : {}), ...(typeof row.operation?.phase === 'string' ? { phase: row.operation.phase } : {}),
      ...(typeof row.operation?.error === 'string' ? { phaseError: row.operation.error } : {}) }
    if (dueForCheck(row, now, force)) idle.push(row.id)
  }
  return { table, idle }
}

/** 把 from 位置的元素移到 to 位置，返回新数组。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** 拖拽抓手图标：六点竖排，表示可拖动排序。 */
const ICON_GRIP = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="6" cy="3.5" r="1.1" /><circle cx="10" cy="3.5" r="1.1" />
    <circle cx="6" cy="8" r="1.1" /><circle cx="10" cy="8" r="1.1" />
    <circle cx="6" cy="12.5" r="1.1" /><circle cx="10" cy="12.5" r="1.1" />
  </svg>
)

/** 交给 AI 修改源码时传出的本地工作室信息。 */
export interface EditableStudio {
  id: string
  name: string
  icon?: string
  source: 'local'
  localPath: string
}

/** 卸载图标：垃圾桶。 */
const ICON_REMOVE = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v3.8M9.2 7v3.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 编辑图标：铅笔。 */
const ICON_EDIT = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M10.7 2.1a1.5 1.5 0 0 1 2.1 2.1L6 11l-3.1.7.7-3.1z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    <path d="m9.7 3.1 2.1 2.1" fill="none" stroke="currentColor" strokeWidth="1.25" />
  </svg>
)

/** 控制台弹窗：列出全部子工作室（名称 / 地址 / 版本 / 有更新标记），按住右侧抓手拖拽排序。 */
export function ConsoleStudiosDialog({ open, t, studios, onClose, onReorder, onEnterConsole, onEditStudio }: {
  /** 是否显示弹窗 */
  open: boolean
  /** 文案翻译函数 */
  t: Translate
  /** 当前排序下的子工作室列表 */
  studios: ConsoleStudioItem[]
  /** 关闭弹窗 */
  onClose: () => void
  /** 拖拽结束后提交新顺序（侧栏项目 id 列表） */
  onReorder: (ids: string[]) => void
  /** 进入控制室（弹窗关闭后执行）；不传则不显示入口 */
  onEnterConsole?: () => void
  /** 让 AI 修改本地工作室（打开独立会话）；不传则不显示编辑按钮 */
  onEditStudio?: (studio: EditableStudio) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const titleId = useId()
  const [order, setOrder] = useState<ConsoleStudioItem[]>(studios)
  const [info, setInfo] = useState<InfoTable>({})
  const [loadError, setLoadError] = useState(false)
  /** 正在向 GitHub 检查更新的工作室标识 */
  const [checking, setChecking] = useState<string[]>([])
  /** 本次打开弹窗的取消信号，「检查更新」按钮复用它，关闭弹窗即中止 */
  const checkSignal = useRef<AbortSignal | null>(null)
  /** 依赖本机服务的工作室状态（按工作室标识） */
  const [services, setServices] = useState<Record<string, StudioServiceState>>({})
  /** 正在一键启动的目标：工作室标识，或 '*' 表示全部 */
  const [startBusy, setStartBusy] = useState<string | null>(null)
  const [startError, setStartError] = useState('')
  const [editError, setEditError] = useState('')
  /** 等待在行内确认卸载的工作室标识 */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  /** 正在卸载的工作室标识 */
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const dragging = useRef<{ id: string; pointerId: number } | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order

  // 以外部顺序为准；拖拽过程中不被外部刷新打断
  useEffect(() => { if (!dragging.current) setOrder(studios) }, [studios])

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])

  /**
   * 读取更新状态，并向 GitHub 检查该查的工作室：从未检查、上次失败或结果过期的；force 为真时（点「检查更新」）全部重查。
   * 检查期间逐行显示「检查中…」，失败的行显示「检查失败」与原因。
   */
  const checkUpdates = async (signal: AbortSignal, force = false) => {
    try {
      const response = await fetch('/studio-projects/updates', { cache: 'no-store', signal })
      if (!response.ok) return
      const first = readUpdates(await response.json(), force)
      setInfo(current => merge(current, first.table))
      if (!first.idle.length) return
      setChecking(first.idle)
      await checkStudios(first.idle, (row, id) => {
        setInfo(current => merge(current, readUpdates(row).table))
        setChecking(current => current.filter(item => item !== id))
      }, signal)
    } catch { /* 更新检查失败不影响版本与排序 */ }
    finally { if (!signal.aborted) setChecking([]) }
  }

  // 打开时读取版本与地址；随后读取更新状态并检查更新
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const { signal } = controller
    checkSignal.current = signal
    setLoadError(false)
    loadCatalog(signal).then(table => setInfo(current => merge(current, table))).catch(() => { if (!signal.aborted) setLoadError(true) })
    void checkUpdates(signal)
    return () => { controller.abort(); setChecking([]) }
  }, [open])

  const applyServices = (list: StudioServiceState[]) => setServices(Object.fromEntries(list.map(item => [item.id, item])))

  // 打开时读取本机服务状态
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setStartError('')
    fetchStudioServices(controller.signal).then(applyServices).catch(() => {})
    return () => controller.abort()
  }, [open])

  /** 一键启动：studio 为空时启动全部；结束后刷新状态。 */
  const startService = async (studio?: string) => {
    if (startBusy) return
    setStartBusy(studio ?? '*')
    setStartError('')
    try { applyServices(await startStudioServices(studio)) }
    catch (error) { setStartError(t('consoleList.startFail', { reason: error instanceof Error ? error.message : String(error) })) }
    finally {
      setStartBusy(null)
      fetchStudioServices().then(applyServices).catch(() => {})
    }
  }
  const offline = Object.values(services).filter(item => !item.ready && item.startable)

  /** 正在升级的工作室标识 */
  const [upgrading, setUpgrading] = useState<string | null>(null)
  const [upgradeError, setUpgradeError] = useState('')
  /** 升级到已检查出的版本：下载、校验后交给宿主安装；结果按阶段显示 */
  const upgrade = async (id: string, version: string) => {
    if (upgrading) return
    setUpgrading(id)
    setUpgradeError('')
    try {
      const response = await fetch('/studio-projects/updates/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, version }) })
      let data: any = null
      try { data = await response.json() } catch {}
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'HTTP ' + response.status)
      setInfo(current => merge(current, readUpdates(data).table))
    } catch (error) {
      setUpgradeError(t('consoleList.upgradeFail', { reason: error instanceof Error ? error.message : String(error) }))
    } finally { setUpgrading(null) }
  }
  /** 升级阶段 → 提示文字；无升级记录返回空串 */
  const phaseText = (phase?: string) => !phase ? ''
    : phase === 'restart-required' ? t('consoleList.upgradeRestart')
    : phase === 'complete' ? t('consoleList.upgradeDone')
    : phase === 'failed' || phase === 'unknown' ? t('consoleList.upgradeFailed')
    : t('consoleList.upgrading')
  /**
   * 卸载子工作室：正在运行的工作室不能当场移除，服务端会先停用它并在下次启动 DSH 时完成移除，
   * 这里按返回的状态在该行说明现在处于哪一步。
   */
  const uninstall = async (id: string) => {
    if (removing) return
    setRemoving(id)
    setRemoveError('')
    setConfirmRemove(null)
    try {
      const response = await fetch('/studio-projects/control/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      let data: any = null
      try { data = await response.json() } catch {}
      // 服务端还是没有卸载接口的旧版本：页面已经换成新版，但 DSH 没有完整重启（或工作室库升级没有完成）
      if (response.status === 404 || (response.status === 400 && data?.error === '客户端标识无效')) throw new Error(t('consoleList.uninstallStale'))
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'HTTP ' + response.status)
      const removal = data?.state === 'pending-restart' || data?.state === 'restart-required' ? data.state : 'removed'
      setInfo(current => merge(current, { [id]: { removal, hasUpdate: false } }))
    } catch (error) {
      setRemoveError(t('consoleList.uninstallFail', { reason: error instanceof Error ? error.message : String(error) }))
    } finally { setRemoving(null) }
  }
  /** 只检查这一个工作室（上次升级没完成的行用），结果出来后有新版本就显示「升级」。 */
  const recheck = (id: string) => {
    const signal = checkSignal.current
    if (!signal || signal.aborted || checking.includes(id)) return
    setChecking(current => [...current, id])
    void checkStudios([id], (row, done) => {
      setInfo(current => merge(current, readUpdates(row).table))
      setChecking(current => current.filter(item => item !== done))
    }, signal).catch(() => { setChecking(current => current.filter(item => item !== id)) })
  }
  /** 升级失败的原因代码 → 说明文字。 */
  const upgradeReason = (code?: string) => t(code === 'service-stop' ? 'consoleList.upgradeReasonService' : code === 'metadata' || code === 'version-mismatch' ? 'consoleList.upgradeReasonPackage' : code === 'recheck' ? 'consoleList.upgradeReasonRecheck' : 'consoleList.upgradeReasonInterrupted')
  /** 卸载状态 → 说明文字。 */
  const removalText = (state?: string) => state === 'pending-restart' ? t('consoleList.uninstallPending')
    : state === 'restart-required' ? t('consoleList.uninstallRestart')
    : state === 'removed' ? t('consoleList.uninstallRemoved') : ''
  /** 检查失败的原因代码 → 说明文字。 */
  const checkReason = (code?: string) => t(code === 'rate-limit' ? 'consoleList.checkReasonRateLimit' : code === 'network' || code === 'closed' ? 'consoleList.checkReasonNetwork' : 'consoleList.checkReasonMetadata')
  /** 「升级」按钮、检查进度或升级进度 */
  const upgradeControl = (id: string, entry?: StudioInfo) => {
    if (upgrading === id) return <span data-upgrading className="studio:shrink-0 studio:text-xs studio:text-(--dsw-alias-label-secondary)">{t('consoleList.upgrading')}</span>
    const done = phaseText(entry?.phase)
    if (checking.includes(id)) return <span data-checking={id} className="studio:shrink-0 studio:text-xs studio:text-(--dsw-alias-label-secondary)">{t('consoleList.checking')}</span>
    if (entry?.hasUpdate && entry.latest) return (
      <button type="button" data-upgrade={id} disabled={!!upgrading} onClick={() => void upgrade(id, entry.latest!)} title={t('consoleList.upgradeTo', { version: entry.latest })}
        className="studio:shrink-0 studio:rounded-(--dsw-radius-sm) studio:border-0 studio:bg-blue-600 studio:px-2 studio:text-xs studio:leading-5 studio:text-white studio:cursor-pointer studio:hover:bg-blue-500 studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">
        {t('consoleList.upgrade')}
      </button>
    )
    // 检查失败要让人看得见：否则「没有更新」与「没查成」在界面上一模一样
    if (entry?.state === 'failed') return <span data-check-failed={id} title={checkReason(entry.error)} className="studio:shrink-0 studio:text-xs studio:text-red-500">{t('consoleList.checkFailed')}</span>
    // 上次升级没完成：说明原因，并允许只检查这一个工作室；查到新版本后上面会换成「升级」按钮
    if (entry?.phase === 'failed' || entry?.phase === 'unknown') return (
      <span className="studio:flex studio:shrink-0 studio:items-center studio:gap-1">
        <span data-upgrade-phase={entry.phase} title={upgradeReason(entry.phaseError)} className="studio:text-xs studio:text-amber-600">{done}</span>
        <button type="button" data-recheck={id} onClick={() => recheck(id)} title={upgradeReason(entry.phaseError)}
          className="studio:rounded-(--dsw-radius-sm) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-transparent studio:px-2 studio:text-xs studio:leading-5 studio:text-(--dsw-alias-label-primary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500">
          {t('consoleList.checkNow')}
        </button>
      </span>
    )
    return done ? <span data-upgrade-phase={entry?.phase} className="studio:shrink-0 studio:text-xs studio:text-(--dsw-alias-label-secondary)">{done}</span> : null
  }
  const library = info[LIBRARY_ID]

  const commit = (next: ConsoleStudioItem[]) => {
    const ids = next.map(item => item.id)
    if (ids.join('\n') !== studios.map(item => item.id).join('\n')) onReorder(ids)
  }

  const onGripDown = (event: PointerEvent<HTMLSpanElement>, id: string) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragging.current = { id, pointerId: event.pointerId }
    setDragId(id)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
  }

  const onGripMove = (event: PointerEvent<HTMLSpanElement>) => {
    const drag = dragging.current
    const list = listRef.current
    if (!drag || drag.pointerId !== event.pointerId || !list) return
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-console-studio]'))
    // 指针越过哪一行的中线，就插到哪一行的位置
    let target = rows.length - 1
    for (let index = 0; index < rows.length; index++) {
      const rect = rows[index].getBoundingClientRect()
      if (event.clientY < rect.top + rect.height / 2) { target = index; break }
    }
    setOrder(current => {
      const from = current.findIndex(item => item.id === drag.id)
      return from === target ? current : moveItem(current, from, target)
    })
  }

  const onGripUp = (event: PointerEvent<HTMLSpanElement>) => {
    const drag = dragging.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragging.current = null
    setDragId(null)
    commit(orderRef.current)
  }

  /** 键盘排序：抓手聚焦后上下方向键移动一位。 */
  const onGripKey = (event: KeyboardEvent<HTMLSpanElement>, id: string) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const from = order.findIndex(item => item.id === id)
    const next = moveItem(order, from, from + (event.key === 'ArrowUp' ? -1 : 1))
    setOrder(next)
    commit(next)
    // 重排后焦点跟随被移动的行，便于连续按方向键
    requestAnimationFrame(() => {
      const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-console-studio]') ?? []).find(node => node.getAttribute('data-console-studio') === id)
      row?.querySelector<HTMLElement>('[data-grip]')?.focus()
    })
  }

  return createPortal(
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}
      onClose={onClose} onClick={event => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
      }}
      className="studio:box-border studio:m-auto studio:max-h-[calc(100dvh-2rem)] studio:w-[min(32rem,calc(100vw-2rem))] studio:max-w-none studio:overflow-y-auto studio:overscroll-contain studio:rounded-(--dsw-radius-lg) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-(--dsw-alias-bg-base) studio:p-5 studio:text-(--dsw-alias-label-primary) studio:shadow-xl studio:backdrop:bg-black/30">
      <div className="studio:mb-4 studio:flex studio:items-center studio:justify-between studio:gap-3">
        <h2 id={titleId} className="studio:m-0 studio:text-base studio:font-medium">{t('consoleList.title')}</h2>
        <div className="studio:flex studio:items-center studio:gap-1">
          {offline.length > 0 && (
            <button type="button" data-start-all disabled={!!startBusy} aria-busy={startBusy === '*'} onClick={() => void startService()}
              className="studio:flex studio:h-8 studio:items-center studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-blue-600 studio:px-3 studio:text-sm studio:font-medium studio:text-white studio:cursor-pointer studio:hover:bg-blue-500 studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">
              {startBusy === '*' ? t('consoleList.starting') : t('consoleList.startAll')}
            </button>
          )}
          <button type="button" data-check-updates disabled={checking.length > 0} aria-busy={checking.length > 0}
            onClick={() => { if (checkSignal.current && !checkSignal.current.aborted) void checkUpdates(checkSignal.current, true) }}
            className="studio:flex studio:h-8 studio:items-center studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-transparent studio:px-3 studio:text-sm studio:text-(--dsw-alias-label-primary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">
            {checking.length > 0 ? t('consoleList.checking') : t('consoleList.checkNow')}
          </button>
          {onEnterConsole && (
            <button type="button" onClick={() => { onClose(); onEnterConsole() }}
              className="studio:flex studio:h-8 studio:items-center studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-transparent studio:px-3 studio:text-sm studio:text-(--dsw-alias-label-primary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500">
              {t('consoleList.enter')}
            </button>
          )}
          <button type="button" aria-label={t('add.close')} title={t('add.close')} onClick={onClose}
            className="studio:flex studio:h-8 studio:w-8 studio:shrink-0 studio:items-center studio:justify-center studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-transparent studio:text-(--dsw-alias-label-secondary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500">×</button>
        </div>
      </div>
      {library?.version && (
        <div data-library className="studio:-mt-2 studio:mb-4 studio:flex studio:items-center studio:gap-2 studio:text-xs studio:text-(--dsw-alias-label-secondary)">
          <span>{t('consoleList.library')} v{library.version}</span>
          {library.hasUpdate && library.latest && <span className="studio:rounded-full studio:bg-blue-600 studio:px-1.5 studio:py-px studio:text-[10px] studio:font-medium studio:leading-4 studio:text-white">{t('consoleList.hasUpdate')} v{library.latest}</span>}
          {upgradeControl(LIBRARY_ID, library)}
        </div>
      )}
      {upgradeError && <p role="alert" className="studio:mb-3 studio:mt-0 studio:break-words studio:text-sm studio:text-red-500">{upgradeError}</p>}
      {startError && <p role="alert" className="studio:mb-3 studio:mt-0 studio:break-words studio:text-sm studio:text-red-500">{startError}</p>}
      {editError && <p role="alert" className="studio:mb-3 studio:mt-0 studio:break-words studio:text-sm studio:text-red-500">{editError}</p>}
      {removeError && <p role="alert" className="studio:mb-3 studio:mt-0 studio:break-words studio:text-sm studio:text-red-500">{removeError}</p>}
      {loadError && <p role="alert" className="studio:mb-3 studio:mt-0 studio:text-sm studio:text-red-500">{t('consoleList.versionFail')}</p>}
      {order.length === 0
        ? <div data-console-empty className="studio:flex studio:justify-center studio:py-4">
            <img src={CONSOLE_EMPTY_IMAGE} alt={t('consoleList.emptyAlt')} loading="lazy" className="studio:block studio:max-h-48 studio:max-w-full studio:rounded-(--dsw-radius-md)" />
          </div>
        : <ul ref={listRef} aria-label={t('consoleList.title')} className="studio:m-0 studio:flex studio:list-none studio:flex-col studio:gap-3 studio:p-0 studio:pt-1">
          {order.map(item => {
            const row = info[item.studioId]
            const service = services[item.studioId]
            const serviceStarting = !!service && (service.starting || startBusy === item.studioId || (startBusy === '*' && !service.ready && service.startable))
            const active = dragId === item.id
            return (
              <li key={item.id} data-console-studio={item.id}
                className={'studio:group studio:relative studio:flex studio:items-center studio:gap-3 studio:rounded-(--dsw-radius-md) studio:border studio:bg-(--dsw-alias-fill-l1) studio:px-3 studio:py-2.5 studio:transition-colors studio:duration-150 studio:hover:bg-(--dsw-alias-interactive-bg-hover) '
                  + (active ? 'studio:border-blue-500 studio:shadow-lg' : 'studio:border-(--dsw-alias-border-l1)')}>
                {row?.hasUpdate && (
                  <span data-update-tag className="studio:absolute studio:-top-2 studio:right-3 studio:rounded-full studio:bg-blue-600 studio:px-1.5 studio:py-px studio:text-[10px] studio:font-medium studio:leading-4 studio:text-white">{t('consoleList.hasUpdate')}</span>
                )}
                <span className="studio:flex studio:min-w-0 studio:flex-1 studio:items-center studio:gap-2">
                  {item.icon && <span aria-hidden="true" className="studio:shrink-0 studio:text-base">{item.icon}</span>}
                  <span className="studio:flex studio:min-w-0 studio:flex-col">
                    <span className="studio:truncate studio:text-sm">{item.name}</span>
                    {row?.address && (row.source === 'github'
                      ? <a data-address href={row.address} target="_blank" rel="noreferrer noopener" title={row.address}
                          className="studio:truncate studio:text-xs studio:leading-5 studio:text-(--dsw-alias-label-tertiary) studio:no-underline studio:hover:underline">{row.address.replace(/^https:\/\//, '')}</a>
                      : <span data-address title={row.address} className="studio:truncate studio:text-xs studio:leading-5 studio:text-(--dsw-alias-label-tertiary)">{row.address}</span>)}
                    {service && (
                      <span data-service={service.ready ? 'ready' : serviceStarting ? 'starting' : 'offline'} title={service.error}
                        className="studio:flex studio:items-center studio:gap-1.5 studio:text-xs studio:leading-5 studio:text-(--dsw-alias-label-secondary)">
                        <span aria-hidden="true" className={'studio:h-1.5 studio:w-1.5 studio:shrink-0 studio:rounded-full ' + (service.ready ? 'studio:bg-green-500' : serviceStarting ? 'studio:bg-amber-400' : 'studio:bg-red-500')} />
                        {service.ready ? t('consoleList.serviceReady') : serviceStarting ? t('consoleList.starting') : t('consoleList.serviceOffline')}
                        {!service.ready && !serviceStarting && service.startable && (
                          <button type="button" data-start={item.studioId} disabled={!!startBusy} onClick={() => void startService(item.studioId)}
                            className="studio:ml-1 studio:rounded-(--dsw-radius-sm) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-transparent studio:px-1.5 studio:text-xs studio:leading-5 studio:text-(--dsw-alias-label-primary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">
                            {t('consoleList.start')}
                          </button>
                        )}
                        {!service.ready && !service.startable && <span>{t('consoleList.notConfigured')}</span>}
                      </span>
                    )}
                    {service && !service.ready && !serviceStarting && service.error && (
                      <span data-service-error title={service.error} className="studio:line-clamp-2 studio:break-words studio:text-xs studio:leading-5 studio:text-red-500">{service.error}</span>
                    )}
                  </span>
                </span>
                {onEditStudio && !row?.removal && row?.source === 'local' && row.address && (
                  <button type="button" data-edit-studio={item.studioId} aria-label={t('console.editStudio')} title={t('console.editStudio')}
                    onClick={() => {
                      setEditError('')
                      // 会话创建成功再关闭弹窗；失败时留在弹窗里显示原因
                      onEditStudio({ id: item.studioId, name: item.name, icon: item.icon, source: 'local', localPath: row.address! })
                        .then(onClose, (error: unknown) => {
                          // 取 message 而不判断 instanceof：错误可能来自其他窗口或模块环境
                          const message = (error as { message?: unknown } | null)?.message
                          setEditError(typeof message === 'string' ? message : String(error))
                        })
                    }}
                    className="studio:flex studio:h-6 studio:w-6 studio:shrink-0 studio:items-center studio:justify-center studio:rounded-(--dsw-radius-sm) studio:border-0 studio:bg-transparent studio:text-(--dsw-alias-label-tertiary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:hover:text-(--dsw-alias-label-primary) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500">
                    {ICON_EDIT}
                  </button>
                )}
                <span data-version className="studio:shrink-0 studio:text-xs studio:tabular-nums studio:text-(--dsw-alias-label-secondary)">{row?.version ? 'v' + row.version : '—'}</span>
                {row?.removal
                  ? <span data-removal={row.removal} className="studio:shrink-0 studio:text-xs studio:text-(--dsw-alias-label-secondary)">{removalText(row.removal)}</span>
                  : removing === item.studioId
                    ? <span data-uninstalling={item.studioId} className="studio:shrink-0 studio:text-xs studio:text-(--dsw-alias-label-secondary)">{t('consoleList.uninstalling')}</span>
                    : confirmRemove === item.studioId
                      ? (
                        <span data-uninstall-confirm={item.studioId} className="studio:flex studio:shrink-0 studio:items-center studio:gap-1.5 studio:text-xs">
                          <span title={t('consoleList.uninstallHint')} className="studio:text-(--dsw-alias-label-primary)">{t('consoleList.uninstallConfirm')}</span>
                          <button type="button" data-uninstall-yes={item.studioId} onClick={() => void uninstall(item.studioId)}
                            className="studio:border-0 studio:bg-red-600 studio:text-white studio:hover:bg-red-500 studio:rounded-(--dsw-radius-sm) studio:px-2 studio:text-xs studio:leading-5 studio:cursor-pointer studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">{t('consoleList.uninstall')}</button>
                          <button type="button" data-uninstall-no={item.studioId} onClick={() => setConfirmRemove(null)}
                            className="studio:border studio:border-(--dsw-alias-border-l1) studio:bg-transparent studio:text-(--dsw-alias-label-primary) studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:rounded-(--dsw-radius-sm) studio:px-2 studio:text-xs studio:leading-5 studio:cursor-pointer studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">{t('consoleList.uninstallCancel')}</button>
                        </span>
                      )
                      : (
                        <>
                          {upgradeControl(item.studioId, row)}
                          <button type="button" data-uninstall={item.studioId} disabled={!!removing || upgrading === item.studioId} aria-label={t('consoleList.uninstallOf', { name: item.name })} title={t('consoleList.uninstallHint')}
                            onClick={() => { setRemoveError(''); setConfirmRemove(item.studioId) }}
                            className="studio:flex studio:h-6 studio:w-6 studio:shrink-0 studio:items-center studio:justify-center studio:rounded-(--dsw-radius-sm) studio:border-0 studio:bg-transparent studio:text-(--dsw-alias-label-tertiary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:hover:text-red-500 studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">
                            {ICON_REMOVE}
                          </button>
                        </>
                      )}
                <span data-grip role="button" tabIndex={0} aria-label={t('consoleList.drag', { name: item.name })} title={t('consoleList.dragHint')}
                  onPointerDown={event => onGripDown(event, item.id)} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}
                  onKeyDown={event => onGripKey(event, item.id)}
                  className={'studio:flex studio:h-6 studio:w-6 studio:shrink-0 studio:touch-none studio:items-center studio:justify-center studio:rounded-(--dsw-radius-sm) studio:text-(--dsw-alias-label-tertiary) studio:transition-opacity studio:duration-150 studio:hover:text-(--dsw-alias-label-primary) studio:focus-visible:opacity-100 studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:group-hover:opacity-100 '
                    + (active ? 'studio:cursor-grabbing studio:opacity-100' : 'studio:cursor-grab studio:opacity-0')}>
                  {ICON_GRIP}
                </span>
              </li>
            )
          })}
        </ul>}
    </dialog>,
    document.body,
  )
}
