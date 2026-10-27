import { useId, useState, type ReactNode } from 'react'

export interface StudioSectionProps {
  wide: boolean
  title: string
  expandSidebar: () => void
  children: ReactNode
}

/** “更多”上方的工作室抽屉，首次展开后保留控制器，收起时仅隐藏列表。 */
export function StudioSection({ wide, title, expandSidebar, children }: StudioSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)
  const contentId = useId()
  const open = wide && expanded
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
      <button type="button" onClick={toggle} aria-expanded={wide && expanded}
        aria-controls={contentId} aria-label={title} title={!wide ? title : undefined}
        className="studio:group studio:flex studio:h-[34px] studio:w-full studio:items-center studio:gap-1.5 studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-transparent studio:px-2 studio:text-(--dsw-alias-label-primary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500">
        <svg width="16" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" data-studio-icon className="studio:shrink-0 studio:text-(--dsw-alias-label-tertiary) studio:group-hover:hidden studio:group-focus-visible:hidden">
          <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 10h18M10 10v10" />
        </svg>
        <span aria-hidden="true" data-studio-chevron className="studio:hidden studio:h-5 studio:w-4 studio:shrink-0 studio:items-center studio:justify-center studio:text-(--dsw-alias-label-tertiary) studio:group-hover:inline-flex studio:group-focus-visible:inline-flex">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={'studio:transition-transform studio:duration-150 studio:ease-(--ds-ease-in-out) studio:motion-reduce:transition-none ' + (open ? 'studio:rotate-90' : '')}><path d="M6 4.5a.5.5 0 0 1 .8-.4l4 3.5a.5.5 0 0 1 0 .8l-4 3.5a.5.5 0 0 1-.8-.4z" /></svg>
        </span>
        {wide && <span className="studio:min-w-0 studio:flex-1 studio:truncate studio:text-left studio:text-sm studio:leading-5">{title}</span>}
      </button>
      {hasOpened && <div ref={node => { if (node) node.inert = !open }} aria-hidden={!open} className={'studio:grid studio:transition-[grid-template-rows] studio:duration-200 studio:ease-out studio:motion-reduce:transition-none ' + (open ? 'studio:grid-rows-[1fr]' : 'studio:grid-rows-[0fr]')}>
        <div className="studio:min-h-0 studio:overflow-hidden">
        <div id={contentId} data-studio-content tabIndex={open ? 0 : -1} role="region" aria-label={title}
        className="studio:h-60 studio:max-h-[40vh] studio:overflow-y-auto studio:overflow-x-hidden studio:overscroll-contain studio:px-1 studio:[scrollbar-width:none] studio:[&::-webkit-scrollbar]:hidden studio:[&_.dsh-wt_handle]:hidden studio:[&_.dsh-wt_title]:hidden studio:[&_.dsh-wt_divider]:hidden">
          <div className={'studio:transition-opacity studio:duration-100 studio:ease-out studio:motion-reduce:transition-none ' + (open ? 'studio:opacity-100' : 'studio:opacity-0')}>{children}</div>
        </div>
        </div>
      </div>}
    </section>
  )
}
