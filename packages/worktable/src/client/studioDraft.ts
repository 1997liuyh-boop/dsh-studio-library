/** 新建工作室会话：模板、功能名称解析、首条用户消息监听。 */

/** 工作区标题的最大长度，避免侧栏被超长功能描述撑开。 */
const TITLE_LIMIT = 40

/** 预填到新会话输入框的工作室需求模板，由用户补全后发送。 */
export function buildStudioDraftPrompt(labels: { intro: string; feature: string; path: string }): string {
  return [labels.intro, labels.feature, labels.path].join('\n')
}

/**
 * 从用户发出的首条消息中提取工作室功能名称。
 * @param text - 用户消息全文。
 * @param featureLabel - 模板中「工作室功能是：」这一行的前缀。
 * @returns 适合作为工作区标题的名称；用户未填写功能时返回空串。
 */
export function studioFeatureName(text: string, featureLabel: string): string {
  const label = featureLabel.replace(/[：:]\s*$/, '')
  const lines = String(text ?? '').split(/\r?\n/)
  for (const line of lines) {
    const index = line.indexOf(label)
    if (index < 0) continue
    const value = line.slice(index + label.length).replace(/^\s*[：:]\s*/, '').trim()
    return clip(value)
  }
  return ''
}

/** 截断并清理标题中的首尾标点。 */
function clip(value: string): string {
  const clean = value.replace(/^[「『"'“]+|[」』"'”。.;；]+$/g, '').trim()
  return clean.length > TITLE_LIMIT ? clean.slice(0, TITLE_LIMIT) + '…' : clean
}

/** 本地时间戳目录名片段，例如 20261111-153012。 */
export function draftStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
}

/** 从聊天投影中取首条用户消息文本。 */
function firstUserText(snapshot: any): string {
  const nodes = snapshot?.legacy?.nodes
  if (!Array.isArray(nodes)) return ''
  for (const node of nodes) {
    if (node?.kind !== 'user') continue
    const blocks = Array.isArray(node.content) ? node.content : []
    return blocks.filter((block: any) => block?.type === 'text').map((block: any) => block.text ?? '').join('\n')
  }
  return ''
}

/**
 * 等待会话出现首条用户消息后回调一次，随后自动释放订阅。
 * @param sessions - 宿主会话服务（需支持 retain）。
 * @param conversation - 宿主聊天投影服务（需支持 binding）。
 * @param sessionId - 目标会话。
 * @param onText - 收到首条用户消息时的回调。
 * @param timeoutMs - 超时自动放弃监听，默认 2 小时。
 * @returns 手动释放监听的函数。
 */
export async function watchFirstUserMessage(sessions: any, conversation: any, sessionId: string, onText: (text: string) => void, timeoutMs = 2 * 60 * 60 * 1000): Promise<() => void> {
  if (typeof sessions?.retain !== 'function' || typeof conversation?.binding !== 'function') throw new Error('会话服务尚未就绪')
  const reference = sessions.retain(sessionId, { source: 'dshWorktable' })
  let done = false
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const dispose = () => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    try { unsubscribe?.() } catch {}
    try { reference.release() } catch {}
  }
  try {
    await reference.ready
    if (done) return dispose
    const source = conversation.binding(reference.binding).target('chat')
    const check = () => {
      if (done) return
      const text = firstUserText(source.getSnapshot())
      if (!text.trim()) return
      dispose()
      onText(text)
    }
    unsubscribe = source.subscribe(check)
    timer = setTimeout(dispose, timeoutMs)
    check()
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
