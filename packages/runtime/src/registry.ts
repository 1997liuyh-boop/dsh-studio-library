import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 工作室声明的快捷任务：输入框 @ 候选选中后直接带上 text，用户不必再手写需求。 */
export interface StudioTask {
  id: string
  label: string
  description?: string
  text: string
}

export interface StudioPage {
  id: string
  name?: string
  icon?: string
  description?: string
  /** 可选的快捷任务，随目录透出给输入框 @ 候选。 */
  tasks?: readonly StudioTask[]
  root: string
  handle?(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
}
const types: Record<string, string> = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.wasm':'application/wasm', '.xml':'application/xml', '.woff':'font/woff', '.woff2':'font/woff2' }
const idPattern = /^[a-z][a-z0-9-]{0,63}$/

/** 快捷任务的标识、标题与文本必须是非空字符串，标识在同一工作室内唯一。 */
function validateTasks(studio: string, tasks: readonly StudioTask[] | undefined): void {
  if (tasks === undefined) return
  const ids = new Set<string>()
  const valid = Array.isArray(tasks) && tasks.every(task => {
    if (!task || typeof task !== 'object' || !idPattern.test(task.id) || ids.has(task.id)) return false
    ids.add(task.id)
    return typeof task.label === 'string' && task.label.trim() !== '' && typeof task.text === 'string' && task.text.trim() !== '' && (task.description === undefined || typeof task.description === 'string')
  })
  if (!valid) throw new Error('工作室快捷任务无效：' + studio)
}

/** 插件拥有页面与资源；宿主统一执行所有者认证。 */
export class StudioProjects {
  private readonly pages = new Map<string, StudioPage>()
  private readonly watchers = new Set<(event: 'register' | 'unregister', page: StudioPage) => void>()

  /** 登记页面，撤销后不再接收新请求；用户数据由插件独立保存。 */
  register(page: StudioPage): () => void {
    if (!idPattern.test(page.id)) throw new Error('工作室标识无效')
    if (this.pages.has(page.id)) throw new Error('工作室已注册：' + page.id)
    validateTasks(page.id, page.tasks)
    this.pages.set(page.id, page)
    this.notify('register', page)
    return () => { if (this.pages.get(page.id) === page && this.pages.delete(page.id)) this.notify('unregister', page) }
  }

  /**
   * 监听工作室的登记与撤销（安装、启用、更新后重新加载都会触发），返回取消监听的函数。
   * 监听器抛出的错误不影响登记本身。
   */
  watch(listener: (event: 'register' | 'unregister', page: StudioPage) => void): () => void {
    this.watchers.add(listener)
    return () => { this.watchers.delete(listener) }
  }

  private notify(event: 'register' | 'unregister', page: StudioPage): void {
    for (const listener of this.watchers) {
      try { listener(event, page) } catch (error) { console.error('工作室登记监听失败', error instanceof Error ? error.message : 'Error') }
    }
  }

  /** 供共享宿主服务读取已登记插件，路径不会发送给客户端。 */
  entries(): readonly StudioPage[] { return [...this.pages.values()] }

  has(id: string): boolean { return this.pages.has(id) }

  /** 目录项供输入框候选与控制桥读取；快捷任务只保留声明字段，text 原样透出。 */
  list() { return [...this.pages.values()].map(({ id, name, icon, description, tasks }) => ({ id, name: name ?? id, icon: icon ?? '◫', description: description ?? '', tasks: (tasks ?? []).map(task => ({ id: task.id, label: task.label, description: task.description ?? '', text: task.text })) })) }

  /** 仅从已登记目录读取资源，拒绝编码后的路径越界。 */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    let parts: string[]
    try { parts = decodeURIComponent(pathname).slice('/studio-projects/'.length).split('/') }
    catch { res.writeHead(400); res.end(); return }
    const page = this.pages.get(parts[0] ?? '')
    if (!page || parts.some(part => part === '..' || part === '.' || part.includes('\\') || part.includes('\0'))) { res.writeHead(404); res.end(); return }
    const path = parts.slice(1).join('/')
    if (page.handle && await page.handle(req, res, path)) return
    if (!['GET','HEAD'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return }
    const root = resolve(page.root)
    const file = resolve(root, path || 'index.html')
    if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return }
    try {
      let body = await readFile(file)
      if (extname(file) === '.html') {
        const script = '<script src="/studio-projects/control/bridge.js"></script>'
        const html = body.toString('utf8')
        body = Buffer.from(html.includes('</head>') ? html.replace('</head>', script + '</head>') : script + html)
      }
      res.writeHead(200, {'content-type':types[extname(file)] ?? 'application/octet-stream', 'cache-control':'no-store', 'x-content-type-options':'nosniff'})
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR')
      res.writeHead(missing ? 404 : 500); res.end(missing ? '工作室资源不存在' : '工作室资源读取失败')
    }
  }
}
