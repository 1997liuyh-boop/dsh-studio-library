import type { ProjectId } from '../projects'

interface BaseEntry { id: string; title: string; notes: string }
export interface Trip extends BaseEntry { kind: 'travel'; destination: string; startDate: string; endDate: string; budget: number; status: 'planned' | 'visited' }
export interface KnowledgeNode extends BaseEntry { kind: 'knowledge'; category: string; links: string[] }
export interface MediaPost extends BaseEntry { kind: 'media'; platform: string; status: 'idea' | 'writing' | 'ready' | 'published'; publishDate: string }
export interface Workout extends BaseEntry { kind: 'fitness'; date: string; sets: number; reps: number; weight: number; minutes: number }
export type Entry = Trip | KnowledgeNode | MediaPost | Workout
export interface ProjectDocument { format: 'dsh-studio-projects'; version: 1; project: ProjectId; entries: Entry[] }

export const storageKey = (project: ProjectId): string => `dsh.studio-projects.${project}.v1`
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 100000
const required = (value: unknown): value is string => text(value) && value.trim().length > 0
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000000
const integer = (value: unknown): value is number => number(value) && Number.isInteger(value) && value > 0
const date = (value: unknown): value is string => text(value) && (value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value))

function validEntry(value: unknown, project: ProjectId): value is Entry {
  if (!record(value) || value.kind !== project || !required(value.id) || !required(value.title) || !text(value.notes)) return false
  switch (project) {
    case 'travel': return required(value.destination) && date(value.startDate) && date(value.endDate) && (!value.startDate || !value.endDate || value.startDate <= value.endDate) && number(value.budget) && (value.status === 'planned' || value.status === 'visited')
    case 'knowledge': return text(value.category) && Array.isArray(value.links) && value.links.every(required) && new Set(value.links).size === value.links.length
    case 'media': return required(value.platform) && ['idea', 'writing', 'ready', 'published'].includes(String(value.status)) && date(value.publishDate)
    case 'fitness': return date(value.date) && value.date !== '' && integer(value.sets) && integer(value.reps) && number(value.weight) && number(value.minutes)
  }
}

/** 校验本地保存和导入文件，拒绝错误项目、重复记录及断开的知识引用。 */
export function parseDocument(source: string, project: ProjectId): ProjectDocument {
  const value: unknown = JSON.parse(source)
  if (!record(value) || value.format !== 'dsh-studio-projects' || value.version !== 1 || value.project !== project || !Array.isArray(value.entries) || value.entries.length > 10000) throw new Error('文件格式或项目类型不匹配，请选择当前项目导出的 JSON 文件。')
  const entries: Entry[] = []
  const ids = new Set<string>()
  for (const entry of value.entries) {
    if (!validEntry(entry, project) || ids.has(entry.id)) throw new Error('文件包含无效字段、日期或重复记录，未更改当前数据。')
    ids.add(entry.id)
    entries.push(entry)
  }
  for (const entry of entries) {
    if (entry.kind === 'knowledge' && entry.links.some(id => !ids.has(id) || id === entry.id)) throw new Error('知识关联包含不存在的节点或指向自身，未更改当前数据。')
  }
  return { format: 'dsh-studio-projects', version: 1, project, entries }
}

export function serialize(project: ProjectId, entries: Entry[]): string {
  return JSON.stringify({ format: 'dsh-studio-projects', version: 1, project, entries }, null, 2)
}

/** 持久化失败时由调用方保留原界面数据。 */
export function save(storage: Pick<Storage, 'setItem'>, project: ProjectId, entries: Entry[]): void {
  const source = serialize(project, entries)
  parseDocument(source, project)
  storage.setItem(storageKey(project), source)
}

/** 删除知识节点时同时移除其他节点对它的引用。 */
export function removeEntry(entries: Entry[], id: string): Entry[] {
  return entries.filter(entry => entry.id !== id).map(entry => entry.kind === 'knowledge' ? { ...entry, links: entry.links.filter(link => link !== id) } : entry)
}
