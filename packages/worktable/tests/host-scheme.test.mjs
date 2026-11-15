import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../package.json', import.meta.url))
const { buildSync } = require('esbuild')

/** 编译 hostScheme 并在给定的 html color-scheme 与系统深浅色下执行。 */
function load(colorScheme, systemDark) {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/hostScheme.ts', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'] }).outputFiles[0].text
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, require,
    document: { documentElement: {} },
    getComputedStyle: () => ({ colorScheme }),
    window: { matchMedia: () => ({ matches: systemDark }) },
  })
  return module.exports
}

test('深浅色：宿主 html 只声明一种时以它为准，否则跟随系统', () => {
  assert.equal(load('dark', false).readHostScheme(), 'dark')
  assert.equal(load('light', true).readHostScheme(), 'light')
  assert.equal(load('light dark', true).readHostScheme(), 'dark')
  assert.equal(load('', false).readHostScheme(), 'light')
})

test('纯色弹窗面：纯白或纯黑、不透明、不做背景模糊', () => {
  const { solidSurface } = load('', false)
  assert.equal(solidSurface('light').backgroundColor, '#ffffff')
  assert.equal(solidSurface('dark').backgroundColor, '#000000')
  for (const scheme of ['light', 'dark']) {
    assert.equal(solidSurface(scheme).backdropFilter, 'none')
    assert.equal(solidSurface(scheme).opacity, '1')
  }
})

test('新增工作室弹窗使用纯色弹窗面并随打开状态跟随深浅色', () => {
  const dialog = readFileSync(new URL('../src/client/AddStudioDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /useHostScheme\(open\)/)
  assert.match(dialog, /style=\{solidSurface\(scheme\)\}/)
})

test('弹窗配色：纯色与玻璃两种面都带深浅两套文字 / 提示词变量；玻璃面与更新公告同一套背景', () => {
  const { solidSurface, glassSurface } = load('', false)
  assert.equal(solidSurface('light')['--wt-placeholder'], 'rgba(0,0,0,0.4)')
  assert.equal(solidSurface('dark')['--wt-placeholder'], 'rgba(255,255,255,0.42)')
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  for (const scheme of ['dark', 'light']) {
    const glass = glassSurface(scheme)
    assert.ok(styles.includes('background:' + glass.background), scheme + ' 背景与更新公告一致')
    assert.equal(glass.borderRadius, '16px')
    assert.equal(glass.backdropFilter, 'blur(8px) saturate(1.15)')
  }
})

test('工作室状态弹窗用玻璃面并跟随控制室主题；新增工作室弹窗的提示词用弹窗自己的颜色', () => {
  const status = readFileSync(new URL('../src/client/ConsoleStudiosDialog.tsx', import.meta.url), 'utf8')
  assert.match(status, /useHostScheme\(open, readConsoleScheme\)/)
  assert.match(status, /style=\{glassSurface\(scheme\)\}/)
  assert.match(status, /studio:backdrop:bg-transparent/)
  const add = readFileSync(new URL('../src/client/AddStudioDialog.tsx', import.meta.url), 'utf8')
  assert.match(add, /studio:placeholder:text-\(--wt-placeholder\)/)
})

test('控制室主题：读控制室面板的 data-wt-theme，读不到时跟随宿主', () => {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/hostScheme.ts', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'] }).outputFiles[0].text
  const run = (panelTheme) => {
    const module = { exports: {} }
    runInNewContext(code, { module, exports: module.exports, require,
      document: { documentElement: {}, querySelector: () => panelTheme ? { getAttribute: () => panelTheme } : null },
      getComputedStyle: () => ({ colorScheme: 'dark' }), window: { matchMedia: () => ({ matches: true }) } })
    return module.exports.readConsoleScheme()
  }
  assert.equal(run('light'), 'light')
  assert.equal(run(null), 'dark')
})
