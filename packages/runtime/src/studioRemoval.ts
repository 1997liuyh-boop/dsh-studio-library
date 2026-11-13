/**
 * 卸载子工作室：交给宿主插件管理器移除。桌面 profile 没有热重载，自启动起就在运行的工作室不能当场移除，
 * 所以分两步——先停用（下次启动不再加载），记下待卸载；下次启动时它已不在运行，再真正移除安装文件。
 * 工作室自己的数据目录（数据库、素材、设置）不在安装目录里，卸载不会删除。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import type { StudioProjects } from './registry'

/** removed：已移除；restart-required：已移除，重启后生效；pending-restart：已停用，下次启动 DSH 时完成移除。 */
export type StudioRemovalState = 'removed' | 'restart-required' | 'pending-restart'
export interface StudioRemovalOutcome { id: string; packageName: string; state: StudioRemovalState }
interface Pending { id: string; packageName: string; requestedAt: string }
type Manager = Pick<PluginManager, 'removeBundle' | 'setBundleEnabled' | 'listBundles'>

/** 可读的失败原因；code 供界面区分处理。 */
export class StudioRemovalFailure extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** 只卸载业务工作室；工作室库自身与共享运行时不在此列。 */
const STUDIO_PACKAGE = /^dsh-studio-[a-z0-9-]+$/
const PROTECTED = new Set(['dsh-studio-library', 'dsh-studio-projects'])
/** 正在运行、无法当场移除的两种情况：profile 没有热重载，或工作室的插件仍被占用。 */
const RUNNING = new Set(['stop-profile', 'bundle-in-use'])

const reasons: Record<string, string> = {
  'not-removable': '这个工作室由 DSH 安装包或其他插件提供，不能在这里卸载',
  'unknown-plugin': '插件管理器里找不到这个工作室',
  'operation-error': '插件管理器执行卸载时出错',
}

/** 把插件管理器的失败转成一句话；带诊断信息时附上。 */
function describe(error: { code?: string; diagnostic?: string } | undefined, fallback: string): string {
  const base = (error?.code && reasons[error.code]) || fallback
  const detail = error?.diagnostic?.trim().split(/\r?\n/).filter(Boolean).at(-1)
  return detail ? base + '：' + detail.slice(0, 300) : base
}

export class StudioRemovals {
  private pending: Pending[] = []
  private loaded = false
  private writes = Promise.resolve()
  private readonly busy = new Set<string>()

  /**
   * @param registry - 已登记的工作室页面，用来找到安装目录与包名。
   * @param manager - 宿主插件管理器。
   * @param directory - 保存待卸载记录的目录（与更新记录同一目录）。
   * @param stopService - 移除前停止该工作室由运行时拉起的本机服务。
   */
  constructor(private readonly registry: StudioProjects, private readonly manager: Manager | undefined, private readonly directory: string,
    private readonly stopService: (studioId: string) => Promise<void> = async () => {}) {}

  private get file(): string { return join(this.directory, 'removals.json') }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const saved: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (Array.isArray(saved)) this.pending = saved.filter((item): item is Pending => typeof item?.id === 'string' && typeof item?.packageName === 'string' && STUDIO_PACKAGE.test(item.packageName) && !PROTECTED.has(item.packageName))
        .map(item => ({ id: item.id, packageName: item.packageName, requestedAt: typeof item.requestedAt === 'string' ? item.requestedAt : '' }))
    } catch { /* 没有记录或记录损坏：视为没有待卸载的工作室 */ }
  }

  private save(): Promise<void> {
    const content = JSON.stringify(this.pending, null, 2) + '\n'
    const next = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true })
      const temporary = join(this.directory, '.removals-' + randomUUID() + '.json')
      await writeFile(temporary, content, { mode: 0o600 })
      await rename(temporary, this.file)
    })
    this.writes = next.catch(() => { /* 当前调用者得到写入失败，后续写入仍可执行 */ })
    return next
  }

  /** 已停用、等待下次启动完成移除的工作室标识。 */
  async pendingIds(): Promise<string[]> {
    await this.load()
    return this.pending.map(item => item.id)
  }

  /**
   * 启动时调用：上次停用的工作室现在已不在运行，完成移除。
   * 用户在此期间重新启用了它（或它已被别的途径移除）就放弃这条记录；仍然移除不了的留到下次。
   */
  async resume(): Promise<void> {
    await this.load()
    if (!this.manager || !this.pending.length) return
    let bundles: Awaited<ReturnType<Manager['listBundles']>>
    try { bundles = await this.manager.listBundles() } catch { return }
    const remaining: Pending[] = []
    for (const item of this.pending) {
      const bundle = bundles.find(candidate => candidate.name === item.packageName)
      if (!bundle || bundle.enabled) continue
      try {
        const result = await this.manager.removeBundle(item.packageName)
        if (result.application === 'failed' || result.application === 'cancelled') remaining.push(item)
      } catch { remaining.push(item) }
    }
    if (remaining.length !== this.pending.length) { this.pending = remaining; await this.save().catch(() => { /* 记录写不下去时下次启动再核对一遍 */ }) }
  }

  /**
   * 卸载一个已登记的工作室。
   * @param id - 工作室标识（如 media）。
   * @throws StudioRemovalFailure 找不到、不允许卸载或插件管理器拒绝时，message 可直接显示给用户。
   */
  async remove(id: string): Promise<StudioRemovalOutcome> {
    await this.load()
    if (!this.manager) throw new StudioRemovalFailure('unavailable', '当前 dsh 没有可用的插件管理器')
    const page = this.registry.entries().find(entry => entry.id === id)
    if (!page) throw new StudioRemovalFailure('unknown', '没有找到这个工作室，可能已经卸载')
    let packageName: unknown
    try { packageName = JSON.parse(await readFile(join(dirname(resolve(page.root)), 'package.json'), 'utf8'))?.name } catch { packageName = undefined }
    if (typeof packageName !== 'string' || !STUDIO_PACKAGE.test(packageName) || PROTECTED.has(packageName)) throw new StudioRemovalFailure('protected', '这个工作室不能在控制台卸载')
    if (this.busy.has(id)) throw new StudioRemovalFailure('busy', '这个工作室正在卸载，请稍候')
    this.busy.add(id)
    try {
      // 先停本机服务：随包服务从独立副本运行，工作室卸载后没人再管它
      await this.stopService(id).catch(() => { /* 服务停不下来不妨碍卸载插件本身 */ })
      const removed = await this.manager.removeBundle(packageName)
      if (removed.application !== 'failed' && removed.application !== 'cancelled') {
        this.pending = this.pending.filter(item => item.packageName !== packageName)
        await this.save().catch(() => {})
        return { id, packageName, state: removed.application === 'restart-required' ? 'restart-required' : 'removed' }
      }
      if (!removed.error?.code || !RUNNING.has(removed.error.code)) throw new StudioRemovalFailure(removed.error?.code ?? 'failed', describe(removed.error, '卸载失败'))
      // 正在运行的工作室不能当场移除：先停用，下次启动时它不再加载，再由 resume 完成移除
      const disabled = await this.manager.setBundleEnabled(packageName, false)
      if (disabled.application === 'failed' || disabled.application === 'cancelled') throw new StudioRemovalFailure(disabled.error?.code ?? 'failed', describe(disabled.error, '停用工作室失败'))
      this.pending = [...this.pending.filter(item => item.packageName !== packageName), { id, packageName, requestedAt: new Date().toISOString() }]
      await this.save()
      return { id, packageName, state: 'pending-restart' }
    } finally { this.busy.delete(id) }
  }
}
