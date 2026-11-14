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
