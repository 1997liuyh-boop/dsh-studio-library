import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorktableKey } from './locales'

type Translate = (key: WorktableKey, params?: Record<string, string>) => string

/** 导入结果：applied = 已生效；restart = 需完整重启 dsh 后生效。 */
export type StudioImportOutcome = 'applied' | 'restart'

/** 本机绝对路径（Windows 盘符 / UNC / POSIX）。 */
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/
/** GitHub 仓库地址。 */
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/

/** 判断输入是否为可导入的工作室来源。 */
export function isStudioSource(value: string): boolean {
  const text = value.trim()
  return LOCAL_PATH.test(text) || GITHUB_REPO.test(text)
}

/** AI 新建图标：对话气泡 + 星光，表示「让大肥鱼新建」。 */
const ICON_AI_ADD = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M8 1.6l1.5 3.9 3.9 1.5-3.9 1.5L8 12.4 6.5 8.5 2.6 7l3.9-1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M12.6 11.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="currentColor" />
  </svg>
)

/** 新增工作室弹窗：输入地址导入已有工作室，或点 AI 图标新开会话从零新建。 */
export function AddStudioDialog({ open, t, onClose, onAiCreate, onImport }: {
  /** 是否显示弹窗 */
  open: boolean
  /** 文案翻译函数 */
  t: Translate
  /** 关闭弹窗 */
  onClose: () => void
  /** 新开会话让大肥鱼新建工作室 */
  onAiCreate: () => Promise<void>
  /** 按 GitHub 地址或本机目录导入工作室 */
  onImport: (source: string) => Promise<StudioImportOutcome>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descId = useId()
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState<'' | 'ai' | 'import'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && !node.open) { setError(''); setNotice(''); node.showModal() }
    if (!open && node.open) node.close()
  }, [open])

  const aiCreate = async () => {
    if (busy) return
    setBusy('ai')
    setError('')
    setNotice('')
    try {
      await onAiCreate()
      onClose()
    } catch {
      setError(t('add.createFail'))
    } finally {
      setBusy('')
    }
  }

  const importStudio = async () => {
    const value = source.trim()
    if (!value || busy) return
    if (!isStudioSource(value)) { setError(t('add.importInvalid')); return }
    setBusy('import')
    setError('')
    setNotice('')
    try {
      const outcome = await onImport(value)
      setSource('')
      setNotice(t(outcome === 'restart' ? 'add.importRestart' : 'add.importDone'))
    } catch (err) {
      setError(t('add.importFail', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy('')
    }
  }

  return createPortal(
    <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descId} onCancel={event => { event.preventDefault(); onClose() }}
      onClose={onClose} onClick={event => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
      }}
      className="studio:box-border studio:m-auto studio:w-[min(32rem,calc(100vw-2rem))] studio:max-w-none studio:rounded-(--dsw-radius-lg) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-(--dsw-alias-bg-base) studio:p-5 studio:text-(--dsw-alias-label-primary) studio:shadow-xl studio:backdrop:bg-black/30">
      <div className="studio:flex studio:items-center studio:justify-between studio:gap-3">
        <h2 id={titleId} className="studio:m-0 studio:text-base studio:font-medium">{t('add.studio')}</h2>
        <button type="button" aria-label={t('add.close')} title={t('add.close')} onClick={onClose}
          className="studio:flex studio:h-8 studio:w-8 studio:shrink-0 studio:items-center studio:justify-center studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-transparent studio:text-(--dsw-alias-label-secondary) studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500">×</button>
      </div>
      <p id={descId} className="studio:mb-4 studio:mt-2 studio:text-sm studio:leading-6 studio:text-(--dsw-alias-label-secondary)">{t('add.studioDescription')}</p>
      <input type="text" autoFocus value={source} disabled={!!busy} placeholder={t('add.studioPlaceholder')}
        aria-label={t('add.studioInputLabel')} onChange={event => { setSource(event.currentTarget.value); setError('') }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void importStudio() }}
        className="studio:box-border studio:w-full studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-(--dsw-alias-fill-l1) studio:px-3 studio:py-2.5 studio:text-sm studio:text-(--dsw-alias-label-primary) studio:outline-none studio:placeholder:text-(--dsw-alias-label-tertiary) studio:focus:border-blue-500" />
      {error && <p role="alert" className="studio:mb-0 studio:mt-3 studio:text-sm studio:text-red-500">{error}</p>}
      {notice && <p role="status" className="studio:mb-0 studio:mt-3 studio:text-sm studio:text-green-600">{notice}</p>}
      <div className="studio:mt-4 studio:flex studio:items-center studio:gap-3">
        <button type="button" disabled={!!busy} aria-busy={busy === 'ai'} onClick={() => void aiCreate()}
          aria-label={busy === 'ai' ? t('add.creating') : t('add.callBigFish')} title={busy === 'ai' ? t('add.creating') : t('add.callBigFish')}
          className="studio:flex studio:h-10 studio:w-10 studio:shrink-0 studio:items-center studio:justify-center studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-(--dsw-alias-fill-l1) studio:text-blue-500 studio:cursor-pointer studio:hover:bg-(--dsw-alias-interactive-bg-hover) studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">
          {ICON_AI_ADD}
        </button>
        <button type="button" disabled={!source.trim() || !!busy} aria-busy={busy === 'import'} onClick={() => void importStudio()}
          className="studio:flex studio:h-10 studio:flex-1 studio:items-center studio:justify-center studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-blue-600 studio:px-4 studio:text-sm studio:font-medium studio:text-white studio:cursor-pointer studio:hover:bg-blue-500 studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">
          {busy === 'import' ? t('add.importing') : t('add.import')}
        </button>
      </div>
    </dialog>,
    document.body,
  )
}
