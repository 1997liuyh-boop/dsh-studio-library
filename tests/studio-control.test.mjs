import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('工作室控制校验领取者、取消、停用和超时，不重复派发', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-studio-control-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  await build({ entryPoints: ['packages/runtime/src/studioControl.ts'], outfile: join(temp, 'control.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [{ name: '工具声明桩', setup(builder) { builder.onResolve({ filter: /^@deepseek-ai\/dsh-tools$/ }, () => ({ path: 'tools', namespace: 'stub' })); builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const defineTool = value => value' })) } }] })
  const { StudioControl, installStudioControl } = await import(pathToFileURL(join(temp, 'control.mjs')))
  const pages = new Set(['cineflow'])
  const registry = { has: id => pages.has(id), list: () => [...pages].map(id => ({ id, name: '影音工作室' })) }
  const broker = new StudioControl(registry, 40)
  t.after(() => broker.dispose())
  const signal = new AbortController()
  const result = broker.request({ action: 'read', studio: 'cineflow' }, signal.signal)
  const command = broker.claim('owner')
  assert.equal(broker.claim('another'), null)
  assert.equal(broker.complete(command.id, 'another', {}), false)
  assert.equal(broker.complete(command.id, 'owner', { text: '真实页面' }), true)
  assert.deepEqual(await result, { text: '真实页面' })
  assert.equal(broker.complete(command.id, 'owner', {}), false)
  const cancelled = broker.request({ action: 'click', studio: 'cineflow' }, signal.signal)
  const rejection = assert.rejects(cancelled, /取消/)
  signal.abort()
  await rejection
  assert.equal(broker.claim('owner'), null)
  const disabled = broker.request({ action: 'open', studio: 'cineflow' }, new AbortController().signal)
  const disabledResult = assert.rejects(disabled, /停用/)
  pages.clear()
  broker.claim('owner')
  await disabledResult
  await assert.rejects(broker.request({ action: 'read', studio: 'cineflow' }, new AbortController().signal), /未安装/)
  pages.add('cineflow')
  await assert.rejects(broker.request({ action: 'open', studio: 'cineflow' }, new AbortController().signal), /超时/)
  let tool
  let prompt
  const cleanup = []
  const registered = installStudioControl({ effect: callback => cleanup.push(callback()), tools: { register: value => { tool = value } }, systemPrompt: { section: value => { prompt = value } } }, registry)
  assert.equal(tool.name, 'studio')
  assert.match(prompt.text(), /主窗口或悬浮球/)
  assert.match(prompt.text(), /@工作室:id/)
  assert.match(prompt.text(), /保持当前会话/)
  const listed = JSON.parse(await tool.execute({ action: 'list' }, { signal: new AbortController().signal }))
  assert.equal(listed.studios[0].id, 'cineflow')
  registered.dispose()
  for (const dispose of cleanup) dispose()
})
