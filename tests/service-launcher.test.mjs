import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 编译运行时的服务启动模块。 */
async function load(t) {
  const dir = await mkdtemp(join(tmpdir(), 'service-launcher-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'launcher.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../packages/runtime/src/serviceStartup.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' })
  return import(pathToFileURL(outfile).href)
}

const group = (label, studioIds) => ({ label, studioIds, command: 'C:\\pwsh.exe', args: [], cwd: 'C:\\', logFile: 'C:\\log.txt', timeoutMs: 1000 })

test('按工作室启动对应启动组，未配置的工作室报错', async (t) => {
  const { StudioServiceLauncher, ServiceNotConfigured } = await load(t)
  const runs = []
  const launcher = new StudioServiceLauncher([group('剧', ['media', 'film']), group('影音', ['cineflow'])], async (configs) => { runs.push(configs.map(config => config.label)); return [] })
  assert.equal(launcher.startable('film'), true)
  assert.equal(launcher.startable('travel'), false)
  await launcher.start('film')
  assert.deepEqual(runs, [['剧']])
  await launcher.start()
  assert.deepEqual(runs.slice(1).flat().sort(), ['剧', '影音'].sort())
  await assert.rejects(launcher.start('travel'), ServiceNotConfigured)
})

test('同一启动组运行中重复点击只执行一次，并报告正在启动', async (t) => {
  const { StudioServiceLauncher } = await load(t)
  let release
  let count = 0
  const launcher = new StudioServiceLauncher([group('剧', ['media', 'film'])], () => { count++; return new Promise(done => { release = done }) })
  const first = launcher.start('media')
  const second = launcher.start('film')
  assert.equal(launcher.starting('film'), true)
  release([])
  await Promise.all([first, second])
  assert.equal(count, 1)
  assert.equal(launcher.starting('film'), false)
})

test('失败记录按启动组覆盖：重新启动成功后清除旧失败', async (t) => {
  const { StudioServiceLauncher } = await load(t)
  let fail = true
  const launcher = new StudioServiceLauncher([group('剧', ['media', 'film']), group('影音', ['cineflow'])], async (configs) =>
    fail ? configs.map(config => ({ kind: 'exit', studioIds: config.studioIds, message: config.label + '失败' })) : [])
  await launcher.start()
  assert.equal(launcher.report().length, 2)
  fail = false
  await launcher.start('media')
  assert.deepEqual(launcher.report().map(item => item.message), ['影音失败'])
})

test('更新前只停止在安装目录内运行的启动组，并可重启', async (t) => {
  const { StudioServiceLauncher, stopArgsOf, isInside } = await load(t)
  // 用正斜杠书写路径：path.resolve 在 Windows 上会统一规范化
  const pkg = 'C:/profile/node_modules/dsh-studio-cineflow'
  const cineflow = { ...group('影音', ['cineflow']), command: 'C:/pwsh/pwsh.exe', args: ['-NoProfile', '-File', pkg + '/scripts/start.ps1'], cwd: pkg }
  const films = { ...group('剧', ['media', 'film']), command: 'C:/pwsh/pwsh.exe', args: ['-File', 'D:/apps/studio-apps.ps1'], cwd: 'D:/apps' }
  assert.equal(isInside(pkg + '/scripts/start.ps1', pkg), true)
  assert.equal(isInside('C:/profile/node_modules/dsh-studio-cineflow-old', pkg), false)
  assert.deepEqual(stopArgsOf(cineflow), ['-NoProfile', '-File', pkg + '/scripts/start.ps1', '-Stop'])
  assert.deepEqual(stopArgsOf({ ...films, stopArgs: ['stop-now'] }), ['stop-now'])
  assert.equal(stopArgsOf({ ...films, command: 'C:/node.exe', args: ['x.js'] }), undefined)
  const started = []
  const stoppedRuns = []
  const launcher = new StudioServiceLauncher([cineflow, films], async (configs) => { started.push(configs.map(c => c.label)); return [] }, async (configs) => { stoppedRuns.push(configs.map(c => c.label)); return [] })
  assert.deepEqual(launcher.groupsInside('film', 'C:/profile/node_modules/dsh-studio-film').map(c => c.label), [])
  const { stopped, failures } = await launcher.stopForUpdate('cineflow', pkg)
  assert.deepEqual(stopped.map(c => c.label), ['影音'])
  assert.deepEqual([...failures], [])
  assert.deepEqual(stoppedRuns, [['影音']])
  await launcher.restart(stopped)
  assert.deepEqual(started, [['影音']])
})
