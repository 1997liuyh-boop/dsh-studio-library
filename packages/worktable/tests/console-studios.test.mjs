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
async function render(t, studios, report, catalog = { studios: [] }, calls = [], services = { before: [], after: [] }) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://dsh.local' })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  const saved = new Map()
  let started = false
  const fetch = async (url, options) => {
    calls.push([url, options?.body ?? null])
    if (url === '/studio-projects/control/studios') return { ok: true, json: async () => catalog }
    if (url === '/studio-projects/control/services') return { ok: true, json: async () => ({ services: started ? services.after : services.before }) }
    if (url === '/studio-projects/control/start') { started = true; return { ok: true, json: async () => ({ failures: [], services: services.after }) } }
    return { ok: true, json: async () => report }
  }
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

test('控制台弹窗：侧栏 studio- 前缀映射到版本号、地址小字与「有更新」标记', async (t) => {
  const studios = [{ id: 'studio-travel', studioId: 'travel', name: '旅行', icon: '🧭' }, { id: 'studio-media', studioId: 'media', name: '影音' }]
  const catalog = { studios: [
    { id: 'travel', name: '旅行', version: '1.2.0', source: 'github', address: 'https://github.com/owner/dsh-studio-travel' },
    { id: 'media', name: '影音', version: '0.4.1', source: 'local', address: 'D:\\studios\\media' },
  ] }
  const report = { hostVersion: '0.2.2', busy: false, studios: [
    { id: 'travel', name: '旅行', version: '1.2.0', state: 'available', latest: '1.3.0' },
    { id: 'media', name: '影音', version: '0.4.1', state: 'latest' },
  ] }
  const { dialog } = await render(t, studios, report, catalog)
  assert.equal(dialog.open, true)
  assert.equal(dialog.querySelector('h2').textContent, '控制台')
  assert.equal(dialog.querySelectorAll('p').length, 0)
  const rows = [...dialog.querySelectorAll('[data-console-studio]')]
  assert.deepEqual(rows.map(row => row.getAttribute('data-console-studio')), ['studio-travel', 'studio-media'])
  assert.equal(rows[0].querySelector('[data-version]').textContent, 'v1.2.0')
  assert.equal(rows[1].querySelector('[data-version]').textContent, 'v0.4.1')
  assert.equal(rows[0].querySelector('a[data-address]').getAttribute('href'), 'https://github.com/owner/dsh-studio-travel')
  assert.equal(rows[1].querySelector('[data-address]').textContent, 'D:\\studios\\media')
  assert.ok(rows[0].querySelector('[data-update-tag]'))
  assert.equal(rows[1].querySelector('[data-update-tag]'), null)
  assert.ok(rows.every(row => row.querySelector('[data-grip]')))
})

test('未检查过的工作室打开弹窗时自动检查更新', async (t) => {
  const studios = [{ id: 'studio-film', studioId: 'film', name: '剧' }]
  const calls = []
  const report = { hostVersion: '', busy: false, studios: [{ id: 'film', name: '剧', version: '0.2.3', state: 'idle' }] }
  await render(t, studios, report, { studios: [] }, calls)
  assert.ok(calls.some(([url, body]) => url === '/studio-projects/updates/check' && body === JSON.stringify({ id: 'film' })))
})

test('服务未连接时显示一键启动与单行启动，启动后显示已连接', async (t) => {
  const studios = [{ id: 'studio-media', studioId: 'media', name: '短剧' }, { id: 'studio-travel', studioId: 'travel', name: '旅行' }]
  const calls = []
  const services = {
    before: [{ id: 'media', title: 'AI短剧工作台', ready: false, startable: true, starting: false }],
    after: [{ id: 'media', title: 'AI短剧工作台', ready: true, startable: true, starting: false }],
  }
  const { dom, dialog } = await render(t, studios, { hostVersion: '', busy: false, studios: [] }, { studios: [] }, calls, services)
  const media = () => dialog.querySelector('[data-console-studio="studio-media"]')
  assert.equal(media().querySelector('[data-service]').getAttribute('data-service'), 'offline')
  assert.ok(dialog.querySelector('[data-start-all]'))
  assert.equal(dialog.querySelector('[data-console-studio="studio-travel"] [data-service]'), null)
  await act(async () => { media().querySelector('[data-start="media"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await flush(); await flush() })
  assert.ok(calls.some(([url, body]) => url === '/studio-projects/control/start' && body === JSON.stringify({ studio: 'media' })))
  assert.equal(media().querySelector('[data-service]').getAttribute('data-service'), 'ready')
  assert.equal(dialog.querySelector('[data-start-all]'), null)
})

test('工作室库主插件显示版本与有更新，点击升级调用安装接口', async (t) => {
  const calls = []
  const report = { hostVersion: '0.2.2-rc.1', busy: false, studios: [
    { id: 'library', name: '工作室库', version: '0.1.8', state: 'available', latest: '0.1.9' },
    { id: 'film', name: '剧', version: '0.2.3', state: 'available', latest: '0.2.4' },
  ] }
  const { dom, dialog } = await render(t, [{ id: 'studio-film', studioId: 'film', name: '剧' }], report, { studios: [] }, calls)
  const line = dialog.querySelector('[data-library]')
  assert.match(line.textContent, /工作室库 v0\.1\.8/)
  assert.match(line.textContent, /有更新 v0\.1\.9/)
  assert.ok(dialog.querySelector('[data-console-studio="studio-film"] [data-upgrade="film"]'))
  await act(async () => { line.querySelector('[data-upgrade="library"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await flush(); await flush() })
  assert.ok(calls.some(([url, body]) => url === '/studio-projects/updates/install' && body === JSON.stringify({ id: 'library', version: '0.1.9' })))
})

test('没有子工作室时只显示空状态图，不显示说明文字', async (t) => {
  const { dialog } = await render(t, [], { hostVersion: '', busy: false, studios: [] })
  const image = dialog.querySelector('[data-console-empty] img')
  assert.equal(image.getAttribute('src'), 'https://img.aigengtu.com/meme/2279.gif')
  assert.equal(dialog.querySelectorAll('p').length, 0)
})

test('抓手键盘排序提交新顺序', async (t) => {
  const studios = [{ id: 'a', studioId: 'a', name: '甲' }, { id: 'b', studioId: 'b', name: '乙' }]
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
  assert.match(source, /ref=\{consoleEntryRef\}[\s\S]{0,120}onClick=\{\(\) => setConsoleListOpen\(true\)\}/)
  assert.match(source, /studioId: id\.startsWith\('studio-'\)/)
  assert.match(source, /<ConsoleStudiosDialog[\s\S]{0,500}onReorder=\{reorderStudios\}/)
  assert.doesNotMatch(source, /className="dsh-wt_search"/)
  assert.match(source, /search=\{\{[\s\S]{0,800}onClose: closeSearch/)
  assert.match(section, /data-searching=/)
  assert.match(section, /dsh-wt_searchSlot/)
})
