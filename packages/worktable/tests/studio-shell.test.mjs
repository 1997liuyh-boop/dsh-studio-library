import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const pluginRequire = createRequire(new URL('../package.json', import.meta.url))
const hostRequire = createRequire(new URL('../../../package.json', import.meta.url))
const desktopRequire = createRequire(new URL('../../../package.json', import.meta.url))
const React = desktopRequire('react')
const { act } = React
const { createRoot } = desktopRequire('react-dom/client')
const { JSDOM } = hostRequire('jsdom')
const { buildSync } = pluginRequire('esbuild')
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/client/StudioSection.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
}).outputFiles[0].text
const module = { exports: {} }
runInNewContext(code, { module, exports: module.exports, require: desktopRequire })
const { StudioSection } = module.exports

test('工作室默认折叠、点击展开、窄栏点击展开侧栏、重新挂载恢复折叠', () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  const saved = new Map()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  let expandedSidebar = 0
  let mounted = 0
  let released = 0
  function Content() {
    React.useEffect(() => { mounted++; return () => { released++ } }, [])
    return React.createElement('div', null, '项目列表')
  }
  const container = document.getElementById('root')
  let root = createRoot(container)
  const render = wide => act(() => root.render(React.createElement(StudioSection, {
    wide, title: '工作室', expandSidebar: () => { expandedSidebar++ },
  }, React.createElement(Content))))
  const click = () => act(() => container.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  try {
    render(true)
    assert.equal(container.querySelector('button').getAttribute('aria-expanded'), 'false')
    assert.equal(mounted, 0)
    click()
    assert.equal(container.querySelector('button').getAttribute('aria-expanded'), 'true')
    const content = container.querySelector('[data-studio-content]')
    assert.equal(content.id, container.querySelector('button').getAttribute('aria-controls'))
    assert.ok(content.classList.contains('studio:h-60'))
    assert.ok(content.classList.contains('studio:overflow-y-auto'))
    assert.ok(content.classList.contains('studio:[scrollbar-width:none]'))
    assert.ok(content.classList.contains('studio:[&::-webkit-scrollbar]:hidden'))
    click()
    assert.equal(released, 0)
    assert.equal(mounted, 1)
    assert.equal(content.parentElement.parentElement.getAttribute('aria-hidden'), 'true')
    assert.equal(content.tabIndex, -1)
    render(false)
    click()
    assert.equal(expandedSidebar, 1)
    render(true)
    assert.ok(container.querySelector('[data-studio-content]'))
    assert.equal(content.parentElement.parentElement.getAttribute('aria-hidden'), 'false')
    assert.equal(mounted, 1)
    act(() => root.unmount())
    assert.equal(released, 1)
    root = createRoot(container)
    render(true)
    assert.equal(container.querySelector('[data-studio-content]'), null)
  } finally {
    act(() => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})

test('分屏与工作室通过当前宿主插槽挂载', () => {
  const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(source, /slots\.inject\('sidebar.footer.action'/)
  assert.match(source, /slots\.inject\('shell.overlay'/)
  assert.match(source, /entriesOfSlot\('sidebar.worktable.project'/)
})
