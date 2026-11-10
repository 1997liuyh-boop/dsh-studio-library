import { access, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { x } from 'tar'

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
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await installBundle(fileURLToPath(new URL('../', import.meta.url)))
}
