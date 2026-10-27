import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { validateCatalog } from './catalog.mjs'

const root = fileURLToPath(new URL('../',import.meta.url))
const catalog = await validateCatalog(root)
const selected = process.argv[2]
if (selected && !catalog.packages.some(item=>item.id===selected)) throw new Error('工作室不存在：'+selected)
const run = (args,cwd) => new Promise((done,fail)=>{const child=spawn(process.execPath,args,{cwd,stdio:'inherit'});child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error('构建退出：'+code)))})
const css = async path => (await postcss([tailwind()]).process(await readFile(path,'utf8'),{from:path})).css
const cardCss=await css(join(root,'packages/sdk/card.css'))
for (const item of catalog.packages.filter(item=>!selected || item.id===selected)) {
  const dir=join(root,item.path)
  if (item.id==='worktable') {await run(['build.mjs'],dir);continue}
  await mkdir(join(dir,'lib'),{recursive:true})
  if (item.id==='runtime') {
    await build({entryPoints:[join(root,'packages/sdk/controlBridge.ts')],outfile:join(dir,'static/controlBridge.js'),bundle:true,platform:'browser',format:'iife',target:'es2022'})
    await build({entryPoints:[join(dir,'src/server.ts')],outfile:join(dir,'lib/index.js'),bundle:true,platform:'node',format:'esm',target:'node22',external:['@deepseek-ai/*']})
    const manifest=JSON.parse(await readFile(join(dir,'dsh.plugin.json'),'utf8'));manifest.version='0.5.0'
    await writeFile(join(dir,'dsh.plugin.json'),JSON.stringify(manifest,null,2)+'\n')
    await mkdir(join(dir,'static/legacy'),{recursive:true})
    await build({entryPoints:[join(dir,'src/legacy/main.tsx')],outfile:join(dir,'static/legacy/app.js'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'}})
    await writeFile(join(dir,'static/legacy/app.css'),await css(join(dir,'src/legacy/style.css')))
    await writeFile(join(dir,'static/legacy/index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作室旧记录</title><link rel="stylesheet" href="/studio-projects/legacy/app.css"></head><body><div id="root"></div><script type="module" src="/studio-projects/legacy/app.js"></script></body></html>')
    continue
  }
  const studio=JSON.parse(await readFile(join(dir,'studio.json'),'utf8'))
  const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'))
  await build({entryPoints:[join(root,item.id==='travel'?'studios/travel/src/index.ts':'packages/sdk/entry.ts')],outfile:join(dir,'lib/index.js'),bundle:true,platform:'node',format:'esm',target:'node22',external:['./atlas.mjs'],define:{STUDIO_PROJECT_ID:JSON.stringify(item.id),STUDIO_PROJECT:JSON.stringify({name:studio.name,icon:studio.icon,description:studio.description})}})
  await build({entryPoints:[join(root,'packages/sdk/client.tsx')],outfile:join(dir,'lib/client.js'),bundle:true,format:'cjs',platform:'browser',jsx:'automatic',external:['react','react/jsx-runtime'],define:{STUDIO_CARD_CSS:JSON.stringify(cardCss),STUDIO_PROJECT:JSON.stringify(studio),STUDIO_PROJECT_ORDER:String(studio.order)},banner:{js:`window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`},footer:{js:'return module.exports;}});'}})
  await writeFile(join(dir,'dsh.plugin.json'),JSON.stringify({name:pkg.name,version:pkg.version,description:studio.description,entry:{name:pkg.name,inject:['studioProjects']},client:{platform:'web'}},null,2)+'\n')
  if (item.id==='travel') {
    await writeFile(join(dir,'lib/atlas.mjs'),await readFile(join(dir,'src/atlas.mjs')))
    await run([join(root,'node_modules/vite/bin/vite.js'),'build','--config',join(dir,'vite.config.mjs'),'--mode','harness'],dir)
  } else if (item.id==='cineflow') {
    await build({entryPoints:[join(root,'packages/sdk/controlBridge.ts')],outfile:join(dir,'app/electron/studioControl.js'),bundle:true,platform:'browser',format:'iife',target:'es2022'})
    const require=createRequire(join(dir,'app/package.json'))
    await run([join(dirname(require.resolve('vite/package.json')),'bin/vite.js'),'build','--config',join(dir,'app/vite.config.mjs')],join(dir,'app'))
    await writeFile(join(dir,'app/dist/studio-embedded.css'),await css(join(dir,'app/src/studio-embedded.css')))
  }
  if (item.id!=='travel') {
    await mkdir(join(dir,'static'),{recursive:true})
    const app=item.id==='fitness'?'src/app/':'src/'
    await build({entryPoints:[join(dir,app+'main.tsx')],outfile:join(dir,'static/app.js'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'}})
    await writeFile(join(dir,'static/app.css'),await css(join(dir,app+'style.css')))
    await writeFile(join(dir,'static/index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${studio.name}</title><link rel="stylesheet" href="/studio-projects/${item.id}/app.css"></head><body><div id="root"></div><script type="module" src="/studio-projects/${item.id}/app.js"></script></body></html>`)
  }
  console.log('已构建：'+studio.name)
}
