import type { StudioModelChoice } from './studioModels'

interface StudioSessionActions {
  isActive(): boolean
  activate(binding: { sessionId: string; directory: string }, showChat: boolean): Promise<void>
  send(sessionId: string, text: string): Promise<void>
  follow(sessionId: string | null): Promise<void>
  onWorkspaceChange(listener: () => void): () => void
  observe(binding: { sessionId: string; directory: string }, publish: (state: object) => void): Promise<() => void>
  stop(sessionId: string): Promise<void>
  older(sessionId: string): Promise<void>
  model(sessionId: string, choice: StudioModelChoice): Promise<void>
  modelSettings(): void
}

/** 每个请求只执行一次；导航期间完成的旧请求不再切换主窗口或浮球。 */
export function installStudioSession(actions: StudioSessionActions): () => void {
  const requests = new Map<string, Promise<object>>()
  const completed = new Set<string>()
  let lifetime = 0
  let currentChannel = ''
  let channelDirectory = ''
  let currentBinding: { sessionId: string; directory: string } | undefined
  let disposeState: (() => void) | undefined
  let queue = Promise.resolve()
  let workspaceActive = actions.isActive()
  const clear = () => {
    lifetime++; currentChannel = ''; channelDirectory = ''; currentBinding = undefined
    disposeState?.(); disposeState = undefined
    void actions.follow(null).catch(() => {})
  }
  const unsubscribe = actions.onWorkspaceChange(() => {
    const active = actions.isActive()
    if (active === workspaceActive) return
    workspaceActive = active
    if (!active) clear()
    else document.querySelector<HTMLIFrameElement>('iframe[src="/studio-projects/media"]')?.contentWindow?.postMessage({ type: 'dsh:studio:resume' }, location.origin)
  })
  const receive = (event: MessageEvent) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src="/studio-projects/media"]')
    const data = event.data
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin || data?.type !== 'dsh:studio:session'
      || typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) return
    if (!['bind', 'send', 'openChat', 'release', 'stop', 'older', 'model', 'modelSettings'].includes(data.action)
      || typeof data.channelId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.channelId)) return
    if (data.action === 'release') {
      if (data.channelId === currentChannel) clear()
      frame.contentWindow?.postMessage({ type: 'dsh:studio:sessionResult', requestId: data.requestId, accepted: true }, location.origin)
      return
    }
    if (data.action === 'bind' && data.channelId !== currentChannel) {
      if (currentChannel) clear()
      currentChannel = data.channelId
      channelDirectory = data.directory
    }
    if (!currentChannel && ['send', 'openChat'].includes(data.action)) { currentChannel = data.channelId; channelDirectory = data.directory }
    const generation = lifetime
    const active = () => generation === lifetime && data.channelId === currentChannel && actions.isActive() && document.contains(frame)
    let result = requests.get(data.requestId)
    if (!result) {
      const operation = async () => {
        try {
          if (!active()) throw new Error('请先打开 AI短剧工作台')
          if (typeof data.directory !== 'string' || data.directory.length > 4096) throw new Error('项目目录无效')
          if (data.directory !== channelDirectory) throw new Error('项目已切换，请重新连接')
          if (data.action === 'model' || data.action === 'modelSettings') {
            if (!currentBinding) throw new Error('会话尚未连接，请重试')
            if (data.action === 'modelSettings') actions.modelSettings()
            else {
              const choice = data.modelChoice
              const selection = choice?.selection
              if (!choice || !['system', 'custom'].includes(choice.mode)
                || (choice.mode === 'custom' && (!selection || typeof selection.provider !== 'string' || !selection.provider || selection.provider.length > 512
                  || typeof selection.model !== 'string' || !selection.model || selection.model.length > 512
                  || (selection.reasoningEffort !== undefined && (typeof selection.reasoningEffort !== 'string' || selection.reasoningEffort.length > 128))))) throw new Error('模型参数无效')
              await actions.model(currentBinding.sessionId, { mode: choice.mode, ...(choice.mode === 'custom' ? { selection: {
                provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
              } } : {}) })
            }
            return { accepted: true, sessionId: currentBinding.sessionId }
          }
          if (data.action === 'send' && (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 100000)) throw new Error('发送内容为空或过长')
          if (data.action === 'stop' || data.action === 'older') {
            if (!currentBinding) throw new Error('会话尚未连接，请重试')
            const id = currentBinding.sessionId
            await (data.action === 'stop' ? actions.stop(id) : actions.older(id))
            return { accepted: true, sessionId: id }
          }
          const response = await fetch('/studio-projects/toonflow/session', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ directory: data.directory, canvasId: data.canvasId }) })
          if (!response.ok) throw new Error('无法绑定项目会话，请确认工作室服务已启动')
          const binding: { sessionId: string; directory: string } = await response.json()
          if (!active()) throw new Error('项目已切换，请重新发送')
          await actions.activate(binding, data.action === 'openChat')
          if (!active()) throw new Error('项目已切换，请重新发送')
          await actions.follow(binding.sessionId)
          if (!active()) { await actions.follow(null); throw new Error('项目已切换，请重新发送') }
          if (!disposeState || currentBinding?.sessionId !== binding.sessionId) {
            disposeState?.(); disposeState = undefined
            const stop = await actions.observe(binding, state => {
              if (active()) frame.contentWindow?.postMessage({ type: 'dsh:studio:state', channelId: data.channelId, directory: binding.directory, sessionId: binding.sessionId, state }, location.origin)
            })
            if (!active()) { stop(); throw new Error('项目已切换，请重新发送') }
            disposeState = stop
          }
          currentBinding = binding
          if (data.action === 'send') await actions.send(binding.sessionId, data.text)
          return { accepted: true, sessionId: binding.sessionId }
        } catch (error) { return { accepted: false, message: error instanceof Error ? error.message : '项目会话暂不可用' } }
      }
      result = queue.then(operation)
      queue = result.then(() => {})
      requests.set(data.requestId, result)
      void result.then(() => {
        completed.add(data.requestId)
        while (completed.size > 128) {
          const first = completed.values().next().value!
          completed.delete(first)
          requests.delete(first)
        }
      })
    }
    void result.then(result => frame.contentWindow?.postMessage({ type: 'dsh:studio:sessionResult', requestId: data.requestId, ...result }, location.origin))
  }
  window.addEventListener('message', receive)
  return () => { clear(); unsubscribe(); window.removeEventListener('message', receive); requests.clear(); completed.clear() }
}
