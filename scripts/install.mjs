import { access, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { x } from 'tar'
import { cleanDuplicates, findProfileDir } from './plugin-duplicates.mjs'

/** 从随包归档恢复子插件；源码检出的首次安装由 prepare 生成归档。 */
export async function installBundle(root) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(root, 'artifacts/manifest.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await access(join(root, 'scripts/prepare.mjs'))
    return
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) throw new Error('子插件归档清单无效')
  const names = manifest.artifacts.map(item => item.name)
  if (names.length !== pkg.bundleDependencies.length || new Set(names).size !== names.length || pkg.bundleDependencies.some(name => !names.includes(name))) {
    throw new Error('子插件归档与组合包声明不一致')
  }
  for (const item of manifest.artifacts) {
    if (!/^dsh-[a-z0-9-]+$/.test(item.name) || !/^[a-z0-9.-]+\.tgz$/.test(item.file)) throw new Error('子插件归档路径无效')
    const file = join(root, 'artifacts', item.file)
    const hash = createHash('sha256').update(await readFile(file)).digest('hex')
    if (hash !== item.sha256) throw new Error(`子插件归档校验失败：${item.name}`)
    const destination = join(root, 'node_modules', item.name)
    await mkdir(destination, { recursive: true })
    await x({ file, cwd: destination, strip: 1, strict: true })
    const restored = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'))
    if (restored.name !== item.name || restored.version !== item.version) throw new Error(`子插件版本不一致：${item.name}`)
    for (const target of [restored.main, restored.dsh?.bundle?.patch, 'dsh.plugin.json']) {
      if (typeof target !== 'string') throw new Error(`子插件入口声明无效：${item.name}`)
      await access(join(destination, target))
    }
    if (restored.dsh?.client) await access(join(destination, 'lib/client.js'))
  }
  console.log(`已还原并检查 ${names.length} 个工作室子插件`)
  await linkDuplicates(root)
}

/**
 * profile 里与子插件同名的另一份（插件市场的子包条目、上游同名包）会盖住刚还原的版本：把顶层同名目录换成指向它的联接。
 * 这时 pnpm 还在执行，结束时会整份写回 profile 的 package.json，所以不改依赖与 bundles 登记，由下次启动的运行时去掉；
 * 任何失败都不影响安装本身。
 */
export async function linkDuplicates(root) {
  try {
    const profileDir = await findProfileDir(join(root, '..'))
    if (!profileDir) return
    const { replaced, failures } = await cleanDuplicates(profileDir, { manifest: false })
    for (const item of replaced) console.log(`已把 ${item.name} 换成工作室库自带的版本` + (item.backup ? `，原来那份备份在：${item.backup}` : ''))
    for (const item of failures) console.warn(`处理重复安装的 ${item.name} 失败：${item.message}`)
  } catch (error) {
    console.warn('检查子插件重复安装时出错：' + (error instanceof Error ? error.message : String(error)))
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await installBundle(fileURLToPath(new URL('../', import.meta.url)))
}
