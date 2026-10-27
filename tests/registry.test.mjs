import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('新工作室登记后提供独立资源，停用即撤销，并拒绝编码越界',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'dsh-studio-registry-'))
  t.after(()=>rm(temp,{recursive:true,force:true}))
  await build({entryPoints:['packages/runtime/src/registry.ts'],outfile:join(temp,'registry.mjs'),bundle:true,format:'esm',platform:'node'})
  const {StudioProjects}=await import(pathToFileURL(join(temp,'registry.mjs')).href)
  const registry=new StudioProjects()
  const root=join(temp,'page');await mkdir(root);await writeFile(join(root,'index.html'),'独立工作室')
  const dispose=registry.register({id:'new-studio',root})
  assert.throws(()=>registry.register({id:'new-studio',root}),/已注册/)
  assert.throws(()=>registry.register({id:'../escape',root}),/无效/)
  const server=createServer((req,res)=>registry.handle(req,res,new URL(req.url,'http://localhost').pathname))
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(()=>new Promise(done=>server.close(done)))
  const origin='http://127.0.0.1:'+server.address().port
  const request=(suffix='',options={})=>fetch(origin+'/studio-projects/new-studio'+suffix,options)
  const html=await(await request()).text()
  assert.match(html,/独立工作室/)
  assert.match(html,/control\/bridge\.js/)
  assert.equal((await request('',{method:'HEAD'})).status,200)
  assert.equal((await request('',{method:'POST'})).status,405)
  assert.equal((await request('/%2e%2e%2fregistry.mjs')).status,404)
  assert.equal((await request('/..%5cregistry.mjs')).status,404)
  dispose()
  assert.equal((await request()).status,404)
  assert.equal(await(await import('node:fs/promises')).readFile(join(root,'index.html'),'utf8'),'独立工作室')
})
