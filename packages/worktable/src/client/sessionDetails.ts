
export function cleanPreviewText(raw: string): string {
  return String(raw ?? '')
    .replace(/```[a-zA-Z0-9_+-]*[\s\S]*?```/g, ' ')
    .replace(/```[a-zA-Z0-9_+-]*[\s\S]*$/g, ' ')
    .replace(/`[^`\n]{1,200}`/g, ' ')
    .replace(/```/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

export function previewFromEvents(entries: any): string {
  if (!Array.isArray(entries)) return ''
  for (let i = entries.length - 1; i >= 0; i--) {
    const ev = entries[i]?.event
    if (ev?.type !== 'user/message' && ev?.type !== 'assistant/message') continue
    const data = ev.type === 'assistant/message' ? ev.data?.message ?? ev.data : ev.data
    const blocks = data?.content ?? data?.blocks
    if (!Array.isArray(blocks)) continue
    const raw = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
    const text = cleanPreviewText(raw)
    if (text.length >= 8) return text.slice(0, 220)
  }
  return ''
}

export async function readSessionPreview(sessions: any, id: string): Promise<string> {
  if (typeof sessions?.using === 'function') {
    return sessions.using(id, { source: 'dshWorktablePreview' }, async (ref: any) => {
      const binding = await ref.ready
      return previewFromEvents(binding.eventSource?.getSnapshot?.()?.entries)
    })
  }
  const face = sessions?.binding?.(id)?.session
  if (typeof face?.history !== 'function') return ''
  const result = await face.history({ maxMessages: 6 })
  return previewFromEvents(result?.result?.value?.events)
}


export function presetApiOf(ctx: any, legacy: any): any {
  const api = typeof ctx?.get === 'function' ? ctx.get('remote.agentPresets') : ctx?.remote?.agentPresets
  if (typeof api?.list !== 'function' || typeof api?.select !== 'function') return legacy
  return {
    list: async () => ({ result: await api.list() }),
    select: async ({ sessionId, agentPreset }: any) => ({ result: await api.select(sessionId, agentPreset) }),
  }
}


export function modelApiOf(ctx: any, sessions: any, legacy: any): any {
  if (typeof sessions?.using !== 'function') return legacy
  const resolver = typeof ctx?.get === 'function' ? ctx.get('modelDirectories') : ctx?.modelDirectories
  if (typeof resolver?.directoryFor !== 'function') return legacy
  const withDirectory = (id: string, operation: (directory: any) => Promise<any>) =>
    sessions.using(id, { source: 'dshWorktableModel' }, async (ref: any) => {
      await ref.ready
      return operation(resolver.directoryFor(id))
    })
  return {
    models: async ({ sessionId }: any) => withDirectory(sessionId, async (directory) => ({ result: { ok: true, value: await directory.load() } })),
    selectModel: async ({ sessionId, ...selection }: any) => withDirectory(sessionId, async (directory) => ({ result: await directory.select(selection) })),
  }
}


export function blankSessionNeedsWorkspace(sessions: any, grouping: 'auto' | 'none'): boolean {
  return grouping === 'none' && typeof sessions?.using === 'function'
}


export async function createHostSession(sessions: any, workspaces: any, options: { workspaceId?: string; cwd?: string; sessionId?: string } = {}, grouping: 'auto' | 'none' = 'auto'): Promise<string> {
  if (grouping === 'none') {
    if (options.workspaceId) throw new Error('ungrouped session cannot specify a workspace')
    return sessions.create(options)
  }
  if (options.workspaceId || typeof sessions?.using !== 'function') return sessions.create(options)

  const workspace = options.cwd
    ? await workspaces?.create?.({ path: options.cwd })
    : await workspaces?.initializeDefault?.()
  if (typeof workspace?.workspaceId !== 'string' || !workspace.workspaceId) throw new Error('workspace unavailable for new session')
  const { cwd: _cwd, ...rest } = options
  return sessions.create({ ...rest, workspaceId: workspace.workspaceId })
}
