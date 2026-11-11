import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../package.json', import.meta.url))
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const { buildSync } = require('esbuild')

/** 编译单个客户端模块到 CommonJS 并在隔离上下文中执行。 */
function load(file, globals = {}) {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/' + file, import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'] }).outputFiles[0].text
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, require, ...globals })
  return module.exports
}

const { ConsoleStudiosDialog, moveItem } = load('ConsoleStudiosDialog.tsx', {
  document: { get body() { return globalThis.document.body } },
  AbortController, setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0),
  fetch: (...args) => globalThis.fetch(...args),
})
const { zh } = load('locales.ts')
const flush = () => new Promise(setImmediate)
const translate = (key, params = {}) => zh[key].replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')

/** 在 jsdom 中渲染控制台弹窗。 */
async function render(t, studios, report) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://dsh.local' })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  const saved = new Map()
  const fetch = async () => ({ ok: true, json: async () => report })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, fetch })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const reorders = []
  const root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => { root.render(React.createElement(ConsoleStudiosDialog, { open: true, t: translate, studios, onClose() {}, onReorder: (ids) => reorders.push(ids) })); await flush() })
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  return { dom, reorders, dialog: dom.window.document.querySelector('dialog') }
}

test('moveItem 按位置移动且越界时保持原样', () => {
  assert.deepEqual([...moveItem(['a', 'b', 'c'], 0, 2)], ['b', 'c', 'a'])
  assert.deepEqual([...moveItem(['a', 'b', 'c'], 2, 0)], ['c', 'a', 'b'])
  assert.deepEqual([...moveItem(['a', 'b'], 0, 5)], ['a', 'b'])
})

test('控制台弹窗：标题、名称、版本号与「有更新」标记', async (t) => {
  const studios = [{ id: 'travel', name: '旅行', icon: '🧭' }, { id: 'media', name: '影音' }]
  const report = { hostVersion: '0.2.2', busy: false, studios: [
    { id: 'travel', name: '旅行', version: '1.2.0', state: 'available', latest: '1.3.0' },
    { id: 'media', name: '影音', version: '0.4.1', state: 'latest' },
  ] }
  const { dialog } = await render(t, studios, report)
  assert.equal(dialog.open, true)
  assert.equal(dialog.querySelector('h2').textContent, '控制台')
  const rows = [...dialog.querySelectorAll('[data-console-studio]')]
  assert.deepEqual(rows.map(row => row.getAttribute('data-console-studio')), ['travel', 'media'])
  assert.match(rows[0].textContent, /旅行/)
  assert.match(rows[0].textContent, /v1\.2\.0/)
  assert.match(rows[0].textContent, /有更新/)
  assert.match(rows[1].textContent, /v0\.4\.1/)
  assert.doesNotMatch(rows[1].textContent, /有更新/)
  assert.ok(rows.every(row => row.querySelector('[data-grip]')))
})

test('抓手键盘排序提交新顺序', async (t) => {
  const studios = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]
  const { dom, dialog, reorders } = await render(t, studios, { hostVersion: '', busy: false, studios: [] })
  const grip = dialog.querySelector('[data-console-studio="b"] [data-grip]')
  await act(async () => { grip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); await flush() })
  assert.deepEqual(reorders.map(ids => [...ids]), [['b', 'a']])
  assert.deepEqual([...dialog.querySelectorAll('[data-console-studio]')].map(row => row.getAttribute('data-console-studio')), ['b', 'a'])
})

test('控制室箭头打开控制台、工作室栏移除版本与更新、搜索改为标题栏内联', () => {
  const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const section = readFileSync(new URL('../src/client/StudioSection.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /StudioUpdates/)
  assert.match(source, /dsh-wt_consoleArrow[\s\S]{0,400}setConsoleListOpen\(true\)/)
  assert.match(source, /<ConsoleStudiosDialog[\s\S]{0,500}onReorder=\{reorderStudios\}/)
  assert.doesNotMatch(source, /className="dsh-wt_search"/)
  assert.match(source, /search=\{\{[\s\S]{0,800}onClose: closeSearch/)
  assert.match(section, /data-searching=/)
  assert.match(section, /dsh-wt_searchSlot/)
})
