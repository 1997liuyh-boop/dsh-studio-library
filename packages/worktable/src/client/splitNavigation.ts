import { splitStore } from './split'

let navigate: (() => void) | undefined
let generation = 0

/** 插件卸载时撤销宿主导航，取消待打开的页面。 */
export function installSplitNavigation(callback: () => void): () => void {
  navigate = callback
  return () => { if (navigate === callback) { navigate = undefined; generation++ } }
}

/** 等待宿主主页面实际挂载后打开分栏，连续点击只处理最后一次。 */
export async function openStudioSplit(spec: Parameters<typeof splitStore.open>[0]): Promise<boolean> {
  const current = ++generation
  navigate?.()
  const ready = () => [...document.querySelectorAll<HTMLElement>('[data-phase]')].some(node => ['active', 'hero', 'settling'].includes(node.dataset.phase ?? '') && node.children.length > 0)
  if (!ready()) await new Promise<void>(resolve => {
    const finish = () => { observer.disconnect(); clearTimeout(timer); resolve() }
    const observer = new MutationObserver(() => { if (current !== generation || ready()) finish() })
    const timer = setTimeout(finish, 3000)
    observer.observe(document.body, { childList: true, subtree: true })
    if (ready()) finish()
  })
  return current === generation && splitStore.open(spec)
}
