import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { validateCatalog } from './catalog.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const catalog = await validateCatalog(root)
const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const bundleNames = rootPackage.bundleDependencies
if (!Array.isArray(bundleNames) || bundleNames.some((name) => typeof name !== 'string')) throw new Error('根包子插件声明无效')
const byName = new Map()
for (const item of catalog.packages) {
  const pkg = JSON.parse(await readFile(join(root, item.path, 'package.json'), 'utf8'))
  byName.set(pkg.name, item)
}
const selected = bundleNames.map((name) => {
  const item = byName.get(name)
  if (!item) throw new Error('根包声明的子插件不在索引中：' + name)
  return item
})
const npmCli = process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
await mkdir(join(root, 'artifacts'), { recursive: true })
const artifacts = []
for (const item of selected) {
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', join(root, 'artifacts')], { cwd: join(root, item.path), encoding: 'utf8' })
  if (result.status !== 0) throw new Error('打包失败：' + item.id + ' ' + result.stderr)
  const [pack] = JSON.parse(result.stdout)
  const compatibility = JSON.parse(await readFile(join(root, item.path, 'package.json'), 'utf8')).dsh?.compatibility ?? {}
  artifacts.push({ id: item.id, name: pack.name, version: pack.version, file: pack.filename, dsh: compatibility.dsh ?? '', dshVersions: Object.keys(compatibility.dshReleases ?? {}), sha256: createHash('sha256').update(await readFile(join(root, 'artifacts', pack.filename))).digest('hex') })
}
await writeFile(join(root, 'artifacts/manifest.json'), JSON.stringify({ schemaVersion: 1, artifacts }, null, 2) + '\n')
console.log('已生成 ' + artifacts.length + ' 个控制层安装包和 SHA256 清单')
