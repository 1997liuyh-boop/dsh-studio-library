import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 文件索引是安装顺序的唯一来源，路径必须留在库内。 */
export async function validateCatalog(root) {
  const catalog=JSON.parse(await readFile(join(root,'catalog.json'),'utf8'))
  if (catalog.schemaVersion!==1 || !Array.isArray(catalog.packages)) throw new Error('工作库索引版本无效')
  const ids=new Set(),names=new Set(),paths=new Set()
  for (const item of catalog.packages) {
    if (!/^[a-z][a-z0-9-]*$/.test(item.id) || !/^(?:packages|studios)\/[a-z][a-z0-9-]*$/.test(item.path) || ids.has(item.id) || paths.has(item.path)) throw new Error('索引标识或路径重复、无效：'+item.id)
    ids.add(item.id);paths.add(item.path)
    const pkg=JSON.parse(await readFile(join(root,item.path,'package.json'),'utf8'))
    if (names.has(pkg.name) || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('包名重复或版本无效：'+pkg.name)
    names.add(pkg.name)
    if (item.path.startsWith('studios/')) {
      const studio=JSON.parse(await readFile(join(root,item.path,'studio.json'),'utf8'))
      if (studio.schemaVersion!==1 || studio.id!==item.id || pkg.name!=='dsh-studio-'+item.id || studio.entry!=='/studio-projects/'+item.id || !studio.name || typeof studio.icon!=='string' || typeof studio.description!=='string' || !Number.isFinite(studio.order) || !studio.compatibility?.host || !studio.compatibility?.runtime || !studio.compatibility?.worktable || !Array.isArray(studio.capabilities) || studio.capabilities.some(value=>typeof value!=='string') || studio.service && !/^scripts\/[a-z][a-z0-9-]*\.ps1$/.test(studio.service.windows)) throw new Error('工作室声明无效：'+item.id)
    }
  }
  if (catalog.kind === 'studio' ? catalog.packages.length !== 1 || !catalog.packages[0].path.startsWith('studios/') : catalog.packages[0]?.id !== 'worktable' || catalog.packages[1]?.id !== 'runtime') throw new Error('索引必须先加载容器和运行时')
  return catalog
}
