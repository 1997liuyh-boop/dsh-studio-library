import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface StudioPage {
  id: string
  name?: string
  icon?: string
  description?: string
  root: string
  handle?(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
}
const types: Record<string, string> = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.wasm':'application/wasm', '.xml':'application/xml', '.woff':'font/woff', '.woff2':'font/woff2' }

/** 插件拥有页面与资源；宿主统一执行所有者认证。 */
export class StudioProjects {
  private readonly pages = new Map<string, StudioPage>()

  /** 登记页面，撤销后不再接收新请求；用户数据由插件独立保存。 */
  register(page: StudioPage): () => void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(page.id)) throw new Error('工作室标识无效')
    if (this.pages.has(page.id)) throw new Error('工作室已注册：' + page.id)
    this.pages.set(page.id, page)
    return () => { this.pages.delete(page.id) }
  }

  has(id: string): boolean { return this.pages.has(id) }

  list() { return [...this.pages.values()].map(({ id, name, icon, description }) => ({ id, name: name ?? id, icon: icon ?? '◫', description: description ?? '' })) }

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
