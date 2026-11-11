/** 已登记工作室的发布检查与安装；安装包和进度保存在独立更新目录。 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import semver from 'semver'
import { list as listTar } from 'tar'
import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import type { StudioProjects } from './registry'
import type { StudioUpdateReport } from '../../sdk/updates'

export interface UpdateConfig { timeoutMs?: number; downloadTimeoutMs?: number; maxPackageBytes?: number; directory?: string; repositories?: Record<string, string> }
/** libraryRoot：工作室库主插件（dsh-studio-library）根目录；找不到时只检查子工作室。 */
interface Options { timeoutMs: number; downloadTimeoutMs: number; maxPackageBytes: number; directory: string; repositories: Record<string, string>; libraryRoot?: string }
type State = 'idle' | 'available' | 'latest' | 'unpublished' | 'incompatible' | 'unconfigured' | 'failed'
type Phase = 'downloading' | 'verifying' | 'installing' | 'complete' | 'restart-required' | 'failed' | 'unknown'
interface Operation { id: string; studio: string; from: string; to: string; phase: Phase; error?: string }
interface PackageInfo { id: string; name: string; packageName: string; version: string; repository?: string; upstreamVersion?: string }
interface Candidate { version: string; url: string; sha256: string; file: string; dsh: string; dshVersions: string[] }
interface Check { state: State; checkedAt?: string; latest?: string; error?: string }
interface Release { assets: { name: string; url: string }[] }
type Manager = Pick<PluginManager, 'listBundles' | 'installBundle'>
const active = (phase: Phase) => ['downloading', 'verifying', 'installing'].includes(phase)
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

class UpdateFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

/**
 * 判断新版本是否适配当前 DSH。
 * - 明确列出的 dshVersions 包含当前版本 → 适配；
 * - dsh 为单个版本号（如 0.2.1-rc.2）→ 视为最低版本，当前版本不低于它即适配；
 * - dsh 为范围（如 >=0.2.1-rc.2 <0.3）→ 按范围判断（含预发布版本）；
 * - 未声明 → 不限制。
 */
export function hostCompatible(host: string, dsh: string, dshVersions: readonly string[] = []): boolean {
  if (dshVersions.includes(host)) return true
  const declared = dsh.trim()
  if (!declared) return true
  if (semver.valid(declared)) return !!semver.valid(host) && semver.gte(host, declared)
  return !!semver.validRange(declared) && semver.satisfies(host, declared, { includePrerelease: true })
}

/**
 * 从宿主报告的待决定构建脚本中，挑出属于本包自己的 allowBuilds 键。
 * 键为包名本身，或以「包名@」开头（版本、tarball、git 提交等形式）；其他依赖的脚本仍留给用户决定。
 */
export function ownBuildApprovals(pending: unknown, packageName: string): string[] {
  if (!Array.isArray(pending)) return []
  return [...new Set(pending.filter((key): key is string => typeof key === 'string' && (key === packageName || key.startsWith(packageName + '@'))))]
}

/** 宿主安装结果是否表示失败。 */
const installFailed = (application: unknown) => application === 'failed' || application === 'cancelled' || application === 'overridden'

/** 工作室库主插件在更新列表中的标识。 */
export const LIBRARY_ID = 'library'
/** 工作室库主插件包名。 */
const LIBRARY_PACKAGE = 'dsh-studio-library'

/**
 * 从运行时所在目录向上查找工作室库主插件根目录：
 * 安装后运行时作为捆绑依赖位于 dsh-studio-library/node_modules/ 下，开发时位于 packages/runtime 下。
 */
export function findLibraryRoot(start: string): string | undefined {
  let dir = start
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg?.name === LIBRARY_PACKAGE) return dir
    } catch { /* 该层没有 package.json，继续向上 */ }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** 当前模块所在目录（打包后为运行时 lib 目录）。 */
