import { fileURLToPath } from 'node:url'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { validateCatalog } from './catalog.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
const catalog=await validateCatalog(root)
for (const item of catalog.packages) {
  const dir=join(root,item.path)
  for (const file of ['lib/index.js','README.md','LICENSE','dsh.plugin.json']) await access(join(dir,file))
  if (item.path.startsWith('studios/')) for (const file of ['lib/client.js','static/index.html']) await access(join(dir,file))
  const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'))
  const manifest=JSON.parse(await readFile(join(dir,'dsh.plugin.json'),'utf8'))
  if (pkg.name!==manifest.name || pkg.version!==manifest.version) throw new Error('产物与声明版本不一致：'+item.id)
}
console.log('工作库索引与 '+catalog.packages.length+' 个独立包产物一致')
