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

test('工作室状态弹窗显示本地版本、Release 版本与一键更新；卡片 header 含版本标签与仓库地址', () => {
  const split = client('split.tsx')
  const styles = client('styles.ts')
  assert.match(split, /T\('console\.localVersion'[\s\S]{0,200}T\('console\.releaseVersion'/)
  assert.match(split, /kind === 'available' && <>[\s\S]{0,120}upgradeButton\(id, item\.latest!\)/)
  assert.match(split, /\{releaseLine\(studio\.id\)\}/)
  assert.match(split, /\{!c\.self && cardTag\(c\.id\)\}/)
  assert.match(split, /className="dsh-wt_consoleRepo"/)
  assert.match(styles, /\.dsh-wt_consoleName\{[^']*font-size:18px/)
  assert.match(styles, /\.dsh-wt_consoleRepo\{[^']*text-overflow:ellipsis;white-space:nowrap;font-size:14px/)
})
