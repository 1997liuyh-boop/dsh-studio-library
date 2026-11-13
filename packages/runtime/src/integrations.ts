import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ServiceStartupConfig } from './serviceStartup'
import type { UpdateConfig } from './studioUpdates'
/**
 * electronPath：随包服务（影音）使用的 Electron 程序；省略时自动查找 DSH_STUDIO_ELECTRON 与 DSH_HOME/electron。
 * bunPath：随包服务（短剧）使用的 Bun 程序；省略时自动查找 DSH_STUDIO_BUN 与工作室包安装的 Bun。
 * printfilmService：剧工作室的本机目录（应用、专用运行时、数据），配置后由运行时直接拉起整套服务。
 */
export interface IntegrationConfig { updates?: UpdateConfig; toonflowUrl?: string; printfilmUrl?: string; toonflowDataDirectory?: string; cineflowDataDirectory?: string; autoStartServices?: ServiceStartupConfig[]; electronPath?: string; bunPath?: string; printfilmService?: unknown }
interface Integration { id: 'media' | 'film'; title: string; url: string; source: string; marker: RegExp }

/** 影音工作室数据目录：连接信息、日志与运行副本都在其中；状态检查与服务启动共用同一位置。 */
export function cineflowDataDirectory(config: IntegrationConfig = {}): string {
  return config.cineflowDataDirectory ?? process.env.DSH_STUDIO_CINEFLOW_DATA ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'studio/cineflow')
}

/** DSH 数据根目录。 */
const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * 短剧工作室（Toonflow）数据目录：数据库、素材与工作区；服务启动与会话绑定共用同一位置。
 * 没有显式配置时，开发布局沿用宿主工作目录旁的 studio-data/toonflow（已有数据不搬家），否则落到 DSH 数据目录。
 */
export function toonflowDataDirectory(config: IntegrationConfig = {}, exists: (path: string) => boolean = existsSync): string {
  const configured = config.toonflowDataDirectory ?? process.env.DSH_STUDIO_TOONFLOW_DATA
  if (configured) return resolve(configured)
  const legacy = resolve('../studio-data/toonflow')
  return exists(legacy) ? legacy : join(dshHome(), 'studio', 'toonflow')
}

/** 短剧随包服务的运行副本、进程记录与日志目录：与应用数据分开，清理运行副本不会碰到用户数据。 */
export function toonflowStateDirectory(): string {
  return join(dshHome(), 'studio', 'media')
}

/** 短剧与剧的服务地址：宿主配置优先，其次环境变量，最后是默认的本机端口。 */
export function integrationUrls(config: IntegrationConfig = {}): { media: string; film: string } {
  return {
    media: config.toonflowUrl ?? process.env.DSH_STUDIO_TOONFLOW_URL ?? 'http://127.0.0.1:33101',
    film: config.printfilmUrl ?? process.env.DSH_STUDIO_PRINTFILM_URL ?? 'http://127.0.0.1:33102',
  }
}

/** 应用地址由宿主配置或环境变量指定，不接受浏览器传入任意代理地址。 */
export function createIntegrations(config: IntegrationConfig = {}) {
  const urls = integrationUrls(config)
  const definitions: Integration[] = [
    { id: 'media', title: 'AI短剧工作台', url: urls.media, source: 'https://github.com/HBAI-Ltd/Toonflow-app', marker: /toonflow/i },
    { id: 'film', title: 'AI剧工作台', url: urls.film, source: 'https://github.com/yi1108/printfilm', marker: /printfilm/i },
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
      const data = cineflowDataDirectory(config)
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
