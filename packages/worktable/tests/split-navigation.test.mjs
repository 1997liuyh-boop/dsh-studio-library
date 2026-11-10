import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const require = createRequire(new URL('../package.json', import.meta.url))
const { JSDOM } = require('jsdom')
const { build } = require('esbuild')

test('从其他主页面返回后等聊天挂载，连续点击只打开最后一个工作室，卸载撤销导航', async () => {
  const dom = new JSDOM('<body><main>IM 机器人</main></body>')
  const opened = []
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/splitNavigation.ts', import.meta.url))], bundle: true,
    write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'split-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/split$/ }, () => ({ path: 'split-fixture', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const splitStore = { open: spec => globalThis.openSplitFixture(spec) }' }))
    } }],
  })
  const module = { exports: {} }
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, document: dom.window.document,
    MutationObserver: dom.window.MutationObserver, setTimeout, clearTimeout, openSplitFixture: spec => { opened.push(spec.id); return true } })
  const { installSplitNavigation, openStudioSplit } = module.exports
  let navigated = 0
  const release = installSplitNavigation(() => { navigated++ })
  try {
    const first = openStudioSplit({ id: 'old' })
    const second = openStudioSplit({ id: 'new' })
    assert.deepEqual(opened, [])
    dom.window.document.body.innerHTML = '<div data-phase="hero"><main>聊天</main></div>'
    assert.equal(await first, false)
    assert.equal(await second, true)
    assert.deepEqual(opened, ['new'])
    assert.equal(navigated, 2)
    dom.window.document.body.innerHTML = '<main>IM</main>'
    const pending = openStudioSplit({ id: 'disposed' })
    release()
    dom.window.document.body.innerHTML = '<div data-phase="hero"><main>聊天</main></div>'
    assert.equal(await pending, false)
    assert.deepEqual(opened, ['new'])
  } finally { release(); dom.window.close() }
})
