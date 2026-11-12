import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { StudioProjects } from './registry'
import { StudioUpdates, resolveUpdates } from './studioUpdates'
import { updateRoutes } from './updateRoutes'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { cineflowDataDirectory, createIntegrations, type IntegrationConfig } from './integrations'
import { createToonflowSessions } from './toonflowSessions'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { installStudioControl, handleStudioImport } from './studioControl'
import { studioCatalog } from './studioCatalog'
import { installStudioTasks } from './studioTasks'
import { resolveServiceStartup, ServiceNotConfigured, StudioServiceLauncher, type ServiceStartupFailure } from './serviceStartup'
import { cineflowService, ManagedStudioServices, nodePlatform } from './managedServices'

interface HostContext {
  provide(name: string, value: StudioProjects): void
  effect(callback: () => () => void | Promise<void>, label: string): void
  connection: { admit(req: IncomingMessage): { rejection: number } | { peer: { principal: { kind: string } } } }
  webServer: { register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void }
}
export const name = 'dsh-studio-projects'
export const inject = ['webServer', 'connection', 'tools', 'agents', 'systemPrompt', 'workspaceRegistry', 'pluginManager']

/** 共享认证与会话服务；页面通过独立工作室插件注册。 */
export async function apply(ctx: HostContext & Context, config: IntegrationConfig = {}): Promise<void> {
  const registry = new StudioProjects()
  ctx.provide('studioProjects', registry)
  const startupConfig = resolveServiceStartup(config.autoStartServices)
  // 宿主启动时、「一键启动」与更新时的停/启共用同一启动器，同一启动组不会并行重复拉起
  const launcher = new StudioServiceLauncher(startupConfig)
  // 随包服务（影音）：无需配置，由运行时从独立副本直接拉起；显式写了启动组的工作室仍按配置执行
  if (config.electronPath !== undefined && (typeof config.electronPath !== 'string' || !isAbsolute(config.electronPath))) throw new Error('工作室 electronPath 必须是绝对路径')
  const managed = new ManagedStudioServices([cineflowService(cineflowDataDirectory(config))], nodePlatform(config.electronPath))
  const autoStart = process.env.DSH_STUDIO_SKIP_APPS !== '1'
  // 更新前停止在安装目录内运行的服务（Windows 上运行中的目录无法被替换），装完再重启；随包服务不占用安装目录，装完只需切换到新版本
  const updates = new StudioUpdates(registry, ctx.pluginManager, getDshRuntimeVersion(), resolveUpdates(config.updates), fetch, {
    stopForUpdate: (studioId, directory) => launcher.stopForUpdate(studioId, directory),
    restart: groups => launcher.restart(groups),
    refresh: async studioId => { if (autoStart) await managed.ensure(studioId, { force: true }) },
  })
  await updates.initialize()
  const handleUpdates = updateRoutes(updates)
  ctx.effect(() => () => updates.dispose(), '工作室：版本检查与更新记录')
  const statuses = createIntegrations(config)
  let startup = Promise.resolve<ServiceStartupFailure[]>([])
  ctx.effect(() => {
    if (autoStart) startup = launcher.start()
    return async () => { await launcher.dispose(); await startup.catch(() => []) }
  }, '工作室：本机服务自动启动')
  ctx.effect(() => {
    // 工作室一登记（安装、启用、更新后重新加载）就启动或切换它的随包服务，不必重启桌面
    const attach = (id: string, root: string) => {
      if (launcher.startable(id) || !managed.attach(id, dirname(resolve(root))) || !autoStart) return
      void managed.ensure(id)
    }
    for (const page of registry.entries()) attach(page.id, page.root)
    const unwatch = registry.watch((event, page) => { if (event === 'register') attach(page.id, page.root); else managed.detach(page.id) })
    return async () => { unwatch(); await managed.dispose() }
  }, '工作室：随包服务自动启动')
  /** 配置的启动组与随包服务的最近失败记录。 */
  const serviceFailures = () => [...launcher.report(), ...managed.report()]
  /** 连接状态；未就绪的随包服务先尝试拉起（「重新连接」即自动重试），再读取真实健康状态。 */
  const connectedStatuses = async () => {
    await startup
    const current = await statuses()
    const pending = autoStart ? current.filter(status => !status.ready && managed.has(status.id)) : []
    if (!pending.length) return current
    await Promise.all(pending.map(status => managed.ensure(status.id)))
    return statuses()
  }
  /** 控制台服务面板：是否可一键启动、是否正在启动及失败原因。 */
  const serviceStates = async (failures: readonly ServiceStartupFailure[]) => (await statuses()).map(status => ({ id: status.id, title: status.title, ready: status.ready,
    startable: launcher.startable(status.id) || managed.has(status.id), starting: launcher.starting(status.id) || managed.starting(status.id),
    error: status.ready ? undefined : failures.find(failure => failure.studioIds.includes(status.id))?.message }))
  const toonflow = await createToonflowSessions(ctx, config)
  const control = installStudioControl(ctx, registry, ctx.pluginManager)
  installStudioTasks(ctx, registry)
  ctx.effect(() => ctx.webServer.register({kind:'prefix',path:'/studio-projects',async handler(req,res) {
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') { res.writeHead('rejection' in admission ? admission.rejection : 403); res.end(); return }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    try {
      if (req.method === 'GET' && url.pathname === '/studio-projects/control/catalog') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(registry.list())); return
      }
      // 依赖本机服务的工作室：连接状态、是否可一键启动、是否正在启动（不等待开机启动完成）
      if (req.method === 'GET' && url.pathname === '/studio-projects/control/services') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ services: await serviceStates(serviceFailures()) })); return
      }
      // 一键启动：body { studio?: string }，不传则启动全部已配置的启动组
      if (url.pathname === '/studio-projects/control/start') {
        const send = (code: number, value: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
        if (req.method !== 'POST') { send(405, { error: '仅支持 POST' }); return }
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['content-type']?.split(';')[0] !== 'application/json') { send(403, { error: '请求来源无效' }); return }
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 1024) { send(413, { error: '请求过大' }); return } chunks.push(chunk) }
        let studio: string | undefined
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          if (input?.studio !== undefined && (typeof input.studio !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.studio))) throw new SyntaxError('studio')
          studio = input?.studio
        } catch { send(400, { error: '参数无效' }); return }
        try {
          // 显式配置的启动组优先；其余工作室使用随包服务，用户主动点击时不受失败冷却限制
          let failures: ServiceStartupFailure[]
          if (studio === undefined) failures = [...await launcher.start(), ...await managed.ensureAll({ force: true })]
          else if (!launcher.startable(studio) && managed.has(studio)) { const failure = await managed.ensure(studio, { force: true }); failures = failure ? [failure] : [] }
          else failures = await launcher.start(studio)
          send(200, { failures, services: await serviceStates(failures) })
        } catch (error) {
          if (error instanceof ServiceNotConfigured) { send(404, { error: error.message }); return }
          throw error
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/studio-projects/control/studios') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ studios: await studioCatalog(registry.entries()) })); return
      }
      if (req.method === 'GET' && url.pathname === '/studio-projects/control/status') {
        const integrations = await connectedStatuses()
        const failures = serviceFailures()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          studios: registry.list().map(studio => ({
            ...studio,
            source: 'local',
            localPath: registry.entries().find(entry => entry.id === studio.id)?.root,
          })),
          integrations: integrations.map(status => ({ ...status, startupError: status.ready ? undefined : failures.find(failure => failure.studioIds.includes(status.id))?.message })),
          serviceFailures: failures,
        }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/studio-projects/control/bridge.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(await readFile(new URL('../static/controlBridge.js', import.meta.url))); return
      }
      if (await handleUpdates(req, res, url.pathname)) return
      if (url.pathname === '/studio-projects/import') { await handleStudioImport(req, res, ctx.pluginManager); return }
      if (await control.handle(req, res, url.pathname)) return
      const legacyId=url.pathname.split('/')[2] ?? ''
      const legacyPage=url.searchParams.has('legacy') && ['travel','knowledge','media','fitness'].includes(legacyId) && registry.has(legacyId)
      const legacyAsset=url.pathname === '/studio-projects/legacy/app.js' ? 'app.js' : url.pathname === '/studio-projects/legacy/app.css' ? 'app.css' : undefined
      if (legacyPage || legacyAsset) {
        if (!['GET','HEAD'].includes(req.method ?? '')) {res.writeHead(405);res.end();return}
        const file=legacyAsset ?? 'index.html'
        const body=await readFile(new URL('../static/legacy/'+file,import.meta.url))
        res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'})
        res.end(req.method === 'HEAD' ? undefined : body);return
      }
      if (url.pathname === '/studio-projects/integrations' && req.method === 'GET') {
        const current = await connectedStatuses()
        const failures = serviceFailures()
        const report = current.map(status => ({ ...status,
          startupError: status.ready ? undefined : failures.find(failure => failure.studioIds.includes(status.id))?.message }))
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(report)); return
      }
      if (url.pathname === '/studio-projects/toonflow/session') {
        if (!registry.has('media')) {res.writeHead(404);res.end();return}
        if (req.method !== 'POST') {res.writeHead(405);res.end();return}
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['content-type']?.split(';')[0] !== 'application/json') {res.writeHead(403);res.end();return}
        const chunks: Buffer[] = []; let length = 0
        for await (const chunk of req) { length += chunk.length; if (length > 8192) {res.writeHead(413);res.end();return} chunks.push(chunk) }
        const result = await toonflow.bind(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result));return
      }
      await registry.handle(req,res,url.pathname)
    } catch (error) {
      const invalid = error instanceof SyntaxError || (error instanceof Error && /目录无效|只能绑定|参数必须/.test(error.message))
      res.writeHead(invalid ? 400 : 503,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(invalid ? '项目参数无效，请重新打开。' : '工作室服务暂不可用，请检查本机服务与数据权限。')
    }
  }}),'工作库：所有者页面与会话接口')
}
