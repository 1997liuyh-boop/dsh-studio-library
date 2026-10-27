import { readFile, access, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
const [id,destination]=process.argv.slice(2)
if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || !destination || !isAbsolute(destination)) throw new Error('用法：node scripts/prepare-upstream.mjs 工作室标识 全新绝对目录')
const root=fileURLToPath(new URL('../',import.meta.url))
const studio=join(root,'studios',id)
const upstream=JSON.parse(await readFile(join(studio,'UPSTREAM.json'),'utf8'))
if (!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(upstream.repository) || !/^[a-f0-9]{40}$/.test(upstream.commit)) throw new Error('该工作室没有可检出的固定上游提交')
const target=resolve(destination)
let exists=true
try {await access(target)} catch(error) {if(error.code!=='ENOENT')throw error;exists=false}
if(exists)throw new Error('目标目录已存在，请使用全新目录；未覆盖任何文件')
await mkdir(resolve(target,'..'),{recursive:true})
const run=(args,cwd)=>new Promise((done,fail)=>{const child=spawn('git',args,{cwd,stdio:'inherit'});child.once('error',fail);child.once('exit',code=>code===0?done():fail(new Error('上游准备失败，已保留现场：'+target)))})
await run(['clone','--no-checkout',upstream.repository+'.git',target],root)
await run(['checkout','--detach',upstream.commit],target)
for(const relative of (upstream.adaptation ?? []).filter(path=>path.startsWith('patches/') && path.endsWith('.patch'))) {
  if(relative.includes('..') || relative.includes('\\'))throw new Error('补丁路径无效')
  const patch=join(studio,relative)
  await run(['apply','--check',patch],target)
  await run(['apply',patch],target)
}
console.log('上游源码及本地适配已准备到：'+target)