function moduleDirectory(): string | undefined {
  try { return dirname(fileURLToPath(import.meta.url)) } catch { return undefined }
}

/** 配置省略时使用本机更新目录；超时及安装包大小可由 profile 调整。 */
export function resolveUpdates(config: UpdateConfig = {}): Options {
  const options = { timeoutMs: config.timeoutMs ?? 15000, downloadTimeoutMs: config.downloadTimeoutMs ?? 180000, maxPackageBytes: config.maxPackageBytes ?? 512 * 1024 * 1024,
    directory: config.directory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'studio/updates'), repositories: config.repositories ?? {},
    libraryRoot: (() => { const start = moduleDirectory(); return start ? findLibraryRoot(start) : undefined })() }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || !Number.isSafeInteger(options.downloadTimeoutMs) || options.downloadTimeoutMs < 1000 || !Number.isSafeInteger(options.maxPackageBytes) || options.maxPackageBytes < 1024 || !/^(?:[A-Za-z]:[\\/]|\/)/.test(options.directory)) throw new Error('工作室更新配置无效')
  if (typeof options.repositories !== 'object' || options.repositories === null || Array.isArray(options.repositories) || Object.entries(options.repositories).some(([name, repository]) => !/^dsh-studio-[a-z0-9-]+$/.test(name) || typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))) throw new Error('工作室更新仓库配置无效')
  return options
}

/** 更新服务只接受登记的插件，不接受浏览器指定仓库或下载地址。 */
export class StudioUpdates {
  private readonly checks = new Map<string, Check>()
  private readonly candidates = new Map<string, Candidate>()
  private readonly checking = new Map<string, Promise<void>>()
  private operation?: Operation
  private installing?: Promise<void>
  private requested?: { id: string; version: string }
  private readonly lifetime = new AbortController()
  private closed = false
  private hostInstalling = false
  private recordFailure = false
  private writes = Promise.resolve()

  constructor(private readonly registry: StudioProjects, private readonly manager: Manager, private readonly hostVersion: string,
    private readonly options: Options, private readonly request: typeof fetch = fetch) {}

  /** 恢复上次结果；中断的安装标记为未知，等待用户检查后重试。 */
  async initialize(): Promise<void> {
    this.recordFailure = false
    try {
      const saved = object(JSON.parse(await readFile(join(this.options.directory, 'operation.json'), 'utf8')))
      if (typeof saved.id === 'string' && typeof saved.studio === 'string' && typeof saved.from === 'string' && typeof saved.to === 'string' && typeof saved.phase === 'string' && ['downloading','verifying','installing','complete','restart-required','failed','unknown'].includes(saved.phase)) {
        this.operation = { id: saved.id, studio: saved.studio, from: saved.from, to: saved.to, phase: active(saved.phase as Phase) ? 'unknown' : saved.phase as Phase, ...(typeof saved.error === 'string' ? { error: saved.error } : {}) }
      } else this.recordFailure = true
    } catch (error) {
      this.recordFailure = !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    }
  }

  private async packages(): Promise<PackageInfo[]> {
    const studios = await this.studioPackages()
    const library = await this.libraryPackage()
    return library ? [library, ...studios] : studios
  }

  /** 工作室库主插件自身：读取失败时不影响子工作室的检查。 */
  private async libraryPackage(): Promise<PackageInfo | undefined> {
    const root = this.options.libraryRoot
    if (!root) return undefined
    try {
      const pkg = object(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
      if (pkg.name !== LIBRARY_PACKAGE || typeof pkg.version !== 'string' || !semver.valid(pkg.version)) return undefined
      const repositoryUrl = typeof pkg.repository === 'string' ? pkg.repository : object(pkg.repository).url
      const repository = this.options.repositories[LIBRARY_PACKAGE] ?? (typeof repositoryUrl === 'string' ? /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repositoryUrl)?.[1] : undefined)
      return { id: LIBRARY_ID, name: '工作室库', packageName: LIBRARY_PACKAGE, version: pkg.version, ...(repository ? { repository } : {}) }
    } catch { return undefined }
  }

