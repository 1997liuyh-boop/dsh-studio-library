import { readFile, realpath, mkdir, writeFile, rename } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface ProjectBinding { directory: string; sessionId: string; canvasId?: string }
export interface ToonflowSessionConfig { toonflowDataDirectory?: string; toonflowUrl?: string }
const deniedTools = ['openProject', 'updateSettings', 'appOperation', 'listAppOperations', 'runAgent']
const toolPrefix = 'mcp__Toonflow__'

/** 绑定和连接凭据留在宿主，模型工具始终使用项目自己的真实目录。 */
export async function createToonflowSessions(ctx: Context, config: ToonflowSessionConfig) {
  const dataDirectory = resolve(config.toonflowDataDirectory ?? process.env.DSH_STUDIO_TOONFLOW_DATA ?? '../studio-data/toonflow')
  const file = resolve(dataDirectory, 'dshSessions.json')
  const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  const bindings = new Map<string, ProjectBinding>()
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(saved)) throw new Error('短剧会话绑定格式无效')
    for (const row of saved) {
      if (typeof row?.directory !== 'string' || !isAbsolute(row.directory) || typeof row.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(row.sessionId)) throw new Error('短剧会话绑定格式无效')
      bindings.set(normalize(row.directory), { directory: row.directory, sessionId: row.sessionId })
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let writing = Promise.resolve()
  async function bind(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('绑定参数必须是对象')
    const input = value as { directory?: unknown; canvasId?: unknown; attach?: unknown }
    if (typeof input.directory !== 'string' || !isAbsolute(input.directory) || input.directory.length > 4096) throw new Error('项目工作目录无效')
    const root = await realpath(resolve(dataDirectory, 'workspaces'))
    const directory = await realpath(input.directory)
    const path = relative(root, directory)
    if (path === '..' || path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(path)) throw new Error('只能绑定短剧工作区内的项目')
    const canvasId = typeof input.canvasId === 'string' && input.canvasId.length <= 256 ? input.canvasId : undefined
    const key = normalize(directory)
    const existing = bindings.get(key)
    const binding = existing ?? { directory, sessionId: randomUUID() }
    if (Object.hasOwn(input, 'canvasId')) binding.canvasId = canvasId
    bindings.set(key, binding)
    const snapshot = JSON.stringify([...bindings.values()].map(({ directory, sessionId }) => ({ directory, sessionId })), null, 2)
    const current = writing.catch(() => {}).then(async () => {
      await mkdir(dataDirectory, { recursive: true })
      const temporary = file + '.tmp'
      await writeFile(temporary, snapshot, { mode: 0o600 })
      await rename(temporary, file)
    })
    writing = current
    try { await current } catch (error) { if (!existing && bindings.get(key) === binding) bindings.delete(key); throw error }
    if (input.attach === true) {
      const workspace = await ctx.workspaceRegistry.resolveByPath(directory) ?? await ctx.workspaceRegistry.create(directory)
      await workspace.attachSession(binding.sessionId as SessionId)
    }
    return { ...binding }
  }
  const activeScopes = new Set<ReturnType<typeof createScope>>()
  ctx.effect(() => async () => { await Promise.all([...activeScopes].map(scope => scope.dispose())); activeScopes.clear(); await writing.catch(() => {}) }, '短剧：项目工具生命周期')
  ctx.on('agent/created', async ({ agent }) => {
    const binding = [...bindings.values()].find(row => row.sessionId === agent.id)
    if (!binding) return
    const settings = JSON.parse(await readFile(resolve(dataDirectory, 'settings.json'), 'utf8'))
    const token = settings?.settings?.mcp?.token
    if (settings?.settings?.mcp?.enabled !== true || typeof token !== 'string' || token.length < 32) throw new Error('短剧画布连接未启用，请启动工作室应用服务后重试')
    const url = new URL(config.toonflowUrl ?? process.env.DSH_STUDIO_TOONFLOW_URL ?? 'http://127.0.0.1:33101')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('统一短剧会话只支持本机 Toonflow 服务')
    const scope = createScope(ctx, agent)
    activeScopes.add(scope)
    agent.ctx.effect(() => async () => { activeScopes.delete(scope); await scope.dispose() }, '短剧：会话工具连接')
    try {
      // MCP 工具注册在会话作用域，使用执行守卫拦截独立 Agent 和全局管理操作。
      scope.ctx.tools.guard(execution => execution.name.startsWith(toolPrefix) && deniedTools.includes(execution.name.slice(toolPrefix.length))
        ? '统一会话不使用独立 Agent 或全局管理操作' : undefined)
      scope.ctx.systemPrompt.section({ name: 'studio-project', order: 900, interpolate: false,
        text: () => '你正在与用户协作制作 Toonflow 短剧。当前项目目录：' + binding.directory + '。当前画布：' + (binding.canvasId ?? '请读取应用状态')
          + '。先调用 mcp__Toonflow__getAppState 获取当前页面与工具能力。其他 Toonflow 工具必须携带 target.directory 为上述项目目录，并按返回值填写 target.connectionId 和 target.canvasId。'
          + '通过 Toonflow 工具读取和操作画布、节点、媒体生成；不要直接改写打开中的画布 JSON。文字推理由当前 dsh 模型完成，图片、视频仍使用工作台配置的媒体供应商。生成前确认用户已授权对应生成任务。不要委托另一个 Toonflow Agent。' })
      scope.ctx.on('tools/execute', async (execution, next) => {
        if (!execution.name.startsWith(toolPrefix)) return next()
        if (execution.agent !== agent) throw new Error('短剧工具属于另一个项目会话')
        const name = execution.name.slice(toolPrefix.length)
        if (deniedTools.includes(name)) throw new Error('统一会话不使用独立 Agent 或全局管理操作')
        if (name !== 'getAppState') {
          const args = execution.arguments
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('短剧工具参数必须是对象')
          const target = (args as { target?: { directory?: unknown; canvasId?: unknown } }).target
          // 校验原始工具参数，保证会话日志与实际执行目标完全一致。
          if (typeof target?.directory !== 'string' || normalize(await realpath(target.directory)) !== normalize(binding.directory)) throw new Error('请将 target.directory 指定为当前项目：' + binding.directory)
          if (binding.canvasId && target.canvasId && target.canvasId !== binding.canvasId) throw new Error('当前画布已切换，请重新读取应用状态')
        }
        return next()
      })
      await scope.ctx.plugin(McpClient, McpClient.Config({ transport: 'streamable-http', serverName: 'Toonflow', url: new URL('/mcp', url).href,
        headers: { Authorization: 'Bearer ' + token }, toolCallTimeoutMs: 120000, failOnStartupError: true }))
    } catch (error) { activeScopes.delete(scope); await scope.dispose(); throw error }
  })
  return { bind }
}
