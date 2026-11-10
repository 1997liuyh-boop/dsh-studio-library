import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorktableKey } from './locales'
import type { StudioUpdateReport, StudioUpdateRow } from '../../../sdk/updates'

type Translate = (key: WorktableKey, params?: Record<string, string>) => string
const button = 'studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-transparent studio:px-3 studio:py-1.5 studio:text-inherit studio:text-sm studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:disabled:cursor-default studio:disabled:opacity-50 studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500'

/** 工作室共用更新面板；关闭仅隐藏界面，安装继续由后台管理器负责。 */
export function StudioUpdates({ t, icon }: { t: Translate; icon: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<StudioUpdateReport | null>(null)
  const [action, setAction] = useState('')
  const [error, setError] = useState('')
  const lifetime = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => { controller.abort(); lifetime.current = null } }, [])

  const request = async (path = '', body?: object) => {
    const response = await fetch('/studio-projects/updates' + path, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), cache: 'no-store', signal: lifetime.current?.signal })
    if (!response.ok) throw new Error(response.status === 409 ? 'recheck' : 'connection')
    const report: StudioUpdateReport = await response.json()
    if (!Array.isArray(report.studios) || typeof report.busy !== 'boolean') throw new Error('connection')
    return report
  }
  const refresh = async () => {
    const revision = ++sequence.current
    try { const report = await request(); if (lifetime.current && revision === sequence.current) { setData(report); setError('') } }
    catch (reason) { if (lifetime.current && revision === sequence.current) setError(reason instanceof Error ? reason.message : 'connection') }
  }
  useEffect(() => {
    if (!open) return
    void refresh()
    if (!data?.busy && !action.startsWith('install:')) return
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => clearInterval(timer)
  }, [open, data?.busy, action.startsWith('install:')])

  const run = async (kind: 'check' | 'install', rows: StudioUpdateRow[]) => {
    if (action || data?.busy) return
    setError('')
    try {
      for (const row of rows) {
        setAction(kind + ':' + row.id)
        const report = await request('/' + kind, { id: row.id, ...(kind === 'install' ? { version: row.latest } : {}) })
        sequence.current++
        if (!lifetime.current) return
        setData(report)
      }
    } catch (reason) { if (lifetime.current) setError(reason instanceof Error ? reason.message : 'connection') }
    finally { if (lifetime.current) { setAction(''); void refresh() } }
  }
  const show = () => { dialog.current?.showModal(); setOpen(true) }
  const close = () => { dialog.current?.close(); setOpen(false) }
  return <>
    <button type="button" aria-label={t('studiosUpdates.title')} title={t('studiosUpdates.title')} onClick={show}
      className="studio:flex studio:h-7 studio:w-7 studio:items-center studio:justify-center studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-transparent studio:text-(--dsw-alias-label-secondary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:[&_svg]:size-4">{icon}</button>
    {createPortal(<dialog ref={dialog} data-studio-updates aria-labelledby={titleId} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close() } }}
      className="studio:box-border studio:m-auto studio:max-h-[calc(100dvh-2rem)] studio:w-[min(48rem,calc(100vw-2rem))] studio:max-w-none studio:overflow-y-auto studio:overscroll-contain studio:rounded-(--dsw-radius-lg) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-(--dsw-alias-bg-base) studio:p-5 studio:text-(--dsw-alias-label-primary) studio:shadow-xl studio:backdrop:bg-black/30">
      <div className="studio:flex studio:flex-wrap studio:items-center studio:justify-between studio:gap-3">
        <h2 id={titleId} className="studio:m-0 studio:text-base studio:font-medium">{t('studiosUpdates.title')}</h2>
        <button type="button" autoFocus className={button} onClick={close}>{t('studiosUpdates.close')}</button>
      </div>
      <p className="studio:mb-4 studio:mt-2 studio:text-sm studio:leading-6 studio:text-(--dsw-alias-label-secondary)">{t('studiosUpdates.description')}</p>
      <div className="studio:mb-4 studio:flex studio:flex-wrap studio:items-center studio:justify-between studio:gap-3">
        <span className="studio:text-sm studio:text-(--dsw-alias-label-secondary)">{data ? 'dsh ' + data.hostVersion : t('studiosUpdates.loading')}</span>
        <button type="button" className={button} disabled={!data || !!action || data.busy} onClick={() => { if (data) void run('check', data.studios) }}>{action.startsWith('check:') ? t('studiosUpdates.checking') : t('studiosUpdates.checkAll')}</button>
      </div>
      {error && <p role="alert" className="studio:mb-4 studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:p-3 studio:text-sm studio:leading-6">{t(error === 'recheck' ? 'studiosUpdates.recheck' : 'studiosUpdates.connection')} <button type="button" className={button} onClick={() => { void refresh() }}>{t('studiosUpdates.retry')}</button></p>}
      {data?.issue && <p role="alert" className="studio:mb-4 studio:text-sm studio:leading-6">{t('studiosUpdates.record')}</p>}
      <div className="studio:flex studio:flex-col studio:gap-3" aria-live="polite" aria-busy={!!action || data?.busy}>
        {data?.studios.map(row => <article key={row.id} data-studio-update={row.id} className="studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:p-3">
          <div className="studio:flex studio:flex-wrap studio:items-start studio:justify-between studio:gap-3">
            <div className="studio:min-w-0 studio:flex-1">
              <h3 className="studio:m-0 studio:break-words studio:text-sm studio:font-medium">{row.name}</h3>
              <p className="studio:mb-0 studio:mt-1 studio:break-all studio:text-xs studio:leading-5 studio:text-(--dsw-alias-label-secondary)">{t('studiosUpdates.current', { version: row.version })}{row.upstreamVersion ? ' · ' + t('studiosUpdates.upstream', { version: row.upstreamVersion }) : ''}</p>
              <p className="studio:mb-0 studio:mt-1 studio:text-sm studio:leading-6">{action === 'check:' + row.id ? t('studiosUpdates.checking') : t(`studiosUpdates.state.${row.state}`, { version: row.latest ?? '' })}</p>
              {row.operation && <p role={['failed', 'unknown'].includes(row.operation.phase) ? 'alert' : 'status'} className="studio:mb-0 studio:mt-1 studio:break-words studio:text-sm studio:leading-6">{t(`studiosUpdates.phase.${row.operation.phase}`, { version: row.operation.to })}</p>}
              {row.repository && <a href={'https://github.com/' + row.repository + '/releases'} target="_blank" rel="noreferrer noopener" className="studio:mt-1 studio:inline-block studio:text-xs studio:leading-5 studio:text-(--dsw-alias-label-secondary) studio:underline">{t('studiosUpdates.releases')}</a>}
            </div>
            <div className="studio:flex studio:shrink-0 studio:flex-wrap studio:gap-2">
              <button type="button" className={button} disabled={!!action || data.busy || row.state === 'unconfigured'} onClick={() => { void run('check', [row]) }}>{t('studiosUpdates.check')}</button>
              {row.state === 'available' && <button type="button" className={button} disabled={!!action || data.busy || !!data.issue || row.operation?.phase === 'restart-required' || row.operation?.phase === 'unknown'} onClick={() => { void run('install', [row]) }}>{t('studiosUpdates.install', { version: row.latest ?? '' })}</button>}
            </div>
          </div>
        </article>)}
        {data && !data.studios.length && <p className="studio:text-sm">{t('studiosUpdates.empty')}</p>}
      </div>
    </dialog>, document.body)}
  </>
}
