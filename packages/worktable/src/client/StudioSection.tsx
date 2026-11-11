import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** 工作室标题栏内联搜索：与宿主「工作区」搜索同款的放大镜展开动画。 */
export interface StudioSearchProps {
  /** 是否已展开为输入框 */
  expanded: boolean
  /** 当前搜索词 */
  query: string
  /** 放大镜按钮与输入框的无障碍名称 */
  label: string
  /** 输入框占位文字 */
  placeholder: string
  /** 清空按钮的无障碍名称 */
  clearLabel: string
  /** 放大镜图标 */
  icon: ReactNode
  /** 展开搜索 */
  onExpand: () => void
  /** 搜索词变化 */
  onQuery: (query: string) => void
  /** 清空并收起 */
  onClose: () => void
}

export interface StudioSectionProps {
  wide: boolean
  title: string
  expandSidebar: () => void
  children: ReactNode
  toolbar?: ReactNode
  /** 标题栏内联搜索；展开时标题与右侧按钮收起让位 */
  search?: StudioSearchProps
}

/** 关闭图标（与宿主搜索清空按钮同款实心叉）。 */
const ICON_CLOSE = (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 3.2 8 7l3.8-3.8 1 1L9 8l3.8 3.8-1 1L8 9l-3.8 3.8-1-1L7 8 3.2 4.2z" fill="currentColor" /></svg>
)

/** 内联搜索框：点击放大镜原地展开，Esc / 叉号清空收起，空词时点外部收起。 */
function StudioSearch({ expanded, query, label, placeholder, clearLabel, icon, onExpand, onQuery, onClose }: StudioSearchProps) {
  const root = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (expanded) input.current?.focus({ preventScroll: true })
  }, [expanded])

  // 外部点击：失焦；搜索词为空时收起（与宿主工作区搜索一致）
  useEffect(() => {
    if (!expanded) return
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target)) return
      input.current?.blur()
      if (!query.trim()) onClose()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [expanded, query, onClose])

  return (
    <div className="dsh-wt_searchSlot" data-expanded={expanded ? 'true' : 'false'}>
      <div ref={root} className="dsh-wt_searchPill" data-expanded={expanded ? 'true' : 'false'}
        onClick={() => { if (!expanded) onExpand(); input.current?.focus({ preventScroll: true }) }}>
        <button type="button" className="dsh-wt_searchBtn" aria-label={label} title={expanded ? undefined : label} aria-expanded={expanded}
          onClick={(event) => { event.stopPropagation(); if (!expanded) onExpand(); else input.current?.focus({ preventScroll: true }) }}>
          {icon}
        </button>
        <input ref={input} type="text" className="dsh-wt_searchInput" value={query} placeholder={placeholder} aria-label={label}
          tabIndex={expanded ? 0 : -1} onChange={(event) => onQuery(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onClose() }} />
        {expanded && (
          <button type="button" className="dsh-wt_searchClearBtn" aria-label={clearLabel} title={clearLabel}
            onClick={(event) => { event.stopPropagation(); onClose() }}>{ICON_CLOSE}</button>
        )}
      </div>
    </div>
  )
}

/** “更多”上方的工作室抽屉，首次展开后保留控制器，收起时仅隐藏列表。 */
export function StudioSection({ wide, title, expandSidebar, children, toolbar, search }: StudioSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)
  const contentId = useId()
  const open = wide && expanded
  const searching = open && !!search?.expanded
  const toggle = () => {
    setHasOpened(true)
    if (!wide) {
      expandSidebar()
      setExpanded(true)
      return
    }
    setExpanded(value => !value)
  }

  return (
    <section data-studio-shell className="studio:shrink-0 studio:w-full studio:min-w-0 studio:text-inherit">
      <div data-studio-header data-searching={searching ? 'true' : 'false'} className="studio:flex studio:h-[34px] studio:items-center studio:gap-1">
      <button type="button" data-studio-toggle onClick={toggle} aria-expanded={wide && expanded}
        aria-controls={contentId} aria-label={title} title={!wide ? title : undefined}
        className="studio:group studio:flex studio:h-[34px] studio:min-w-0 studio:flex-1 studio:items-center studio:gap-1.5 studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-transparent studio:px-2 studio:text-(--dsw-alias-label-primary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500">
        <svg width="16" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" data-studio-icon className="studio:shrink-0 studio:text-(--dsw-alias-label-tertiary) studio:group-hover:hidden studio:group-focus-visible:hidden">
          <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 10h18M10 10v10" />
        </svg>
        <span aria-hidden="true" data-studio-chevron className="studio:hidden studio:h-5 studio:w-4 studio:shrink-0 studio:items-center studio:justify-center studio:text-(--dsw-alias-label-tertiary) studio:group-hover:inline-flex studio:group-focus-visible:inline-flex">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={'studio:transition-transform studio:duration-150 studio:ease-(--ds-ease-in-out) studio:motion-reduce:transition-none ' + (open ? 'studio:rotate-90' : '')}><path d="M6 4.5a.5.5 0 0 1 .8-.4l4 3.5a.5.5 0 0 1 0 .8l-4 3.5a.5.5 0 0 1-.8-.4z" /></svg>
        </span>
        {wide && <span data-studio-title className="studio:min-w-0 studio:flex-1 studio:truncate studio:text-left studio:text-sm studio:leading-5">{title}</span>}
      </button>
      {hasOpened && open && search && <StudioSearch {...search} />}
      {hasOpened && <div data-studio-toolbar hidden={!open} className="studio:flex studio:shrink-0 studio:items-center studio:gap-1 studio:[&[hidden]]:hidden">{toolbar}</div>}
      </div>
      {hasOpened && <div ref={node => { if (node) node.inert = !open }} aria-hidden={!open} className={'studio:grid studio:transition-[grid-template-rows] studio:duration-200 studio:ease-out studio:motion-reduce:transition-none ' + (open ? 'studio:grid-rows-[1fr]' : 'studio:grid-rows-[0fr]')}>
        <div className="studio:min-h-0 studio:overflow-hidden">
        <div id={contentId} data-studio-content tabIndex={open ? 0 : -1} role="region" aria-label={title}
        className="studio:h-60 studio:max-h-[40vh] studio:overflow-y-auto studio:overflow-x-hidden studio:overscroll-contain studio:px-1 studio:[scrollbar-width:none] studio:[&::-webkit-scrollbar]:hidden">
          <div className={'studio:transition-opacity studio:duration-100 studio:ease-out studio:motion-reduce:transition-none ' + (open ? 'studio:opacity-100' : 'studio:opacity-0')}>{children}</div>
        </div>
        </div>
      </div>}
    </section>
  )
}
