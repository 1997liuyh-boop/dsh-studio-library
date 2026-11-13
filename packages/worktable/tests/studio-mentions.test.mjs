import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
const require = createRequire(import.meta.url)
const { buildSync } = require('esbuild')
const code = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/studioMentions.ts', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node' }).outputFiles[0].text

test('@ 工作室候选读取已启用目录，提交保留确定的目标 id，停用后阻止旧引用', async () => {
  const module = { exports: {} }
  let projects = [{ id: 'travel', name: '旅行', description: '旅行地图' }, { id: 'cineflow', name: '影音工作室', description: '影片' }]
  runInNewContext(code, { module, exports: module.exports, fetch: async () => ({ ok: true, json: async () => projects }) })
  let source
  let disposed = false
  const scope = { inputTriggers: { registerSource(value) { source = value; return () => { disposed = true } } }, effect: fn => fn() }
  const ctx = { inject: (_keys, fn) => fn(scope) }
  module.exports.installStudioMentions(ctx, key => key)
  const rows = await source.candidates({}, { query: '旅行', signal: new AbortController().signal })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].value, 'travel')
  const chosen = source.onPick({ candidate: rows[0] })
  assert.equal(chosen.insert.source, 'studio')
  assert.equal(await source.codec.serialize(chosen.insert.ref), '@工作室:travel')
  projects = []
  assert.equal((await source.candidates({}, { query: '', signal: new AbortController().signal })).length, 0)
  await assert.rejects(source.codec.serialize('travel'), /mentions.disabled/)
  assert.equal(disposed, false)
})

test('@ 候选在输入关键词后列出「工作室名:任务」，芯片序列化为 @工作室:<id>:<任务 id>，任务下架后阻止旧引用', async () => {
  const module = { exports: {} }
  let projects = [{ id: 'design', name: '设计工作室', description: '设计', tasks: [{ id: 'generate', label: '实现设计稿', description: '读取并实现页面' }, { id: 'rules', label: '生成设计规则', description: '规则' }] }]
  runInNewContext(code, { module, exports: module.exports, fetch: async () => ({ ok: true, json: async () => projects }) })
  let source
  const scope = { inputTriggers: { registerSource(value) { source = value; return () => {} } }, effect: fn => fn() }
  module.exports.installStudioMentions({ inject: (_keys, fn) => fn(scope) }, key => key)
  const signal = new AbortController().signal
  assert.deepEqual((await source.candidates({}, { query: '', signal })).map(row => row.value).join(','), 'design', '空的 @ 只列工作室')
  const rows = await source.candidates({}, { query: '设计工作室：实现', signal })
  assert.equal(rows.map(row => row.label).join(','), '设计工作室:实现设计稿')
  assert.equal(rows[0].description, '读取并实现页面')
  const chosen = source.onPick({ candidate: rows[0] })
  assert.equal(chosen.insert.clipboardText, '@设计工作室:实现设计稿')
  assert.equal(await source.codec.serialize(chosen.insert.ref, signal), '@工作室:design:generate')
  assert.equal((await source.candidates({}, { query: '设计', signal })).length, 3, '工作室本身加它的两个任务')
  projects = [{ ...projects[0], tasks: [] }]
  await assert.rejects(source.codec.serialize('design:generate', signal), /mentions.disabled/)
  assert.equal(await source.codec.serialize('design', signal), '@工作室:design')
})
