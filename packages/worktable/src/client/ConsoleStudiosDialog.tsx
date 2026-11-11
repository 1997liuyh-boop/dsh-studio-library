import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { WorktableKey } from './locales'

type Translate = (key: WorktableKey, params?: Record<string, string>) => string

/** 控制台列表中的一个子工作室。 */
export interface ConsoleStudioItem {
  /** 工作室项目标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 图标（emoji） */
  icon?: string
}

/** 单个工作室的版本信息（来自 /studio-projects/updates）。 */
interface StudioVersion {
  version?: string
  hasUpdate: boolean
}

/** 读取全部工作室的本地版本与更新状态；失败返回空表，不阻断排序。 */
async function loadVersions(signal: AbortSignal): Promise<Record<string, StudioVersion>> {
  const response = await fetch('/studio-projects/updates', { cache: 'no-store', signal })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const report = await response.json()
  const table: Record<string, StudioVersion> = {}
  for (const row of Array.isArray(report?.studios) ? report.studios : []) {
    if (typeof row?.id !== 'string') continue
    table[row.id] = { version: typeof row.version === 'string' ? row.version : undefined, hasUpdate: row.state === 'available' }
  }
  return table
}

/** 把 id 从 from 位置移到 to 位置，返回新数组。 */
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

/** 控制台弹窗：列出全部子工作室（名称 / 版本 / 有更新标记），按住右侧抓手拖拽排序。 */
export function ConsoleStudiosDialog({ open, t, studios, onClose, onReorder }: {
  /** 是否显示弹窗 */
  open: boolean
  /** 文案翻译函数 */
  t: Translate
  /** 当前排序下的子工作室列表 */
  studios: ConsoleStudioItem[]
  /** 关闭弹窗 */
  onClose: () => void
  /** 拖拽结束后提交新顺序（工作室 id 列表） */
  onReorder: (ids: string[]) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const titleId = useId()
  const [order, setOrder] = useState<ConsoleStudioItem[]>(studios)
  const [versions, setVersions] = useState<Record<string, StudioVersion>>({})
  const [loadError, setLoadError] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const dragging = useRef<{ id: string; pointerId: number } | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order

  // 打开时以外部顺序为准；拖拽过程中不被外部刷新打断
  useEffect(() => { if (!dragging.current) setOrder(studios) }, [studios])

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoadError(false)
    loadVersions(controller.signal).then(setVersions).catch(() => { if (!controller.signal.aborted) setLoadError(true) })
    return () => controller.abort()
  }, [open])

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
      <div className="studio:flex studio:items-center studio:justify-between studio:gap-3">
        <h2 id={titleId} className="studio:m-0 studio:text-base studio:font-medium">{t('consoleList.title')}</h2>
        <button type="button" aria-label={t('add.close')} title={t('add.close')} onClick={onClose}
          className="studio:flex studio:h-8 studio:w-8 studio:shrink-0 studio:items-center studio:justify-center studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-transparent studio:text-(--dsw-alias-label-secondary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500">×</button>
      </div>
      <p className="studio:mb-4 studio:mt-2 studio:text-sm studio:leading-6 studio:text-(--dsw-alias-label-secondary)">{t('consoleList.description')}</p>
      {loadError && <p role="alert" className="studio:mb-3 studio:mt-0 studio:text-sm studio:text-red-500">{t('consoleList.versionFail')}</p>}
      {order.length === 0
        ? <p className="studio:m-0 studio:text-sm studio:text-(--dsw-alias-label-secondary)">{t('consoleList.empty')}</p>
        : <ul ref={listRef} aria-label={t('consoleList.title')} className="studio:m-0 studio:flex studio:list-none studio:flex-col studio:gap-3 studio:p-0 studio:pt-1">
          {order.map(item => {
            const info = versions[item.id]
            const active = dragId === item.id
            return (
              <li key={item.id} data-console-studio={item.id}
                className={'studio:group studio:relative studio:flex studio:items-center studio:gap-3 studio:rounded-(--dsw-radius-md) studio:border studio:bg-(--dsw-alias-fill-l1) studio:px-3 studio:py-2.5 studio:transition-colors studio:duration-150 studio:hover:bg-(--dsw-alias-interactive-bg-hover) '
                  + (active ? 'studio:border-blue-500 studio:shadow-lg' : 'studio:border-(--dsw-alias-border-l1)')}>
                {info?.hasUpdate && (
                  <span className="studio:absolute studio:-top-2 studio:right-3 studio:rounded-full studio:bg-blue-600 studio:px-1.5 studio:py-px studio:text-[10px] studio:font-medium studio:leading-4 studio:text-white">{t('consoleList.hasUpdate')}</span>
                )}
                <span className="studio:flex studio:min-w-0 studio:flex-1 studio:items-center studio:gap-2 studio:text-sm">
                  {item.icon && <span aria-hidden="true" className="studio:shrink-0">{item.icon}</span>}
                  <span className="studio:truncate">{item.name}</span>
                </span>
                <span className="studio:shrink-0 studio:text-xs studio:tabular-nums studio:text-(--dsw-alias-label-secondary)">{info?.version ? 'v' + info.version : '—'}</span>
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
