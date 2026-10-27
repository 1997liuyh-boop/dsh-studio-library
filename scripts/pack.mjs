import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { validateCatalog } from './catalog.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
const catalog=await validateCatalog(root)
const npmCli=process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')
await mkdir(join(root,'artifacts'),{recursive:true})
const artifacts=[]
for (const item of catalog.packages) {
  const result=spawnSync(process.execPath,[npmCli,'pack','--json','--pack-destination',join(root,'artifacts')],{cwd:join(root,item.path),encoding:'utf8'})
  if (result.status!==0) throw new Error('打包失败：'+item.id+' '+result.stderr)
  const [pack]=JSON.parse(result.stdout)
  artifacts.push({id:item.id,name:pack.name,version:pack.version,file:pack.filename,sha256:createHash('sha256').update(await readFile(join(root,'artifacts',pack.filename))).digest('hex')})
}
await writeFile(join(root,'artifacts/manifest.json'),JSON.stringify({schemaVersion:1,artifacts},null,2)+'\n')
console.log('已生成 '+artifacts.length+' 个安装包和 SHA256 清单')
