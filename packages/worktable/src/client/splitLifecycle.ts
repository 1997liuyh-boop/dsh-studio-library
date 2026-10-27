interface SplitLifecycleStore {
  active: boolean
  spec: { id: string } | null
  close(): void
}

/** 分屏互斥、兼容桥与观察器由插件统一安装和释放。 */
export function installSplitLifecycle(splitStore: SplitLifecycleStore): () => void {
  const bridge = { splitStore }
  const target = window as Window & { __dshWorktable?: typeof bridge }
  target.__dshWorktable = bridge
  const onClaim = (event: Event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id
    if (splitStore.active && id && id !== splitStore.spec?.id) splitStore.close()
  }
  const observer = new MutationObserver(() => {
    if (splitStore.active && document.querySelector('.ta_split')) splitStore.close()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('dsh:split-claim', onClaim)
  return () => {
    observer.disconnect()
    window.removeEventListener('dsh:split-claim', onClaim)
    if (target.__dshWorktable === bridge) delete target.__dshWorktable
    splitStore.close()
  }
}
