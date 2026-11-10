import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { StudioProjects } from './registry'

/** 参与展开的目录项：工作室标识、显示名与它声明的快捷任务。 */
export interface StudioTaskCatalogEntry { id: string; name: string; tasks: readonly { id: string; label: string; text: string }[] }

/** 消息开头的工作室提及：@工作室:<id>（冒号可全角）或 @<工作室名>，后面至少一个空白再接任务标题。 */
const mentionPattern = /^\s*@(工作室[:：])?(\S+)\s+([\s\S]*)$/
/** 任务标题之后允许直接结束，或接空白与常见标点，再写链接或补充说明。 */
const labelBoundary = /^(?:$|[\s:：,，;；。])/
const labelSeparators = /^[\s:：,，;；。]+/

/**
 * 把「@工作室:<id> <任务标题> [补充]」展开成「@工作室:<id> <任务文本>\n[补充]」。
 * 提及既可以写 @工作室:<id>，也可以写 @<工作室名>；展开后统一写成 @工作室:<id>。标题不匹配或工作室未启用时原样返回。
 * @param text 用户消息的文本块。
 * @param projects 当前已启用工作室的目录项。
 * @returns 展开后的文本；无需展开时返回原字符串。
 */
export function expandStudioTask(text: string, projects: readonly StudioTaskCatalogEntry[]): string {
  const match = mentionPattern.exec(text)
  if (!match) return text
  const [, prefix, target, rest] = match
  const project = projects.find(item => prefix ? item.id === target : item.name === target || item.id === target)
  if (!project) return text
  // 标题按长度从长到短匹配，避免短标题抢走以它开头的长标题。
  const task = [...project.tasks].sort((a, b) => b.label.length - a.label.length).find(item => rest.startsWith(item.label) && labelBoundary.test(rest.slice(item.label.length)))
  if (!task) return text
  const remainder = rest.slice(task.label.length).replace(labelSeparators, '').trim()
  return '@工作室:' + project.id + ' ' + task.text + (remainder ? '\n' + remainder : '')
}

/** 与宿主 freezeMessage 一致：复制后逐层冻结，避免下游改动共享对象。 */
function freeze<T>(value: T): T {
  const copy = structuredClone(value)
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Object.isFrozen(node)) return
    Object.freeze(node)
    for (const child of Object.values(node)) walk(child)
  }
  walk(copy)
  return copy
}

/**
 * 只改用户直接输入的消息里以工作室提及开头的文本块；其余消息与内容块原样保留。
 * @param message 进入本步的消息。
 * @param projects 当前已启用工作室的目录项。
 * @returns 展开后的新消息（保留原 id），或原消息本身。
 */
export function expandStudioMessage(message: UserMessage, projects: readonly StudioTaskCatalogEntry[]): UserMessage {
  if (message.source.kind !== 'user') return message
  let changed = false
  const content = message.content.map((block): ContentBlock => {
    if (block.type !== 'text') return block
    const text = expandStudioTask(block.text, projects)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? freeze({ ...message, content }) : message
}

/** 进入模型前把消息开头的快捷任务标题替换成工作室声明的任务文本；目录里没有快捷任务时直接放行。 */
export function installStudioTasks(ctx: Pick<Context, 'on'> & { effect(callback: () => () => void, label: string): void }, registry: Pick<StudioProjects, 'list'>): void {
  ctx.effect(() => ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const projects = registry.list().filter(project => project.tasks.length > 0)
    if (projects.length === 0) return decision
    return { ...decision, messages: decision.messages.map(message => expandStudioMessage(message, projects)) }
  }, { prepend: true }), '工作室：展开消息开头的快捷任务')
}
