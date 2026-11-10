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
const compiled = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/StudioUpdates.tsx', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react','react-dom','react/jsx-runtime'] }).outputFiles[0].text
const module = { exports: {} }
runInNewContext(compiled,{module,exports:module.exports,require,document:{get body(){return globalThis.document.body}},AbortController,setTimeout,clearTimeout,setInterval,clearInterval,fetch:(...args)=>globalThis.fetch(...args)})
const { StudioUpdates } = module.exports
const localeCode = buildSync({entryPoints:[fileURLToPath(new URL('../src/client/locales.ts',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text
const localeModule={exports:{}}
runInNewContext(localeCode,{module:localeModule,exports:localeModule.exports})
const { zh,en }=localeModule.exports
const flush=()=>new Promise(setImmediate)

async function ui(t, report, fetcher, language='zh') {
  const dom=new JSDOM('<div id="root"></div>',{url:'http://dsh.local'})
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true}
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'))}
  const saved=new Map()
  const fetch=async(url,options)=>fetcher?fetcher(url,options):{ok:true,json:async()=>report}
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true,fetch})) {
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  const dictionary=language==='zh'?zh:en
  const translate=(key,params={})=>dictionary[key].replace(/\{(\w+)\}/g,(_,name)=>params[name]??'')
  const root=createRoot(dom.window.document.getElementById('root'))
  await act(async()=>root.render(React.createElement(StudioUpdates,{t:translate,icon:'↻'})))
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}})
  const dialog=dom.window.document.querySelector('dialog')
  const click=async button=>act(async()=>{button.click();await flush()})
  await click(dom.window.document.querySelector('button'))
  return {dom,dialog,click,translate,rows:()=>[...dialog.querySelectorAll('article')].map(row=>({name:row.querySelector('h3').textContent,lines:[...row.querySelectorAll('p')].map(node=>node.textContent),buttons:[...row.querySelectorAll('button')].map(node=>node.textContent)}))}
}

const row={id:'test',name:'测试工作室',packageName:'dsh-studio-test',version:'1.0.0',upstreamVersion:'3.4.8',repository:'owner/dsh-studio-test',state:'idle'}
test('统一面板列出版本，未发布状态不显示安装按钮，并匹配用户文案快照',async t=>{
  const report={hostVersion:'0.2.2-rc.1',busy:false,studios:[{...row}]}
  const screen=await ui(t,report,async(url,options)=>{if(options.method==='POST')report.studios[0].state='unpublished';return{ok:true,json:async()=>structuredClone(report)}})
  assert.equal(screen.dialog.open,true)
  assert.equal(screen.dialog.parentElement,screen.dom.window.document.body)
  screen.dom.window.document.getElementById('root').hidden=true
  assert.equal(screen.dialog.isConnected,true)
  assert.equal(screen.dialog.open,true)
  await screen.click([...screen.dialog.querySelectorAll('button')].find(button=>button.textContent==='检查全部'))
  const expected=JSON.parse(readFileSync(new URL('./expected/studio-updates.json',import.meta.url),'utf8'))
  assert.deepEqual(screen.rows(),expected.unpublished)
  assert.equal(screen.dialog.querySelectorAll('[role="alert"]').length,0)
})

test('安装期间按钮禁用，关闭并重开仍能读取后台进度及需要重启结果',async t=>{
  const report={hostVersion:'0.2.2-rc.1',busy:false,studios:[{...row,state:'available',latest:'1.1.0'}]}
  let finish
  const screen=await ui(t,report,async(url,options)=>{
    if(url.endsWith('/install')){report.busy=true;report.studios[0].operation={id:'update',studio:'test',from:'1.0.0',to:'1.1.0',phase:'installing'};await new Promise(resolve=>{finish=resolve})}
    return{ok:true,json:async()=>structuredClone(report)}
  })
  await screen.click([...screen.dialog.querySelectorAll('button')].find(button=>button.textContent==='升级至 v1.1.0'))
  assert.equal([...screen.dialog.querySelectorAll('article button')].every(button=>button.disabled),true)
  await screen.click([...screen.dialog.querySelectorAll('button')].find(button=>button.textContent==='关闭'))
  assert.equal(screen.dialog.open,false)
  await screen.click(screen.dom.window.document.querySelector('button'))
  assert.match(screen.dialog.textContent,/dsh 正在安装更新/)
  report.busy=false;report.studios[0].state='idle';report.studios[0].operation.phase='restart-required'
  await act(async()=>{finish();await flush();await flush()})
  assert.match(screen.dialog.textContent,/请完整重启 dsh 后使用/)
  assert.doesNotMatch(screen.rows()[0].buttons.join(' '),/升级至/)
})

test('连接错误保留可重试提示，英文词典和恢复错误均可见',async t=>{
  let broken=true
  const report={hostVersion:'0.2.2-rc.1',busy:false,issue:'record',studios:[{...row,state:'available',latest:'1.1.0'}]}
  const screen=await ui(t,report,async()=>broken?{ok:false,status:503}:{ok:true,json:async()=>report},'en')
  assert.match(screen.dialog.querySelector('[role="alert"]').textContent,/Cannot reach the update service/)
  broken=false
  await screen.click([...screen.dialog.querySelectorAll('button')].find(button=>button.textContent==='Retry'))
  assert.match(screen.dialog.querySelector('[role="alert"]').textContent,/Update history cannot be read/)
  assert.equal([...screen.dialog.querySelectorAll('button')].find(button=>button.textContent==='Update to v1.1.0').disabled,true)
})
