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

/**
 * 跟随宿主与系统的深浅色；active 为假时不监听（弹窗关闭时不占资源）。
 * 宿主切换主题会改 html 的 class / style / data 属性，系统切换触发 prefers-color-scheme 变化。
 */
export function useHostScheme(active = true): HostScheme {
  const [scheme, setScheme] = useState<HostScheme>(() => readHostScheme())
  useEffect(() => {
    if (!active) return
    const update = () => setScheme(readHostScheme())
    update()
    let media: MediaQueryList | null = null
    try { media = window.matchMedia('(prefers-color-scheme: dark)') } catch { media = null }
    media?.addEventListener?.('change', update)
    let observer: MutationObserver | null = null
    try {
      observer = new MutationObserver(update)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] })
    } catch { observer = null }
    return () => { media?.removeEventListener?.('change', update); observer?.disconnect() }
  }, [active])
  return scheme
}

/**
 * 纯色弹窗面：纯白或纯黑，不透明、不做背景模糊。
 * 宿主的部分主题 / 皮肤会把背景变量设成半透明，弹窗叠在页面上会看不清，所以这里不用主题变量。
 */
export function solidSurface(scheme: HostScheme): Record<string, string> {
  return scheme === 'dark'
    ? { backgroundColor: '#000000', color: '#f5f5f5', borderColor: 'rgba(255,255,255,0.14)', colorScheme: 'dark', backdropFilter: 'none', opacity: '1' }
    : { backgroundColor: '#ffffff', color: '#171717', borderColor: 'rgba(0,0,0,0.1)', colorScheme: 'light', backdropFilter: 'none', opacity: '1' }
}
