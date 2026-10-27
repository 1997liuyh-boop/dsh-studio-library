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
