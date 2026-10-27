/** 临时隐藏聊天时保留布局尺寸；退出或切换根节点后完整恢复宿主状态。 */
export function createChatVisibility() {
  let current: { node: HTMLElement; visibility: string; priority: string; inert: boolean; ariaHidden: string | null } | null = null
  const restore = () => {
    if (!current) return
    const { node, visibility, priority, inert, ariaHidden } = current
    if (visibility) node.style.setProperty('visibility', visibility, priority)
    else node.style.removeProperty('visibility')
    node.inert = inert
    if (ariaHidden === null) node.removeAttribute('aria-hidden')
    else node.setAttribute('aria-hidden', ariaHidden)
    current = null
  }
  return {
    apply(node: HTMLElement, hidden: boolean) {
      if (!hidden) { restore(); return }
      if (current?.node === node) return
      restore()
      current = { node, visibility: node.style.getPropertyValue('visibility'), priority: node.style.getPropertyPriority('visibility'), inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') }
      const focused = node.ownerDocument.activeElement
      if (focused instanceof HTMLElement && node.contains(focused)) focused.blur()
      node.style.setProperty('visibility', 'hidden')
      node.inert = true
      node.setAttribute('aria-hidden', 'true')
    },
    restore,
  }
}
