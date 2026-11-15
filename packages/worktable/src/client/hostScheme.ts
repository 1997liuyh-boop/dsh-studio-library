import { useEffect, useState } from 'react'

/** 深浅色方案 */
export type HostScheme = 'dark' | 'light'

/**
 * 读取当前深浅色：先看宿主 html 的 color-scheme（DSH 的深色 / 白色 / 跟随系统都会反映到它），
 * 只声明一种时以它为准；两种都声明或读不到时跟随系统设置。
 */
export function readHostScheme(): HostScheme {
  try {
    const value = getComputedStyle(document.documentElement).colorScheme || ''
    if (value.includes('dark') && !value.includes('light')) return 'dark'
    if (value.includes('light') && !value.includes('dark')) return 'light'
  } catch { /* 读不到时退回系统设置 */ }
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' } catch { return 'light' }
}

/** 控制室面板当前的深浅色（它有自己的主题设置）；控制室没打开时跟随宿主。 */
export function readConsoleScheme(): HostScheme {
  try {
    const theme = document.querySelector('.dsh-wt_console')?.getAttribute('data-wt-theme')
    if (theme === 'dark' || theme === 'light') return theme
  } catch { /* 读不到时退回宿主设置 */ }
  return readHostScheme()
}

/**
 * 跟随宿主与系统的深浅色；active 为假时不监听（弹窗关闭时不占资源）。
 * 宿主切换主题会改 html 的 class / style / data 属性，系统切换触发 prefers-color-scheme 变化。
 * @param read - 读取方式，默认读宿主；控制室里的弹窗传 readConsoleScheme。
 */
export function useHostScheme(active = true, read: () => HostScheme = readHostScheme): HostScheme {
  const [scheme, setScheme] = useState<HostScheme>(() => read())
  useEffect(() => {
    if (!active) return
    const update = () => setScheme(read())
    update()
    let media: MediaQueryList | null = null
    try { media = window.matchMedia('(prefers-color-scheme: dark)') } catch { media = null }
    media?.addEventListener?.('change', update)
    let observer: MutationObserver | null = null
    try {
      observer = new MutationObserver(update)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] })
      // 控制室有自己的主题设置：只盯它的 data-wt-theme，不监听整棵文档
      const panel = read === readHostScheme ? null : document.querySelector('.dsh-wt_console')
      if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['data-wt-theme'] })
    } catch { observer = null }
    return () => { media?.removeEventListener?.('change', update); observer?.disconnect() }
  }, [active, read])
  return scheme
}

/**
 * 弹窗内文字、边框、输入框的配色变量：弹窗不再用宿主主题的背景，里面的颜色也要跟着固定，
 * 否则遇到半透明或特殊配色的主题，文字和提示词会看不清。
 */
export function schemeVars(scheme: HostScheme): Record<string, string> {
  return scheme === 'dark'
    ? {
      '--dsw-alias-label-primary': '#f5f5f5', '--dsw-alias-label-secondary': '#a3a3a3', '--dsw-alias-label-tertiary': '#8a8a8a',
      '--dsw-alias-border-l1': 'rgba(255,255,255,0.14)', '--dsw-alias-fill-l1': 'rgba(255,255,255,0.06)', '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,0.08)',
      '--wt-placeholder': 'rgba(255,255,255,0.42)',
    }
    : {
      '--dsw-alias-label-primary': '#171717', '--dsw-alias-label-secondary': '#525252', '--dsw-alias-label-tertiary': '#737373',
      '--dsw-alias-border-l1': 'rgba(0,0,0,0.1)', '--dsw-alias-fill-l1': 'rgba(0,0,0,0.035)', '--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,0.05)',
      '--wt-placeholder': 'rgba(0,0,0,0.4)',
    }
}

/**
 * 纯色弹窗面：纯白或纯黑，不透明、不做背景模糊。
 * 宿主的部分主题 / 皮肤会把背景变量设成半透明，弹窗叠在页面上会看不清，所以这里不用主题变量。
 */
export function solidSurface(scheme: HostScheme): Record<string, string> {
  return {
    ...schemeVars(scheme),
    ...(scheme === 'dark'
      ? { backgroundColor: '#000000', color: '#f5f5f5', borderColor: 'rgba(255,255,255,0.14)', colorScheme: 'dark' }
      : { backgroundColor: '#ffffff', color: '#171717', borderColor: 'rgba(0,0,0,0.1)', colorScheme: 'light' }),
    backdropFilter: 'none', opacity: '1',
  }
}

/**
 * 玻璃弹窗面：与控制室「更新公告」面板同一套背景（渐变高光 + 半透明底 + 模糊 + 内描边 + 圆角 16px），
 * 深浅两套与公告面板的 data-wt-theme 取值一致。
 */
export function glassSurface(scheme: HostScheme): Record<string, string> {
  return {
    ...schemeVars(scheme),
    ...(scheme === 'dark'
      ? {
        background: 'linear-gradient(135deg,rgba(255,255,255,.22) 0%,rgba(255,255,255,.07) 30%,rgba(255,255,255,.01) 60%,rgba(0,0,0,.07) 100%),rgba(18,23,32,.24)',
        boxShadow: '0 10px 28px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.13)', color: '#e6e8eb', colorScheme: 'dark',
      }
      : {
        background: 'linear-gradient(135deg,rgba(255,255,255,1) 0%,rgba(255,255,255,.65) 30%,rgba(255,255,255,.12) 60%,rgba(31,41,55,.06) 100%),rgba(255,255,255,.34)',
        boxShadow: '0 10px 28px rgba(31,41,55,.18),inset 0 1px 0 rgba(255,255,255,1)', color: '#1b1f24', colorScheme: 'light',
      }),
    borderColor: 'transparent', borderRadius: '16px', backdropFilter: 'blur(8px) saturate(1.15)',
  }
}
