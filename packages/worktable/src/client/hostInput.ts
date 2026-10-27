import { currentSessionOf } from './sessionCompat'


export function appendHostInput(bridge: any, text: string, doc: Document = document): boolean {
  try {
    const resolver = bridge?.conversation?.input
    if (typeof resolver?.for === 'function') {
      const snapshot = bridge.sessions?.list?.getSnapshot?.()
      const id = currentSessionOf(snapshot)
      const scope = id ? bridge.sessions?.scope?.(id) : null
      if (!scope) return false
      const input = resolver.for(scope)
      const state = input?.state?.getSnapshot?.()
      if (!state || typeof state.draft !== 'string' || !Number.isInteger(state.draftRev)
        || !['plain', 'claimed'].includes(state.phase) || !Array.isArray(state.occurrences)) return false


      const compactReferences = typeof snapshot?.current !== 'string'
      let end = state.draft.length
      let previousEnd = 0
      for (const item of state.occurrences) {
        if (!Number.isInteger(item.offset) || !Number.isInteger(item.length)
          || item.length < 0 || item.offset < previousEnd
          || item.offset + item.length > state.draft.length) return false
        previousEnd = item.offset + item.length
        if (compactReferences) end += 1 - item.length
      }
      const span = { start: end, end, draftRev: state.draftRev }
      const addition = (state.draft.trim() ? '\n\n' : '') + text


      const inserted = typeof input.actions?.insertText === 'function'
        ? input.actions.insertText(addition, span) === true
        : scope.bail?.('slash/input-insert-text', { text: addition, span }) === true
      if (inserted) { try { input.focus?.() } catch {} }
      return inserted
    }


    const ta = doc.querySelector<HTMLTextAreaElement>('textarea[data-phase]')
    if (!ta || ta.disabled || ta.readOnly || ta.closest('.dsh-wt_annotUi')) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    const next = ta.value && ta.value.trim() ? ta.value + '\n\n' + text : text
    if (setter) setter.call(ta, next)
    else ta.value = next
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    try {
      ta.focus()
      ta.dispatchEvent(new Event('change', { bubbles: true }))
      ta.setSelectionRange(ta.value.length, ta.value.length)
    } catch {}
    return true
  } catch { return false }
}
