import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { StudioProjects } from './registry'
import { StudioUpdates, resolveUpdates } from './studioUpdates'
import { updateRoutes } from './updateRoutes'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { createIntegrations, type IntegrationConfig } from './integrations'
import { createToonflowSessions } from './toonflowSessions'
import { readFile } from 'node:fs/promises'
import { installStudioControl, handleStudioImport } from './studioControl'
import { installStudioTasks } from './studioTasks'
import { resolveServiceStartup, startStudioServices } from './serviceStartup'

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
  const updates = new StudioUpdates(registry, ctx.pluginManager, getDshRuntimeVersion(), resolveUpdates(config.updates))
  await updates.initialize()
  const handleUpdates = updateRoutes(updates)
  ctx.effect(() => () => updates.dispose(), '工作室：版本检查与更新记录')
  const statuses = createIntegrations(config)
  const startupConfig = resolveServiceStartup(config.autoStartServices)
  const startupAbort = new AbortController()
  let startup = Promise.resolve<Awaited<ReturnType<typeof startStudioServices>>>([])
  ctx.effect(() => {
    if (process.env.DSH_STUDIO_SKIP_APPS !== '1') startup = startStudioServices(startupConfig, startupAbort.signal)
    return async () => { startupAbort.abort(); await startup }
  }, '工作室：本机服务自动启动')
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
      if (req.method === 'GET' && url.pathname === '/studio-projects/control/status') {
        const failures = await startup
        const integrations = await statuses()
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
        const failures = await startup
        const report = (await statuses()).map(status => ({ ...status,
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
