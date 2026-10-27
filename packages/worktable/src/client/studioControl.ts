import { splitStore } from './split'

/** 仅主窗口领取操作，保留发起命令的当前会话和聊天区域。 */
export function installStudioControl(): () => void {
  const params = new URLSearchParams(location.search)
  if (window.parent !== window || /orb|overlay|selection/.test(params.get('surface') ?? '') || /orb|overlay/.test(location.pathname)) return () => {}
  const client = crypto.randomUUID()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const post = async (action: string, body: object = {}) => {
    const response = await fetch('/studio-projects/control/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client, ...body }), signal: controller.signal })
    if (!response.ok) throw new Error('工作室控制服务暂不可用')
    return response.json()
  }
  const communicate = async (frame: HTMLIFrameElement, command: any) => {
    const origin = new URL(frame.src, location.href).origin
    return new Promise((resolve, reject) => {
      let sent = false
      let settled = false
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timeout); clearInterval(probe); clearInterval(activeProbe)
        window.removeEventListener('message', receive); controller.signal.removeEventListener('abort', abort)
        if (error) frame.contentWindow?.postMessage({ type: 'dsh:studio:controlCancel', id: command.id }, origin)
        error ? reject(error) : resolve(result)
      }
      const abort = () => finish(new Error('工作室客户端已停用'))
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== 'dsh:studio:controlResult' || event.data.id !== command.id) return
        if (event.data.ready && !sent) {
          sent = true
          clearInterval(probe)
          void post('active', { id: command.id }).then(state => {
            if (state.active && !controller.signal.aborted) frame.contentWindow?.postMessage({ ...command, type: 'dsh:studio:control' }, origin)
            else finish(new Error('操作已取消或工作室已停用'))
          }).catch(error => finish(error))
        } else if (sent && !event.data.ready) finish(event.data.error ? new Error(event.data.error) : undefined, event.data.result)
      }
      window.addEventListener('message', receive)
      controller.signal.addEventListener('abort', abort, { once: true })
      const ping = () => frame.contentWindow?.postMessage({ type: 'dsh:studio:control', id: command.id, action: 'ping' }, origin)
      const probe = setInterval(ping, 150)
      const activeProbe = setInterval(() => { void post('active', { id: command.id }).then(state => { if (!state.active) finish(new Error('操作已取消或工作室已停用')) }).catch(error => finish(error)) }, 600)
      const timeout = setTimeout(() => finish(new Error('页面响应超时，请重新读取页面确认结果')), Math.max(1, command.expiresAt - Date.now() - 500))
      ping()
    })
  }
  const execute = async (command: any) => {
    const response = await fetch('/studio-projects/control/catalog', { signal: controller.signal })
    if (!response.ok) throw new Error('工作室目录不可用')
    const projects = await response.json()
    const project = projects.find((item: any) => item.id === command.studio)
    if (!project) throw new Error('工作室已停用')
    const id = 'studio-' + project.id
    if (!splitStore.active || splitStore.spec?.id !== id) {
      if (!splitStore.open({ id, title: project.name, icon: project.icon, top: null, main: [{ id: id + '-main', title: project.name, min: 300, content: { kind: 'iframe', url: '/studio-projects/' + project.id, title: project.name } }], chatWidth: { default: 340, min: 260, max: 640 } })) throw new Error('当前页面无法打开工作室，请先进入主窗口会话')
    }
    splitStore.setChatVisible(true)
    const path = '/studio-projects/' + project.id
    while (Date.now() < command.expiresAt - 1000 && !controller.signal.aborted) {
      const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe')].find(item => new URL(item.src, location.href).pathname === path)
      if (frame) return communicate(frame, command)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('工作室页面未挂载')
  }
  const poll = async () => {
    try {
      const { command } = await post('poll')
      if (command) {
        let result
        let error
        try { result = await execute(command) } catch (reason) { error = reason instanceof Error ? reason.message : '工作室操作失败' }
        await post('result', { id: command.id, result, error })
      }
    } catch { /* 服务重载时等待下一次连接。 */ }
    if (!controller.signal.aborted) timer = setTimeout(poll, 800)
  }
  void poll()
  return () => { controller.abort(); clearTimeout(timer) }
}
