import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installBundle } from '../scripts/install.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('根包声明的控制层插件拥有运行依赖，业务工作室保持按需安装', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'))
  const bundled = new Set(pkg.bundleDependencies)
  for (const item of catalog.packages) {
    const child = JSON.parse(await readFile(join(root, item.path, 'package.json'), 'utf8'))
    if (!bundled.has(child.name)) continue
    for (const [name, version] of Object.entries(child.dependencies ?? {})) {
      assert.equal(pkg.dependencies[name], version, `${child.name} 缺少运行依赖：${name}`)
    }
  }
})

test('Git 准备后没有 node_modules，仍能恢复控制层插件；损坏归档拒绝安装', async () => {
  const target = await mkdtemp(join(tmpdir(), 'studio-git-install-'))
  try {
    await cp(join(root, 'package.json'), join(target, 'package.json'))
    await cp(join(root, 'artifacts'), join(target, 'artifacts'), { recursive: true })
    const manifest = JSON.parse(await readFile(join(target, 'artifacts/manifest.json'), 'utf8'))
    await assert.rejects(readFile(join(target, 'node_modules/dsh-worktable/package.json')), { code: 'ENOENT' })
    await installBundle(target)
    for (const item of manifest.artifacts) {
      const restored = JSON.parse(await readFile(join(target, 'node_modules', item.name, 'package.json'), 'utf8'))
      assert.equal(restored.version, item.version)
    }
    await writeFile(join(target, 'artifacts', manifest.artifacts[0].file), 'broken')
    await assert.rejects(installBundle(target), /归档校验失败/)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})
