import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
export interface IntegrationConfig { toonflowUrl?: string; printfilmUrl?: string; toonflowDataDirectory?: string; cineflowDataDirectory?: string }
interface Integration { id: 'media' | 'film'; title: string; url: string; source: string; marker: RegExp }

/** 应用地址由宿主配置或环境变量指定，不接受浏览器传入任意代理地址。 */
export function createIntegrations(config: IntegrationConfig = {}) {
  const definitions: Integration[] = [
    { id: 'media', title: 'AI短剧工作台', url: config.toonflowUrl ?? process.env.DSH_STUDIO_TOONFLOW_URL ?? 'http://127.0.0.1:33101', source: 'https://github.com/HBAI-Ltd/Toonflow-app', marker: /toonflow/i },
    { id: 'film', title: 'AI剧工作台', url: config.printfilmUrl ?? process.env.DSH_STUDIO_PRINTFILM_URL ?? 'http://127.0.0.1:33102', source: 'https://github.com/yi1108/printfilm', marker: /printfilm/i },
  ]
  for (const definition of definitions) {
    const url = new URL(definition.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('工作室应用地址必须为不含凭据、查询参数和路径的 HTTP(S) 来源地址。')
    definition.url = url.origin
  }
  return async function statuses() {
    const existing = await Promise.all(definitions.map(async ({ marker, ...definition }) => {
      try {
        const response = await fetch(definition.url, { signal: AbortSignal.timeout(2500), redirect: 'error' })
        const ready = response.ok && marker.test((await response.text()).slice(0, 100000))
        return { ...definition, ready, entryUrl: definition.url + (definition.id === 'film' ? '/drama?embed=studio' : '/?embed=studio#/home') }
      } catch (error) { return { ...definition, ready: false, entryUrl: definition.url + (definition.id === 'film' ? '/drama?embed=studio' : '/?embed=studio#/home') } }
    }))
    try {
      const data = config.cineflowDataDirectory ?? process.env.DSH_STUDIO_CINEFLOW_DATA ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'studio/cineflow')
      const descriptor = JSON.parse(await readFile(join(data,'bridge.json'),'utf8'))
      const url = new URL(descriptor.origin)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error('影音连接配置无效')
      const response = await fetch(url.origin+'/health',{signal:AbortSignal.timeout(2500),redirect:'error'})
      const ready=response.ok && (await response.json()).studio === true
      return [...existing,{id:'cineflow',title:'影音工作室',url:url.origin,entryUrl:url.origin+'/#bridge='+descriptor.token,source:'https://github.com/incldue/CineFlow',ready}]
    } catch (error) {
      return [...existing,{id:'cineflow',title:'影音工作室',url:'http://127.0.0.1:33105',entryUrl:'',source:'https://github.com/incldue/CineFlow',ready:false}]
    }
  }
}
