
export function hostWebSocketUrl(
  path: string,
  surface: { href: string; protocol: string; streamBaseUrl?: string } = {
    href: location.href,
    protocol: location.protocol,
    streamBaseUrl: (globalThis as any).__DSH_TRANSPORT__?.streamBaseUrl,
  },
): string {
  const desktop = surface.protocol === 'dsh-app:'
  if (desktop && !surface.streamBaseUrl) throw new Error('Desktop Host stream URL unavailable')
  const url = new URL(path, desktop ? surface.streamBaseUrl : surface.href)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Unsupported Host transport protocol: ' + url.protocol)
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}


export function worktableUpgrade(protocol = typeof location === 'undefined' ? 'http:' : location.protocol) {
  const desktop = protocol === 'dsh-app:'
  const command = 'dsh plugin --profile ' + (desktop ? 'desktop' : 'web') + ' add "<已验证兼容的 dsh-worktable.tgz 本地路径>"'
  const prompt = desktop
    ? '帮我升级定制版 dsh-worktable。先从 1997liuyh-boop/deepseek-harness 的 worktable-v 发布中取得插件包并核对兼容版本，再定位桌面端自带的 dsh CLI 并准备更新，提醒我完整退出桌面端。确认退出后将实际包路径填入 ' + command + '。不要修改 web profile，不要自动杀进程或重启；完成后提醒我手动重新打开桌面端。'
    : '帮我升级 dsh-worktable：执行 ' + command + '，完成后提醒我重启 dsh web 并刷新页面'
  return { command, prompt, desktop }
}
