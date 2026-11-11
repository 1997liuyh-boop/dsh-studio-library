import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorktableKey } from './locales'

type Translate = (key: WorktableKey, params?: Record<string, string>) => string

/** 生成新会话可直接发送的工作室需求模板。 */
export function buildAddStudioPrompt(t: Translate, source: string): string {
  return [
    t('add.promptIntro'),
    t('add.promptFeature'),
    t('add.promptPath') + source.trim(),
  ].join('\n')
}

/** 添加工作室弹窗复用插件安装弹窗的标题、说明、输入和单主操作结构。 */
export function AddStudioDialog({ open, t, onClose, onCreate }: {
  open: boolean
  t: Translate
  onClose: () => void
  onCreate: (prompt: string, source: string) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const prompt = buildAddStudioPrompt(t, source)

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])

  const submit = async () => {
    const value = source.trim()
    if (!value || busy) return
    setBusy(true)
    setError('')
    try {
      await onCreate(buildAddStudioPrompt(t, value), value)
      setSource('')
      onClose()
    } catch {
      setError(t('add.createFail'))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}
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
      <p className="studio:mb-4 studio:mt-2 studio:text-sm studio:leading-6 studio:text-(--dsw-alias-label-secondary)">{t('add.studioDescription')}</p>
      <input type="text" autoFocus value={source} disabled={busy} placeholder={t('add.studioPlaceholder')}
        aria-label={t('add.studioDescription')} onChange={event => setSource(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit() }}
        className="studio:box-border studio:w-full studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-(--dsw-alias-fill-l1) studio:px-3 studio:py-2.5 studio:text-sm studio:text-(--dsw-alias-label-primary) studio:outline-none studio:placeholder:text-(--dsw-alias-label-tertiary) studio:focus:border-blue-500" />
      <div className="studio:mt-4">
        <span className="studio:text-xs studio:text-(--dsw-alias-label-secondary)">{t('add.promptLabel')}</span>
        <pre className="studio:mt-2 studio:whitespace-pre-wrap studio:break-words studio:rounded-(--dsw-radius-md) studio:border studio:border-(--dsw-alias-border-l1) studio:bg-(--dsw-alias-fill-l1) studio:p-3 studio:text-xs studio:leading-5 studio:text-(--dsw-alias-label-secondary)">{prompt}</pre>
      </div>
      {error && <p role="alert" className="studio:mb-0 studio:mt-3 studio:text-sm studio:text-red-500">{error}</p>}
      <button type="button" disabled={!source.trim() || busy} aria-busy={busy} onClick={() => void submit()}
        className="studio:mt-4 studio:flex studio:w-full studio:items-center studio:justify-center studio:rounded-(--dsw-radius-md) studio:border-0 studio:bg-blue-600 studio:px-4 studio:py-2.5 studio:text-sm studio:font-medium studio:text-white studio:cursor-pointer studio:hover:bg-blue-500 studio:focus-visible:outline-2 studio:focus-visible:outline-blue-500 studio:disabled:cursor-default studio:disabled:opacity-50">
        {busy ? t('add.creating') : t('add.callBigFish')}
      </button>
    </dialog>,
    document.body,
  )
}
