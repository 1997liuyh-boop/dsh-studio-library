/** 控制台列表数据：逐个读取工作室包信息，单个失败不影响其他工作室。 */
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { StudioPage } from './registry'

/** 控制台中一行工作室的展示信息。 */
export interface StudioCatalogRow {
  /** 工作室标识（不带 studio- 前缀） */
  id: string
  /** 显示名称 */
  name: string
  /** 包版本号；读取失败时缺省 */
  version?: string
  /** 来源：github = 从 GitHub 安装；local = 本机目录链接安装 */
  source: 'github' | 'local'
  /** GitHub 仓库地址或本机目录 */
  address: string
}

/** 从 package.json 的 repository 字段解析 GitHub 仓库网址。 */
export function githubUrlOf(repository: unknown): string | undefined {
  const raw = typeof repository === 'string' ? repository
    : repository && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string' ? (repository as { url: string }).url : ''
  const match = /^(?:git\+)?(?:https:\/\/|git:\/\/|ssh:\/\/git@)?github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw)
    ?? /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(raw)
  return match ? 'https://github.com/' + match[1] : undefined
}

/** 读取单个工作室的版本与来源；真实路径不在 node_modules 内即视为本机链接安装。 */
export async function catalogRow(page: Pick<StudioPage, 'id' | 'name' | 'root'>): Promise<StudioCatalogRow> {
  const base = dirname(resolve(page.root))
  let version: string | undefined
  let github: string | undefined
  try {
    const raw = await readFile(join(base, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
    if (typeof pkg?.version === 'string') version = pkg.version
    github = githubUrlOf(pkg?.repository)
  } catch { /* 包信息缺失时只展示名称与目录 */ }
  const real = await realpath(base).catch(() => base)
  const linked = !real.split(sep).includes('node_modules')
  return {
    id: page.id,
    name: page.name ?? page.id,
    ...(version ? { version } : {}),
    ...(github && !linked ? { source: 'github' as const, address: github } : { source: 'local' as const, address: real }),
  }
}

/** 汇总全部已登记工作室。 */
export function studioCatalog(pages: readonly Pick<StudioPage, 'id' | 'name' | 'root'>[]): Promise<StudioCatalogRow[]> {
  return Promise.all(pages.map(catalogRow))
}
