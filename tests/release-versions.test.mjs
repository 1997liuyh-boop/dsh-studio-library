import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bump } from '../scripts/bump.mjs'
import { checkVersions } from '../scripts/check-versions.mjs'
import { nextPatch, greater } from '../scripts/versions.mjs'

/** 在临时目录建一个最小的工作室库仓库：总包 + 两个子插件，提交并打标签 v1.0.0。 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-versions-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const json = (path, value) => writeFile(join(root, path), JSON.stringify(value, null, 2) + '\n')
  for (const [dir, name, version] of [['packages/worktable', 'dsh-worktable', '0.6.3'], ['packages/runtime', 'dsh-studio-projects', '0.5.2']]) {
    await mkdir(join(root, dir, 'lib'), { recursive: true })
    await mkdir(join(root, dir, 'tests'), { recursive: true })
    await json(dir + '/package.json', { name, version })
    await json(dir + '/dsh.plugin.json', { name, version })
    await writeFile(join(root, dir, 'lib/index.js'), 'export {}\n')
    await writeFile(join(root, dir, 'tests/a.test.mjs'), '// 测试\n')
  }
  await json('package.json', { name: 'dsh-studio-library', version: '1.0.0', bundleDependencies: ['dsh-worktable', 'dsh-studio-projects'] })
  await json('package-lock.json', { name: 'dsh-studio-library', version: '1.0.0', packages: { '': { version: '1.0.0' }, 'packages/worktable': { name: 'dsh-worktable', version: '0.6.3' }, 'packages/runtime': { name: 'dsh-studio-projects', version: '0.5.2' } } })
  await json('catalog.json', { schemaVersion: 1, name: 'dsh-studio-library', version: '1.0.0', packages: [{ id: 'worktable', path: 'packages/worktable' }, { id: 'runtime', path: 'packages/runtime' }] })
  for (const name of ['README.md', 'README.zh.md']) await writeFile(join(root, name), 'add "github:owner/dsh-studio-library#v1.0.0"\n')
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false')
  git('add', '-A'); git('commit', '-qm', 'v1.0.0'); git('tag', 'v1.0.0')
  return { root, git, read: async path => JSON.parse(await readFile(join(root, path), 'utf8')) }
}

test('版本号工具：补丁加一与大小比较', () => {
  assert.equal(nextPatch('0.6.3'), '0.6.4')
  assert.equal(greater('0.1.10', '0.1.9'), true)
  assert.equal(greater('0.5.2', '0.5.2'), false)
  assert.throws(() => nextPatch('1.0'), /x\.y\.z/)
})

test('bump：总包各处一起改；只升级自上一个标签以来改过的子插件，测试文件的改动不算', async (t) => {
  const { root, read } = await fixture(t)
  await writeFile(join(root, 'packages/worktable/lib/index.js'), 'export const changed = true\n')
  await writeFile(join(root, 'packages/runtime/tests/a.test.mjs'), '// 只改了测试\n')
  const result = await bump(root, '1.0.1')
  assert.deepEqual(result.packages.map(item => [item.name, item.from, item.to]), [['dsh-worktable', '0.6.3', '0.6.4']])
  assert.equal((await read('package.json')).version, '1.0.1')
  assert.equal((await read('catalog.json')).version, '1.0.1')
  const lock = await read('package-lock.json')
  assert.equal(lock.version, '1.0.1'); assert.equal(lock.packages[''].version, '1.0.1')
  assert.equal(lock.packages['packages/worktable'].version, '0.6.4')
  assert.equal(lock.packages['packages/runtime'].version, '0.5.2')
  assert.equal((await read('packages/worktable/package.json')).version, '0.6.4')
  assert.equal((await read('packages/worktable/dsh.plugin.json')).version, '0.6.4')
  assert.equal((await read('packages/runtime/package.json')).version, '0.5.2')
  assert.match(await readFile(join(root, 'README.zh.md'), 'utf8'), /#v1\.0\.1/)
  assert.deepEqual(await checkVersions(root, 'v1.0.1'), [])
  await assert.rejects(bump(root, '1.0.1'), /需要大于当前版本/)
})

test('bump --all：两个子插件都升级', async (t) => {
  const { root, read } = await fixture(t)
  const result = await bump(root, '1.1.0', { all: true })
  assert.deepEqual(result.packages.map(item => item.to), ['0.6.4', '0.5.3'])
  assert.equal((await read('packages/runtime/dsh.plugin.json')).version, '0.5.3')
})

test('check-versions：子插件改了但版本没升、标签与版本不符、清单之间不一致都会报出', async (t) => {
  const { root, git } = await fixture(t)
  await writeFile(join(root, 'packages/runtime/lib/index.js'), 'export const changed = true\n')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  pkg.version = '1.0.1'
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  git('add', '-A'); git('commit', '-qm', 'release'); git('tag', 'v1.0.1')
  const issues = await checkVersions(root, 'v1.0.1', { until: 'HEAD' })
  assert.ok(issues.some(issue => issue.includes('dsh-studio-projects 自 v1.0.0 以来有 1 个文件改动') && issue.includes('bump.mjs')), '改过的子插件必须升版本')
  assert.ok(issues.some(issue => issue.includes('package-lock.json 的总包版本')))
  assert.ok(issues.some(issue => issue.includes('catalog.json')))
  assert.ok(issues.some(issue => issue.includes('README.md 的安装命令')))
  assert.ok(!issues.some(issue => issue.includes('dsh-worktable')), '没改动的子插件不要求升版本')
  assert.ok((await checkVersions(root, 'v9.9.9', { until: 'HEAD' })).some(issue => issue.includes('标签 v9.9.9 与 package.json 版本 1.0.1 不一致')))
})
