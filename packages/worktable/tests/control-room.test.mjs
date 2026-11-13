import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../package.json', import.meta.url))
const { buildSync } = require('esbuild')
const client = (file) => readFileSync(new URL('../src/client/' + file, import.meta.url), 'utf8')

/** 编译版本信息存储模块（不依赖浏览器环境的纯函数部分）。 */
function loadStudioInfo() {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/studioInfo.ts', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'] }).outputFiles[0].text
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, require, fetch: () => Promise.reject(new Error('offline')) })
  return module.exports
}

test('版本状态归类：有更新 / 已是最新 / 需重启 / 检查中', () => {
  const { releaseLabelKind, readUpdateReport, studioIdOf } = loadStudioInfo()
  assert.equal(studioIdOf('studio-film'), 'film')
  assert.equal(studioIdOf('library'), 'library')
  const { patch, idle } = readUpdateReport({ studios: [
    { id: 'film', version: '0.2.3', state: 'available', latest: '0.2.4' },
    { id: 'media', version: '0.2.3', state: 'latest' },
    { id: 'live', version: '0.3.5', state: 'idle' },
    { id: 'cineflow', version: '0.2.7', state: 'latest', operation: { phase: 'restart-required' } },
  ] })
  assert.deepEqual([...idle], ['live'])
  assert.equal(releaseLabelKind(patch.film), 'available')
  assert.equal(releaseLabelKind(patch.media), 'latest')
  assert.equal(releaseLabelKind(patch.live), 'checking')
  assert.equal(releaseLabelKind(patch.cineflow), 'restart')
  assert.equal(releaseLabelKind(undefined), 'none')
})

test('控制室默认背景为项目自带图片，卡片间隔 15px', () => {
  const split = client('split.tsx')
  const index = client('index.tsx')
  const styles = client('styles.ts')
  assert.match(client('consoleBg.ts'), /from '\.\/assets\/console-bg\.jpg'/)
  assert.match(readFileSync(new URL('../build.mjs', import.meta.url), 'utf8'), /'\.jpg': 'dataurl'/)
  assert.match(split, /data-default-bg src=\{CONSOLE_DEFAULT_BG\}/)
  assert.match(index, /consoleBgDefaultV2 !== true \? 'photo'/)
  assert.match(styles, /\.dsh-wt_consoleGrid\{[^']*gap:var\(--wt-gap,15px\)/)
  assert.doesNotMatch(styles, /consoleGrid[^']*64px|consoleCard\{[^']*64px/)
})

test('自动检查更新开关显示已开启/已关闭，并使用醒目样式', () => {
  const split = client('split.tsx')
  assert.match(split, /dsh-wt_autoSwitch[\s\S]{0,200}role="switch" aria-checked=\{autoCheckOn\}/)
  assert.match(split, /autoCheckOn \? T\('annot\.autoOn'\) : T\('annot\.autoOff'\)/)
  assert.match(client('styles.ts'), /\.dsh-wt_autoSwitch\.dsh-wt_switchOn\{background:#2ea043/)
})

test('「工作室状态」打开工作室列表弹窗，不再使用控制室内的小浮层；卡片 header 含版本标签与仓库地址', () => {
  const split = client('split.tsx')
  const styles = client('styles.ts')
  assert.match(split, /title=\{T\('console\.statusLabel'\)\}[\s\S]{0,200}splitEnv\?\.console\?\.openStudios\?\.\(\)/)
  assert.doesNotMatch(split, /dsh-wt_statusDrop|releaseLine|getStudioStatus|statusOpen/)
  assert.match(split, /kind === 'available'\) return upgradeButton\(id, item!\.latest!\)/)
  assert.match(split, /\{!c\.self && cardTag\(c\.id\)\}/)
  assert.match(split, /className="dsh-wt_consoleRepo"/)
  assert.match(styles, /\.dsh-wt_consoleName\{[^']*font-size:18px/)
  assert.match(styles, /\.dsh-wt_consoleRepo\{[^']*text-overflow:ellipsis;white-space:nowrap;font-size:14px/)
})

test('卡片版本标签为实心白字；每行两张方形卡片时正好占满控制室宽度', () => {
  const split = client('split.tsx')
  const styles = client('styles.ts')
  for (const name of ['Update', 'Latest', 'Busy']) {
    const rule = styles.match(new RegExp('\\.dsh-wt_cardTag' + name + '\\{([^}]*)\\}'))?.[1] ?? ''
    assert.match(rule, /background:#[0-9a-f]{6}/, name + ' 应为实心背景')
    assert.match(rule, /color:#fff/, name + ' 应为白字')
    assert.doesNotMatch(rule, /background:transparent|border:1px/, name + ' 不应是描边样式')
  }
  assert.match(split, /className="dsh-wt_consoleGrid" data-cols=\{cols\}/)
  assert.match(styles, /\.dsh-wt_console:not\(\[data-wt-shape=circle\]\) \.dsh-wt_consoleGrid\[data-cols="2"\]\{max-width:none\}/)
  assert.match(styles, /\.dsh-wt_consoleGrid\[data-cols="2"\] \.dsh-wt_consoleCard\{aspect-ratio:auto\}/)
})

test('卡片一键更新失败时在控制室显示原因；旧状态浮层的样式与文案已清理', () => {
  const split = client('split.tsx')
  const styles = client('styles.ts')
  const locales = client('locales.ts')
  assert.match(split, /\{studioInfo\.error && <p role="alert" className="dsh-wt_consoleErr" data-upgrade-error>\{T\('console\.upgradeFail', \{ reason: studioInfo\.error \}\)\}<\/p>\}/)
  assert.match(styles, /\.dsh-wt_consoleGrid>\.dsh-wt_consoleErr\{flex-basis:100%/)
  assert.doesNotMatch(styles, /dsh-wt_status|dsh-wt_consoleDockWrapOpen/)
  assert.doesNotMatch(locales, /'console\.(statusTitle|statusRefresh|releaseVersion|localVersion|workspacePath|installedStudios)'/)
})

test('该不该重新检查：从未检查、失败过一分钟、结果过十五分钟、强制', () => {
  const { dueForCheck, CHECK_RETRY_MS, CHECK_STALE_MS } = loadStudioInfo()
  const now = Date.parse('2026-11-13T02:00:00Z')
  const at = (ms) => new Date(now - ms).toISOString()
  assert.equal(dueForCheck({ id: 'a', state: 'idle' }, now), true)
  assert.equal(dueForCheck({ id: 'a', state: 'failed', checkedAt: at(CHECK_RETRY_MS - 1000) }, now), false)
  assert.equal(dueForCheck({ id: 'a', state: 'failed', checkedAt: at(CHECK_RETRY_MS) }, now), true)
  assert.equal(dueForCheck({ id: 'a', state: 'failed' }, now), true)
  assert.equal(dueForCheck({ id: 'a', state: 'latest', checkedAt: at(CHECK_STALE_MS - 1000) }, now), false)
  assert.equal(dueForCheck({ id: 'a', state: 'latest', checkedAt: at(CHECK_STALE_MS) }, now), true)
  assert.equal(dueForCheck({ id: 'a', state: 'available', checkedAt: at(CHECK_STALE_MS) }, now), true)
  assert.equal(dueForCheck({ id: 'a', state: 'latest' }, now), false)
  assert.equal(dueForCheck({ id: 'a', state: 'latest', checkedAt: at(1000) }, now, true), true)
  assert.equal(dueForCheck({ id: 'a', state: 'unconfigured' }, now, true), false)
  assert.equal(dueForCheck({ state: 'idle' }, now), false)
})
