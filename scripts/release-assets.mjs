// 生成 GitHub Release 资产：工作室库主插件安装包 + manifest.json。
// 运行时的工作室更新检查读取最新 Release 中的 manifest.json，按包名匹配安装包并校验 SHA256 后安装。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = join(root, 'release')

/**
 * 从 npm pack --json 的输出中取出结果；prepare 脚本的日志可能混在 JSON 之前。
 * @param {string} stdout - npm pack 的标准输出。
 */
export function parsePackOutput(stdout) {
  const start = stdout.search(/^\[/m)
  if (start < 0) throw new Error('npm pack 没有输出打包结果')
  const [pack] = JSON.parse(stdout.slice(start))
  if (!pack || typeof pack.filename !== 'string' || typeof pack.name !== 'string' || typeof pack.version !== 'string') throw new Error('npm pack 输出无效')
  return pack
}

/**
 * 生成 Release 清单：与运行时 studioUpdates 的读取格式一致（schemaVersion 1）。
 * @param {{ name: string, version: string, filename: string }} pack - npm pack 结果。
 * @param {Buffer} bytes - 安装包内容。
 * @param {{ dsh?: string, dshReleases?: Record<string, string> }} compatibility - package.json 的 dsh.compatibility。
 */
export function releaseManifest(pack, bytes, compatibility = {}) {
  return {
    schemaVersion: 1,
    artifacts: [{
      id: 'library', name: pack.name, version: pack.version, file: pack.filename,
      dsh: compatibility.dsh ?? '', dshVersions: Object.keys(compatibility.dshReleases ?? {}),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const tag = process.env.RELEASE_TAG
  if (tag && tag !== 'v' + pkg.version) throw new Error(`标签 ${tag} 与 package.json 版本 ${pkg.version} 不一致`)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  // npm pack 会先执行 prepare（检查入口并生成 artifacts 子插件归档），再打包主插件
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', out], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('主插件打包失败：' + (result.stderr || result.stdout))
  const pack = parsePackOutput(result.stdout)
  if (pack.name !== pkg.name || pack.version !== pkg.version) throw new Error('打包结果与 package.json 不一致')
  const bytes = await readFile(join(out, pack.filename))
  await writeFile(join(out, 'manifest.json'), JSON.stringify(releaseManifest(pack, bytes, pkg.dsh?.compatibility), null, 2) + '\n')
  console.log('已生成 Release 资产：' + pack.filename + ' 与 manifest.json')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
