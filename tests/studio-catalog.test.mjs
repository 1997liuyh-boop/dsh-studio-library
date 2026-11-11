import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 编译运行时的控制台目录模块。 */
async function load(t) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-catalog-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'catalog.mjs')
  await build({ entryPoints: [new URL('../packages/runtime/src/studioCatalog.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], outfile, bundle: true, platform: 'node', format: 'esm' })
  return { dir, mod: await import(pathToFileURL(outfile).href) }
}

/** 写一个最小工作室包：package.json + static 目录。 */
async function studioPackage(dir, pkg) {
  await mkdir(join(dir, 'static'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg))
  return join(dir, 'static')
}

test('githubUrlOf 识别常见 repository 写法', async (t) => {
  const { mod } = await load(t)
  assert.equal(mod.githubUrlOf({ type: 'git', url: 'https://github.com/o/r.git' }), 'https://github.com/o/r')
  assert.equal(mod.githubUrlOf('git+https://github.com/o/r.git'), 'https://github.com/o/r')
  assert.equal(mod.githubUrlOf('github:o/r#v1'), 'https://github.com/o/r')
  assert.equal(mod.githubUrlOf('https://gitlab.com/o/r'), undefined)
})

test('node_modules 内安装显示 GitHub 地址，本机目录显示真实路径，单个缺失包不影响其他', async (t) => {
  const { dir, mod } = await load(t)
  const installed = await studioPackage(join(dir, 'node_modules', 'dsh-studio-film'), { name: 'dsh-studio-film', version: '0.2.3', repository: { url: 'https://github.com/o/dsh-studio-film.git' } })
  const localDir = join(dir, 'work', 'my-studio')
  const local = await studioPackage(localDir, { name: 'dsh-studio-mine', version: '1.0.0', repository: 'https://github.com/o/mine' })
  const rows = await mod.studioCatalog([
    { id: 'film', name: '剧', root: installed },
    { id: 'mine', name: '我的', root: local },
    { id: 'broken', root: join(dir, 'missing', 'static') },
  ])
  assert.deepEqual(rows[0], { id: 'film', name: '剧', version: '0.2.3', source: 'github', address: 'https://github.com/o/dsh-studio-film' })
  assert.equal(rows[1].source, 'local')
  assert.equal(rows[1].version, '1.0.0')
  assert.match(rows[1].address, /my-studio$/)
  assert.equal(rows[2].version, undefined)
  assert.equal(rows[2].name, 'broken')
})

test('通过链接安装到 node_modules 的本机工作室显示真实目录', async (t) => {
  const { dir, mod } = await load(t)
  const target = join(dir, 'src', 'linked-studio')
  await studioPackage(target, { name: 'dsh-studio-linked', version: '0.0.1', repository: 'https://github.com/o/linked' })
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  const link = join(dir, 'node_modules', 'dsh-studio-linked')
  try { await symlink(target, link, 'junction') } catch { t.skip('当前系统不允许创建目录链接'); return }
  const [row] = await mod.studioCatalog([{ id: 'linked', root: join(link, 'static') }])
  assert.equal(row.source, 'local')
  assert.match(row.address, /linked-studio$/)
})
