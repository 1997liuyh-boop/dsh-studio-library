/** 更新接口沿用工作室所有者认证，写请求拒绝跨站来源。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StudioUpdates } from './studioUpdates'

/** 返回更新状态；检查与安装只接受已登记工作室和精确版本。 */
export function updateRoutes(updates: StudioUpdates) {
  const send = (res: ServerResponse, status: number, value: object) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(value))
  }
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    if (!['/studio-projects/updates', '/studio-projects/updates/check', '/studio-projects/updates/install'].includes(path)) return false
    try {
      if (path === '/studio-projects/updates' && req.method === 'GET') { send(res, 200, await updates.list()); return true }
      if (path === '/studio-projects/updates' || req.method !== 'POST') { send(res, 405, { error: 'method' }); return true }
      if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['content-type']?.split(';')[0] !== 'application/json') { send(res, 403, { error: 'origin' }); return true }
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 1024) { send(res, 413, { error: 'size' }); return true }; chunks.push(chunk) }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof input !== 'object' || input === null || !('id' in input) || typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.id)) { send(res, 400, { error: 'input' }); return true }
      if (path.endsWith('/check')) await updates.check(input.id)
      else {
        if (!('version' in input) || typeof input.version !== 'string' || input.version.length > 100) { send(res, 400, { error: 'input' }); return true }
        await updates.install(input.id, input.version)
      }
      send(res, 200, await updates.list())
    } catch (error) {
      const code = error instanceof SyntaxError ? 'input' : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'operation'
      send(res, code === 'input' ? 400 : code === 'busy' || code === 'recheck' ? 409 : 503, { error: code })
    }
    return true
  }
}
