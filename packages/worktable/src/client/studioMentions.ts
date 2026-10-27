/** 工作室候选来自已启用插件目录，停用的项目不会继续出现在列表。 */
export function installStudioMentions(ctx: any, t: (key: any) => string): void {
  ctx.inject(['inputTriggers'], (scope: any) => {
    const load = async (signal?: AbortSignal) => {
      const response = await fetch('/studio-projects/control/catalog', { signal, cache: 'no-store' })
      if (!response.ok) throw new Error(t('mentions.unavailable'))
      return response.json() as Promise<{ id: string; name: string; description: string }[]>
    }
    scope.effect(() => scope.inputTriggers.registerSource({
      name: 'studio', trigger: '@', order: -20, showGroupTitle: false,
      async candidates(_session: object, request: { query: string; signal: AbortSignal }) {
        const query = request.query.replace(/^工作室[:：]?/, '').toLocaleLowerCase()
        const projects = await load(request.signal)
        return projects.filter(project => (project.id + ' ' + project.name).toLocaleLowerCase().includes(query)).map(project => ({
          name: project.id, label: project.name, description: project.description,
          section: t('title'), icon: 'session', value: project.id,
        }))
      },
      onPick({ candidate }: { candidate: { value: string; label: string } }) {
        return { insert: { source: 'studio', ref: candidate.value, label: candidate.label, appearance: 'session', clipboardText: '@' + candidate.label } }
      },
      codec: {
        clipboardText: (id: string) => '@工作室:' + id,
        async serialize(id: string, signal: AbortSignal) {
          const projects = await load(signal)
          if (!projects.some(project => project.id === id)) throw new Error(t('mentions.disabled'))
          return '@工作室:' + id
        },
      },
    }), '工作室：输入框 @ 候选')
  })
}
