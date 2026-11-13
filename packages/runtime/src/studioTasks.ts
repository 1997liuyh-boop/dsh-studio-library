import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { StudioProjects } from './registry'

/** 参与展开的目录项：工作室标识、显示名与它声明的快捷任务。 */
export interface StudioTaskCatalogEntry { id: string; name: string; tasks: readonly { id: string; label: string; text: string }[] }

/** 消息开头的工作室提及：@工作室:<id>（冒号可全角）或 @<工作室名 / id>。 */
const mentionPattern = /^\s*@(工作室[:：])?([\s\S]*)$/
/** 任务标题之后允许直接结束，或接空白与常见标点，再写链接或补充说明。 */
const labelBoundary = /^(?:$|[\s:：,，;；。])/
const labelSeparators = /^[\s:：,，;；。]+/
/** 工作室名或 id 之后必须是结束、空白或冒号，避免「@设计工作室实现设计稿」这类粘连的写法被误认。 */
const nameBoundary = /^(?:$|[\s:：])/

type StudioTaskEntry = StudioTaskCatalogEntry['tasks'][number]

/** 在文本开头找任务：先按标题（从长到短，避免短标题抢走以它开头的长标题），再按任务 id。 */
function leadingTask(project: StudioTaskCatalogEntry, rest: string): { task: StudioTaskEntry; length: number } | undefined {
  const byLabel = [...project.tasks].sort((a, b) => b.label.length - a.label.length).find(item => rest.startsWith(item.label) && labelBoundary.test(rest.slice(item.label.length)))
  if (byLabel) return { task: byLabel, length: byLabel.label.length }
  const byId = project.tasks.find(item => rest.startsWith(item.id) && labelBoundary.test(rest.slice(item.id.length)))
  return byId ? { task: byId, length: byId.id.length } : undefined
}

/**
 * 把消息开头的「工作室 + 任务」展开成「@工作室:<id> <任务文本>\n[补充]」。支持的写法：
 * - @工作室:<id> <任务标题> [补充]、@<工作室名> <任务标题> [补充]（任务前用空白分隔）
 * - @<工作室名>:<任务标题> [补充]、@工作室:<id>:<任务 id 或标题> [补充]（任务前用冒号，冒号可全角）
 * - 输入框 @ 候选插入的工作室芯片后再接「:任务标题」，即 @工作室:<id> :<任务标题> [补充]
 * 任务可以按标题或 id 匹配；没有补充时只展开任务文本。标题不匹配或工作室未启用时原样返回。
 * @param text 用户消息的文本块。
 * @param projects 当前已启用工作室的目录项。
 * @returns 展开后的文本；无需展开时返回原字符串。
 */
export function expandStudioTask(text: string, projects: readonly StudioTaskCatalogEntry[]): string {
  const match = mentionPattern.exec(text)
  if (!match) return text
  const [, prefix, body] = match
  // 写了「工作室:」前缀时只认 id；否则认工作室名或 id，取最长的匹配，名字之后必须是边界。
  const candidates = projects.flatMap(project => (prefix ? [project.id] : [project.name, project.id]).map(key => ({ project, key })))
  const hit = candidates.filter(({ key }) => body.startsWith(key) && nameBoundary.test(body.slice(key.length))).sort((a, b) => b.key.length - a.key.length)[0]
  if (!hit) return text
  const after = body.slice(hit.key.length)
  // 冒号紧跟工作室名，或空白后再接冒号（芯片后输入「:任务」），都表示后面是任务；纯空白分隔的老写法同样支持。
  const rest = after.replace(/^\s*[:：]/, '').replace(/^\s+/, '')
  const found = leadingTask(hit.project, rest)
  if (!found) return text
  const remainder = rest.slice(found.length).replace(labelSeparators, '').trim()
  return '@工作室:' + hit.project.id + ' ' + found.task.text + (remainder ? '\n' + remainder : '')
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