  private async studioPackages(): Promise<PackageInfo[]> {
    return Promise.all(this.registry.entries().map(async page => {
      const base = dirname(resolve(page.root))
      const pkg = object(JSON.parse(await readFile(join(base, 'package.json'), 'utf8')))
      if (typeof pkg.name !== 'string' || !/^dsh-studio-[a-z0-9-]+$/.test(pkg.name) || typeof pkg.version !== 'string' || !semver.valid(pkg.version)) throw new UpdateFailure('metadata')
      const repositoryUrl = typeof pkg.repository === 'string' ? pkg.repository : object(pkg.repository).url
      const repository = this.options.repositories[pkg.name] ?? (typeof repositoryUrl === 'string' ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repositoryUrl)?.[1] : undefined)
      let upstreamVersion: string | undefined
      try { const upstream = object(JSON.parse(await readFile(join(base, 'UPSTREAM.json'), 'utf8'))); if (typeof upstream.version === 'string') upstreamVersion = upstream.version }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new UpdateFailure('metadata') }
      return { id: page.id, name: page.name ?? page.id, packageName: pkg.name, version: pkg.version, ...(repository ? { repository } : {}), ...(upstreamVersion ? { upstreamVersion } : {}) }
    }))
  }

  /** 返回当前加载版本、检查状态及最后一次安装结果，不暴露本机路径。 */
  async list(): Promise<StudioUpdateReport> {
    if (!this.installing) await this.initialize()
    const packages = await this.packages()
    const operation = this.operation
    const running = packages.find(pkg => pkg.id === operation?.studio)
    if (operation && ['unknown', 'restart-required'].includes(operation.phase) && running?.version === operation.to) {
      const installed = (await this.manager.listBundles()).find(bundle => bundle.name === running.packageName)
      if (installed && !installed.error && installed.version === operation.to) await this.phase('complete')
    }
    return { hostVersion: this.hostVersion, ...(this.recordFailure ? { issue: 'record' } : {}), studios: packages.map(pkg => ({ ...pkg, ...(this.checks.get(pkg.id) ?? { state: pkg.repository ? 'idle' : 'unconfigured' }),
      ...(this.operation?.studio === pkg.id ? { operation: this.operation } : {}) })), busy: !!this.installing }
  }

  private async bytes(url: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(url, { signal, headers: { Accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new UpdateFailure(response.status === 403 || response.status === 429 ? 'rate-limit' : 'network')
    if (Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new UpdateFailure('size') }
    const reader = response.body?.getReader()
    if (!reader) throw new UpdateFailure('metadata')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > limit) throw new UpdateFailure('size')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    return Buffer.concat(chunks)
  }

  private async json(url: string, signal: AbortSignal): Promise<unknown> {
    try { return JSON.parse(Buffer.from(await this.bytes(url, 2 * 1024 * 1024, signal)).toString('utf8')) }
    catch (error) { if (error instanceof UpdateFailure) throw error; throw new UpdateFailure('metadata') }
  }

  private release(value: unknown, repository: string): Release | undefined {
    const release = object(value)
    if (release.draft === true || release.prerelease === true || !Array.isArray(release.assets)) return
    const prefix = `https://github.com/${repository}/releases/download/`
    const assets = release.assets.map(value => { const asset = object(value); return { name: asset.name, url: asset.browser_download_url } })
      .filter((asset): asset is { name: string; url: string } => typeof asset.name === 'string' && typeof asset.url === 'string' && asset.url.startsWith(prefix) && !new URL(asset.url).search && !new URL(asset.url).hash)
    return { assets }
  }

  /** 并发检查同一工作室时复用请求；每次检查清除失效的安装候选。 */
  check(id: string): Promise<void> {
    if (this.closed) return Promise.reject(new UpdateFailure('closed'))
    const existing = this.checking.get(id)
    if (existing) return existing
    const task = this.performCheck(id).finally(() => this.checking.delete(id))
    this.checking.set(id, task)
    return task
  }

  private async performCheck(id: string): Promise<void> {
    const pkg = (await this.packages()).find(pkg => pkg.id === id)
    if (!pkg) throw new UpdateFailure('disabled')
    this.candidates.delete(id)
    if (!pkg.repository) { this.checks.set(id, { state: 'unconfigured' }); return }
    const checkedAt = new Date().toISOString()
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.options.timeoutMs)])
      const releases = await this.json(`https://api.github.com/repos/${pkg.repository}/releases?per_page=20`, signal)
      if (!Array.isArray(releases)) throw new UpdateFailure('metadata')
      const candidates: Candidate[] = []
      for (const value of releases) {
        const release = this.release(value, pkg.repository)
        const manifest = release?.assets.find(asset => asset.name === 'manifest.json')
        if (!release || !manifest) continue
        const data = object(await this.json(manifest.url, signal))
        if (data.schemaVersion !== 1 || !Array.isArray(data.artifacts)) throw new UpdateFailure('metadata')
        for (const value of data.artifacts) {
          const item = object(value)
          if (item.name !== pkg.packageName) continue
          if (typeof item.version !== 'string' || !semver.valid(item.version) || typeof item.file !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.tgz$/.test(item.file) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new UpdateFailure('metadata')
          const asset = release.assets.find(asset => asset.name === item.file)
          if (!asset) continue
          const dshVersions = Array.isArray(item.dshVersions) ? item.dshVersions.filter((version): version is string => typeof version === 'string') : []
          const dsh = typeof item.dsh === 'string' ? item.dsh : ''
          candidates.push({ version: item.version, url: asset.url, file: item.file, sha256: item.sha256, dsh, dshVersions })
        }
      }
      candidates.sort((a, b) => semver.rcompare(a.version, b.version))
      const newer = candidates.filter(candidate => semver.gt(candidate.version, pkg.version))
      const compatible = newer.find(candidate => hostCompatible(this.hostVersion, candidate.dsh, candidate.dshVersions))
      if (compatible) { this.candidates.set(id, compatible); this.checks.set(id, { state: 'available', checkedAt, latest: compatible.version }) }
      else this.checks.set(id, { state: !candidates.length ? 'unpublished' : newer.length ? 'incompatible' : 'latest', checkedAt, ...(newer[0] ? { latest: newer[0].version } : {}) })
    } catch (error) { this.checks.set(id, { state: 'failed', checkedAt, error: error instanceof UpdateFailure ? error.code : 'network' }) }
  }

  private async save(): Promise<void> {
    const content = JSON.stringify(this.operation, null, 2) + '\n'
    const pending = this.writes.then(async () => {
      await mkdir(this.options.directory, { recursive: true })
      const temporary = join(this.options.directory, randomUUID() + '.json')
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
      await rename(temporary, join(this.options.directory, 'operation.json'))
    })
    this.writes = pending.catch(() => { /* 当前调用者报告记录失败，后续写入仍可执行。 */ })
    return pending
  }

  private async phase(phase: Phase, error?: string): Promise<void> {
    if (!this.operation) throw new UpdateFailure('missing-operation')
    this.operation = { ...this.operation, phase, ...(error ? { error } : {}) }
    await this.save()
  }

  /** 开始已检查出的安装；同一目标复用进度，其他目标在当前安装结束后重试。 */
  install(id: string, version: string): Promise<void> {
    if (this.closed) return Promise.reject(new UpdateFailure('closed'))
    if (this.recordFailure) return Promise.reject(new UpdateFailure('record'))
    if (this.installing) {
      if (this.requested?.id === id && this.requested.version === version) return this.installing
      return Promise.reject(new UpdateFailure('busy'))
    }
    this.requested = { id, version }
    this.installing = this.prepareInstall(id, version).finally(() => { this.installing = undefined; this.requested = undefined })
    return this.installing
  }

  private async prepareInstall(id: string, version: string): Promise<void> {
    const pkg = (await this.packages()).find(pkg => pkg.id === id)
    const candidate = this.candidates.get(id)
    if (!pkg || !candidate || candidate.version !== version || !semver.gt(version, pkg.version)) throw new UpdateFailure('recheck')
    this.operation = { id: randomUUID(), studio: id, from: pkg.version, to: version, phase: 'downloading' }
    await this.save()
    await this.performInstall(pkg, candidate)
  }

  private async performInstall(pkg: PackageInfo, candidate: Candidate): Promise<void> {
    try {
      const bundle = (await this.manager.listBundles()).find(bundle => bundle.name === pkg.packageName)
      if (!bundle || bundle.version !== pkg.version || !bundle.installed) throw new UpdateFailure('recheck')
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.options.downloadTimeoutMs)])
      const bytes = await this.bytes(candidate.url, this.options.maxPackageBytes, signal)
      await this.phase('verifying')
      if (createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) throw new UpdateFailure('integrity')
      const directory = join(this.options.directory, 'packages')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = join(directory, `${candidate.sha256}-${candidate.file}`)
      const temporary = join(directory, randomUUID() + '.tgz')
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      await rename(temporary, file)
      const manifest: Buffer[] = []
      let found = false
      await listTar({ file, strict: true, onReadEntry(entry) {
        if (entry.path !== 'package/package.json') return
        if (found || entry.type !== 'File' || entry.size > 65536) throw new UpdateFailure('metadata')
        found = true
        entry.on('data', chunk => { manifest.push(chunk) })
      } })
      const packed = object(JSON.parse(Buffer.concat(manifest).toString('utf8')))
      if (packed.name !== pkg.packageName || packed.version !== candidate.version) throw new UpdateFailure('metadata')
      const stillInstalled = (await this.manager.listBundles()).find(bundle => bundle.name === pkg.packageName)
      if (!stillInstalled || stillInstalled.version !== pkg.version) throw new UpdateFailure('recheck')
      this.lifetime.signal.throwIfAborted()
      await this.phase('installing')
      this.hostInstalling = true
      let result = await this.manager.installBundle(file, { enabled: bundle.enabled })
      // pnpm 拦下本包的构建脚本时，宿主会把待决定的键记入 allowBuilds：只批准本包自己的键并重试一次
      const approvals = installFailed(result.application) ? ownBuildApprovals(result.pendingBuilds, pkg.packageName) : []
      if (approvals.length) {
        this.lifetime.signal.throwIfAborted()
        result = await this.manager.installBundle(file, { enabled: bundle.enabled, approvedBuilds: approvals })
      }
      if (installFailed(result.application)) {
        await this.phase('failed', result.error?.code ?? result.packageResult?.kind ?? result.application)
      } else if (result.bundle !== pkg.packageName || result.version !== candidate.version) await this.phase('unknown', 'version-mismatch')
      else { this.candidates.delete(pkg.id); this.checks.delete(pkg.id); await this.phase(result.application === 'restart-required' ? 'restart-required' : 'complete') }
    } catch (error) {
      const phase = this.operation?.phase === 'installing' ? 'unknown' : 'failed'
      try { await this.phase(phase, error instanceof UpdateFailure ? error.code : 'operation') }
      catch (recordError) { console.error('工作室升级结果无法保存，请重启后核对插件版本', recordError instanceof Error ? recordError.name : 'Error') }
    }
  }

  /** 只取消本服务的下载和检查；安装由宿主管理器完成，避免卸载与安装互等。 */
  async dispose(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    await Promise.allSettled(this.checking.values())
    if (!this.hostInstalling) await this.installing
    await this.writes
  }
}
