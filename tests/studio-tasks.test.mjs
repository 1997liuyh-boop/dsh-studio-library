import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const projects = [
  { id: 'travel', name: '旅行', tasks: [] },
  { id: 'design', name: '设计工作室', tasks: [
    { id: 'generate', label: '实现设计稿', text: '通过 MCP 读取指定节点或当前选区并实现页面。' },
    { id: 'rules', label: '生成设计规则', text: '根据当前项目生成或更新设计规则。' },
  ] },
]

async function load(t) {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-studio-tasks-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  await build({ entryPoints: ['packages/runtime/src/studioTasks.ts'], outfile: join(temp, 'tasks.mjs'), bundle: true, format: 'esm', platform: 'node' })
  return import(pathToFileURL(join(temp, 'tasks.mjs')).href)
}

test('消息开头的「@工作室 任务标题」展开为任务文本，补充内容另起一行', async t => {
  const { expandStudioTask } = await load(t)
  assert.equal(expandStudioTask('@工作室:design 实现设计稿', projects), '@工作室:design 通过 MCP 读取指定节点或当前选区并实现页面。')
  assert.equal(expandStudioTask('@设计工作室 实现设计稿 https://mastergo.com/file/1?layer_id=2', projects), '@工作室:design 通过 MCP 读取指定节点或当前选区并实现页面。\nhttps://mastergo.com/file/1?layer_id=2')
  assert.equal(expandStudioTask('@工作室：design 生成设计规则：只看 docs 目录', projects), '@工作室:design 根据当前项目生成或更新设计规则。\n只看 docs 目录')
  assert.equal(expandStudioTask('  @design 实现设计稿\n', projects), '@工作室:design 通过 MCP 读取指定节点或当前选区并实现页面。')
  // 标题不完整、工作室不存在、没有空格分隔或提及不在开头时都不展开。
  for (const text of ['@工作室:design 实现设计', '@工作室:design 实现设计稿样式', '@工作室:travel 实现设计稿', '@设计工作室实现设计稿', '请 @工作室:design 实现设计稿', '@工作室:design', '普通消息']) {
    assert.equal(expandStudioTask(text, projects), text, text)
  }
})

test('pre-step 只改用户直接输入的文本块，展开后的消息被冻结，拒绝决定原样返回', async t => {
  const { installStudioTasks } = await load(t)
  let listener, options
  const disposers = []
  const ctx = { on(event, callback, opts) { assert.equal(event, 'agent/pre-step'); listener = callback; options = opts; return () => {} }, effect(callback) { disposers.push(callback()) } }
  installStudioTasks(ctx, { list: () => projects })
  assert.equal(options.prepend, true)
  assert.equal(disposers.length, 1)
  const user = Object.freeze({ id: 'm1', role: 'user', source: { kind: 'user' }, content: Object.freeze([Object.freeze({ type: 'text', text: '@工作室:design 实现设计稿' }), Object.freeze({ type: 'image', data: 'x' })]) })
  const context = { id: 'm2', role: 'user', source: { kind: 'context', provider: 'x' }, content: [{ type: 'text', text: '@工作室:design 实现设计稿' }] }
  const plain = { id: 'm3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
  const decision = await listener({ messages: [user, context, plain] }, async () => ({ kind: 'enter', messages: [user, context, plain] }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages[0].id, 'm1')
  assert.equal(decision.messages[0].content[0].text, '@工作室:design 通过 MCP 读取指定节点或当前选区并实现页面。')
  assert.deepEqual(decision.messages[0].content[1], { type: 'image', data: 'x' })
  assert.ok(Object.isFrozen(decision.messages[0]) && Object.isFrozen(decision.messages[0].content[0]))
  assert.equal(user.content[0].text, '@工作室:design 实现设计稿')
  assert.equal(decision.messages[1], context)
  assert.equal(decision.messages[2], plain)
  assert.deepEqual(await listener({ messages: [] }, async () => ({ kind: 'reject' })), { kind: 'reject' })
  // 目录里没有任何快捷任务时直接返回下游决定，不复制消息。
  const untouched = { kind: 'enter', messages: [user] }
  installStudioTasks(ctx, { list: () => [{ id: 'travel', name: '旅行', tasks: [] }] })
  assert.equal(await listener({ messages: [user] }, async () => untouched), untouched)
})

test('冒号写法：@工作室名:任务、@工作室:id:任务 id、芯片后接「:任务」都展开，任务后面的文字作为需求', async t => {
  const { expandStudioTask } = await load(t)
  const generate = '@工作室:design 通过 MCP 读取指定节点或当前选区并实现页面。'
  assert.equal(expandStudioTask('@设计工作室:实现设计稿 用项目已有的头部组件', projects), generate + '\n用项目已有的头部组件')
  assert.equal(expandStudioTask('@设计工作室：实现设计稿', projects), generate, '全角冒号，没有补充时只展开任务文本')
  assert.equal(expandStudioTask('@工作室:design:generate https://mastergo.com/file/1?layer_id=2', projects), generate + '\nhttps://mastergo.com/file/1?layer_id=2', '输入框芯片序列化的写法，按任务 id 匹配')
  assert.equal(expandStudioTask('@工作室:design :实现设计稿 只改首页', projects), generate + '\n只改首页', '芯片之后再输入「:任务」')
  assert.equal(expandStudioTask('@design:rules', projects), '@工作室:design 根据当前项目生成或更新设计规则。', '按工作室 id 与任务 id')
  assert.equal(expandStudioTask('@设计工作室 generate 补充', projects), generate + '\n补充', '空格写法也接受任务 id')
  // 任务不存在、任务名不完整、工作室名后粘连文字时都不展开。
  for (const text of ['@设计工作室:不存在的任务 x', '@设计工作室:实现设计', '@设计工作室实现设计稿 x', '@工作室:design:', '@工作室:设计工作室:实现设计稿']) {
    assert.equal(expandStudioTask(text, projects), text, text)
  }
})
