import type { ISessions, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AssistantBlock, LegacyConversationSlice, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ModelDirectoryResolver } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { StudioModels } from './studioModels'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { dshWorktable: true }
}

interface StudioTool {
  id: string
  name: string
  args?: Record<string, unknown>
  status: 'running' | 'success' | 'error' | 'interrupted'
  result?: string
}
type StudioPart = { id: string; type: 'text' | 'thinking'; content: string } | { id: string; type: 'tool'; tool: StudioTool }
interface StudioMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  parts?: StudioPart[]
  streaming?: boolean
  error?: string
}

function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

function argsOf(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* 流式参数尚未闭合时，等待完整调用再展示。 */ }
  return undefined
}

/**
 * 将公开 Chat 投影转换为文本和工具卡片，不传递宿主配置。
 * @param chat - 已归并的聊天投影。
 * @param running - 会话的真实运行状态。
 * @returns 具有稳定标识的工作台消息。
 */
export function studioMessages(chat: LegacyConversationSlice | undefined, running: boolean): StudioMessage[] {
  if (!chat) return []
  const calls = new Map<string, ToolCallBlock>()
  const remember = (call: ToolCallBlock) => { calls.set(call.callId, call); call.subCalls.forEach(remember) }
  for (const node of chat.nodes) if (node.kind === 'tool-result') remember(node)
  chat.runningCalls.forEach(remember)
  const rendered = new Set<string>()
  const toolPart = (id: string, name: string, raw: string): StudioPart => {
    rendered.add(id)
    const call = calls.get(id)
    const settled = call && 'kind' in call ? call : undefined
    const started = call && 'phase' in call && call.phase === 'start' ? call : undefined
    const args = argsOf(settled ? settled.call?.argsRaw ?? raw : started?.argsRaw ?? raw)
    return { id: 'tool:' + id, type: 'tool', tool: {
      id, name: name || call?.name || id,
      ...(args === undefined ? {} : { args }),
      status: settled ? settled.isError ? 'error' : 'success' : running ? 'running' : 'interrupted',
      ...(settled ? { result: textOf(settled.content) } : {}),
    } }
  }
  const assistant = (id: string, blocks: readonly AssistantBlock[], streaming = false, interrupted = false): StudioMessage => {
    const parts: StudioPart[] = []
    blocks.forEach((block, index) => {
      if (block.kind === 'text' || block.kind === 'reasoning') parts.push({ id: id + ':' + index, type: block.kind === 'text' ? 'text' : 'thinking', content: block.text })
      else if (block.kind === 'tool-call') parts.push(toolPart(block.callId, block.name, block.argsRaw))
    })
    return { id, role: 'assistant', content: parts.flatMap(part => part.type === 'text' ? [part.content] : []).join('\n'), parts, streaming,
      ...(interrupted ? { error: '已停止' } : {}) }
  }
  const messages: StudioMessage[] = []
  for (const node of chat.nodes) {
    if (node.kind === 'user' || node.kind === 'steering') messages.push({ id: 'user:' + node.seq, role: 'user', content: textOf(node.content) })
    else if (node.kind === 'assistant') messages.push(assistant(`assistant:${node.turn}:${node.step}`, node.blocks, false, node.interrupted))
    else if (node.kind === 'tool-result' && !rendered.has(node.callId)) messages.push({ id: 'result:' + node.callId, role: 'assistant', content: '', parts: [toolPart(node.callId, node.name, '')] })
    else if (node.kind === 'turn-error' || node.kind === 'turn-max-tokens') messages.push({ id: 'notice:' + node.seq, role: 'assistant', content: '',
      error: node.kind === 'turn-max-tokens' ? '回复达到长度上限' : node.code === 'INTERRUPTED' ? '已停止' : node.message || node.code || '模型运行失败' })
  }
  if (chat.partial) messages.push(assistant(`assistant:${chat.partial.turn}:${chat.partial.step}`, chat.partial.blocks, running))
  for (const call of chat.runningCalls) if (!rendered.has(call.callId)) messages.push({ id: 'running:' + call.callId, role: 'assistant', content: '', streaming: running,
    parts: [toolPart(call.callId, call.name, call.phase === 'start' ? call.argsRaw : '')] })
  return messages
}

/**
 * 为工作台持有共享会话，释放视图不停止后台任务。
 * @param sessions - 宿主的公开会话服务。
 * @param conversation - 宿主的聊天投影服务。
 * @param models - 会话模型目录服务。
 * @param sessionId - 已由宿主绑定的会话标识。
 * @param publish - 向当前工作台推送展示数据。
 * @returns 释放订阅及会话引用的函数。
 */
export async function observeStudioTranscript(sessions: ISessions, conversation: Pick<UiConversation, 'binding'>, models: Pick<ModelDirectoryResolver, 'directoryFor'>,
  sessionId: string, publish: (state: object) => void, preferences?: Pick<StudioModels, 'mode' | 'subscribe'>): Promise<() => void> {
  const reference = sessions.retain(sessionId as SessionId, { source: 'dshWorktable' })
  const disposers: (() => void)[] = []
  try {
    const { session } = await reference.ready
    const source = conversation.binding(reference.binding).target('chat')
    const directory = models.directoryFor(reference.sessionId)
    let revision = 0
    const update = () => {
      const state: SessionSnapshot = session.getSnapshot()
      const model = directory.store.getSnapshot()
      const selection = model.current
      const item = model.groups.find(group => group.id === selection?.provider)?.models.find(item => item.id === selection?.model)
      const snapshot = source.getSnapshot()
      const turn = snapshot?.timeline.turnOrder.at(-1)
      const reason = turn === undefined ? undefined : snapshot?.timeline.turns.get(turn)?.end?.data.reason.kind
      publish({ revision: ++revision, running: state.running, hasMore: state.hasMore, loadingOlder: state.loadingOlder,
        activity: state.running ? 'running' : reason === 'aborted' ? 'stopped' : reason === 'error' ? 'error' : reason ? 'completed' : 'idle',
        modelLabel: selection ? [item?.name || selection.model, selection.reasoningEffort].filter(Boolean).join(' · ') : '',
        modelMode: preferences?.mode(sessionId) ?? 'system', modelSelection: selection,
        modelGroups: model.groups, modelStatus: model.status, modelError: model.error,
        messages: studioMessages(snapshot?.legacy, state.running),
        error: state.openError?.message || state.promptError?.error.message || state.lastAgentError || undefined })
    }
    disposers.push(source.subscribe(update), session.subscribe(update), directory.store.subscribe(update))
    if (preferences) disposers.push(preferences.subscribe(update))
    await directory.load()
    update()
    return () => { disposers.forEach(dispose => dispose()); reference.release() }
  } catch (error) { disposers.forEach(dispose => dispose()); reference.release(); throw error }
}
