/** 工作室页面控制协议：只操作真实控件，不接收任意脚本或选择器。 */
(() => {
  if (window.parent === window || (window as any).__dshStudioControl) return
  ;(window as any).__dshStudioControl = true
  const requestType = 'dsh:studio:control'
  const resultType = 'dsh:studio:controlResult'
  const controls = new Map<string, HTMLElement>()
  const seen = new Set<string>()
  const cancelled = new Set<string>()
  const allowedParents = new Set([location.origin, 'dsh-app://app'])
  const isLocal = (url: URL) => ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  // 开发网页只接受明确的本机宿主；其他网站不能通过嵌入页面取得控制权。
  try { const parent = new URL(document.referrer); if (isLocal(parent) && parent.port === '5173') allowedParents.add(parent.origin) } catch {}
  const redact = (value: string) => value.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[凭据已隐藏]').replace(/\b(?:sk-[\w-]+|[a-f0-9]{24,})\b/gi, '[凭据已隐藏]').slice(0, 12000)
  const visible = (node: HTMLElement) => {
    if (node.closest('[hidden],[inert],[aria-hidden="true"]')) return false
    if (getComputedStyle(node).pointerEvents === 'none') return false
    for (let item: HTMLElement | null = node; item; item = item.parentElement) {
      const style = getComputedStyle(item)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    }
    return node.getClientRects().length > 0
  }
  const label = (node: HTMLElement) => {
    const labelled = node.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
    const field = node as HTMLInputElement
    return (node.getAttribute('aria-label') || labelled || field.labels?.[0]?.textContent || node.getAttribute('placeholder') || node.getAttribute('title') || node.innerText || node.textContent || field.name || '').trim().replace(/\s+/g, ' ').slice(0, 180)
  }
  const sensitive = (node: HTMLElement) => node.matches('input[type="password"],input[type="file"]') || /密码|密钥|令牌|secret|token|api.?key|password/i.test(label(node) + ' ' + (node as HTMLInputElement).name + ' ' + node.id)
  let generation = 0
  const pageId = crypto.randomUUID().slice(0, 8)
  function snapshot(offset = 0) {
    controls.clear()
    generation += 1
    const nodes = [...document.querySelectorAll<HTMLElement>('button,a[href],input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="tab"],[role="checkbox"],[contenteditable="true"],[tabindex]')].filter(visible)
    const entries = nodes.slice(offset, offset + 100).map((node, index) => {
      const id = pageId + '-c' + generation + '-' + (offset + index)
      controls.set(id, node)
      const input = node as HTMLInputElement
      const secret = sensitive(node)
      return { id, tag: node.tagName.toLowerCase(), label: redact(label(node)), type: input.type || node.getAttribute('role') || undefined,
        disabled: node.matches(':disabled,[aria-disabled="true"]'), sensitive: secret || undefined,
        value: !secret && node.matches('input,textarea,select') ? redact(input.value) : undefined,
        checked: node.matches('input[type="checkbox"],input[type="radio"]') ? input.checked : undefined,
        selected: node.getAttribute('aria-pressed') ?? node.getAttribute('aria-selected') ?? (node.classList.contains('is-active') ? 'true' : undefined),
        options: node instanceof HTMLSelectElement ? [...node.options].slice(0, 80).map(option => ({ value: option.value, label: redact(option.text), disabled: option.disabled })) : undefined }
    })
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const text: string[] = []
    let length = 0
    while (walker.nextNode() && length < 12000) {
      const parent = walker.currentNode.parentElement
      if (!parent || parent.closest('script,style,noscript,input,textarea,[data-sensitive]') || !visible(parent)) continue
      const value = walker.currentNode.textContent?.trim()
      if (value) { text.push(value); length += value.length }
    }
    const result = { title: document.title, path: location.pathname, text: redact(text.join('\n')), controls: entries, totalControls: nodes.length, nextOffset: offset + entries.length < nodes.length ? offset + entries.length : null }
    while (JSON.stringify(result).length > 48000 && entries.length > 1) entries.pop()
    result.nextOffset = offset + entries.length < nodes.length ? offset + entries.length : null
    return result
  }
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  async function perform(command: any) {
    if (command.action === 'open' || command.action === 'read') return snapshot(command.offset ?? 0)
    const node = command.target ? controls.get(command.target) : undefined
    if (command.target && (!node?.isConnected || !visible(node))) throw new Error('页面已变化，请重新 read 获取控件')
    if (node?.matches(':disabled,[aria-disabled="true"]')) throw new Error('控件当前不可用')
    if (node && sensitive(node)) throw new Error('敏感设置请由用户在页面中操作')
    if (command.action === 'scroll') {
      const horizontal = ['left', 'right'].includes(command.direction)
      let container = node ?? (document.elementFromPoint(innerWidth / 2, innerHeight / 2) as HTMLElement | null)
      while (container && !(horizontal ? container.scrollWidth > container.clientWidth : container.scrollHeight > container.clientHeight)) container = container.parentElement
      container ??= document.scrollingElement as HTMLElement
      const amount = ['up', 'left'].includes(command.direction) ? -480 : 480
      container.scrollBy({ [horizontal ? 'left' : 'top']: amount, behavior: 'instant' })
    } else {
      if (!node) throw new Error('请提供最近 read 返回的控件 id')
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      node.focus({ preventScroll: true })
      if (command.action === 'click') {
        if (node instanceof HTMLAnchorElement && !['http:', 'https:', 'dsh-app:'].includes(new URL(node.href).protocol)) throw new Error('不支持此链接类型')
        node.click()
      } else if (command.action === 'fill') {
        if (typeof command.value !== 'string' || command.value.length > 8000) throw new Error('输入内容无效')
        if (node.matches('input:not([type="checkbox"]):not([type="radio"]),textarea') && !(node as HTMLInputElement).readOnly) {
          const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, command.value)
          node.dispatchEvent(new Event('input', { bubbles: true }))
          node.dispatchEvent(new Event('change', { bubbles: true }))
        } else if (node.isContentEditable) {
          node.textContent = command.value
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command.value }))
        } else throw new Error('该控件不能填写，请使用 click 或 select')
      } else if (command.action === 'select' && node instanceof HTMLSelectElement) {
        if (![...node.options].some(option => option.value === command.value && !option.disabled)) throw new Error('选项不存在或不可用')
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(node, command.value)
        node.dispatchEvent(new Event('input', { bubbles: true }))
        node.dispatchEvent(new Event('change', { bubbles: true }))
      } else throw new Error('不支持此控件操作')
    }
    await delay(250)
    return snapshot()
  }
  let busy = false
  window.addEventListener('message', async event => {
    const data = event.data
    if (event.source !== window.parent || !allowedParents.has(event.origin) || ![requestType, 'dsh:studio:controlCancel'].includes(data?.type) || typeof data.id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.id)) return
    if (data.type === 'dsh:studio:controlCancel') {
      if (cancelled.size >= 128) cancelled.delete(cancelled.values().next().value!)
      cancelled.add(data.id)
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-studio-app]')
      if (frame && isLocal(new URL(frame.src))) frame.contentWindow?.postMessage(data, new URL(frame.src).origin)
      return
    }
    const reply = (body: object) => window.parent.postMessage({ type: resultType, id: data.id, ...body }, event.origin)
    if (data.action === 'ping') { reply({ ready: true }); return }
    if (seen.has(data.id)) { reply({ error: '操作已接收，请重新读取页面，不要重复提交' }); return }
    if (busy) { reply({ error: '页面正在执行另一个操作' }); return }
    if (cancelled.has(data.id) || !Number.isFinite(data.expiresAt) || data.expiresAt < Date.now()) { reply({ error: '操作已取消或过期' }); return }
    if (seen.size >= 128) seen.delete(seen.values().next().value!)
    seen.add(data.id)
    busy = true
    try {
      const deadline = Math.min(data.expiresAt - 1000, Date.now() + 10000)
      const loading = () => document.readyState === 'loading' || document.querySelector('[data-studio-loading="true"]') || [...document.querySelectorAll('#root,#app')].some(root => !root.children.length)
      while (loading() && Date.now() < deadline && !cancelled.has(data.id)) await delay(100)
      if (cancelled.has(data.id) || data.expiresAt < Date.now()) throw new Error('操作已取消或过期')
      if (loading()) throw new Error('页面仍在加载，请稍后重新 read')
      const child = document.querySelector<HTMLIFrameElement>('iframe[data-studio-app]')
      if (child) {
        const origin = new URL(child.src, location.href).origin
        if (!isLocal(new URL(origin))) throw new Error('工作室控制仅支持本机应用')
        const forwarded = await new Promise((resolve, reject) => {
          let sent = false
          const finish = (error?: Error, result?: unknown) => { clearInterval(probe); clearTimeout(timer); window.removeEventListener('message', receive); error ? reject(error) : resolve(result) }
          const receive = (message: MessageEvent) => {
            if (message.source !== child.contentWindow || message.origin !== origin || message.data?.type !== resultType || message.data.id !== data.id) return
            if (message.data.ready && !sent) {
              if (cancelled.has(data.id) || data.expiresAt < Date.now()) { finish(new Error('操作已取消或过期')); return }
              sent = true; clearInterval(probe); child.contentWindow?.postMessage(data, origin)
            }
            else if (sent && !message.data.ready) finish(undefined, message.data)
          }
          window.addEventListener('message', receive)
          const ping = () => child.contentWindow?.postMessage({ ...data, action: 'ping' }, origin)
          const probe = setInterval(ping, 150)
          const timer = setTimeout(() => finish(new Error(sent ? '应用响应超时，请重新读取页面确认结果' : '应用尚未就绪或未安装控制桥')), Math.max(1, Math.min(18000, data.expiresAt - Date.now())))
          ping()
        })
        window.parent.postMessage(forwarded, event.origin)
      } else reply({ result: await perform(data) })
    } catch (error) { reply({ error: error instanceof Error ? error.message : '工作室操作失败' }) }
    finally { busy = false }
  })
})()
