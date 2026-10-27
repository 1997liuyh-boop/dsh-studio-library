interface DiscussionActions {
  append(text: string): boolean
  showChat(): void
  isActive(): boolean
  unavailable(): string
}

/** 只接收当前短剧工作台直属页面的主动协作请求，保留已有宿主草稿。 */
export function installStudioDiscussion(actions: DiscussionActions): () => void {
  const results = new Map<string, { accepted: boolean; message: string }>()
  const receive = (event: MessageEvent) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src="/studio-projects/media"]')
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return
    const data = event.data
    if (data?.type !== 'dsh:studio:discuss' || typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) return
    let result = results.get(data.requestId)
    if (!result) {
      const accepted = actions.isActive() && typeof data.text === 'string' && data.text.trim().length > 0 && data.text.length <= 100000 && actions.append(data.text)
      result = { accepted, message: accepted ? '' : actions.unavailable() }
      results.set(data.requestId, result)
      if (results.size > 64) results.delete(results.keys().next().value!)
      if (accepted) actions.showChat()
    }
    frame.contentWindow?.postMessage({ type: 'dsh:studio:discussionResult', requestId: data.requestId, ...result }, location.origin)
  }
  window.addEventListener('message', receive)
  return () => { window.removeEventListener('message', receive); results.clear() }
}
