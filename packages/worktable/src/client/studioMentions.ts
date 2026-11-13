/** 目录里工作室声明的快捷任务（与运行时 studioTasks 展开用的是同一份）。 */
interface CatalogTask { id: string; label: string; description?: string }
interface CatalogProject { id: string; name: string; description: string; tasks?: CatalogTask[] }

/**
 * 工作室候选来自已启用插件目录，停用的项目不会继续出现在列表。
 * 除了工作室本身，还列出「工作室名:任务标题」形式的任务项（如「设计工作室:实现设计稿」）：
 * 选中后插入的芯片序列化为 @工作室:<id>:<任务 id>，运行时在进入模型前把它换成该任务的内置文本，后面输入的内容作为需求。
 * 任务项只在输入了关键词后出现，空的 @ 仍只列工作室，避免列表过长。
 */
export function installStudioMentions(ctx: any, t: (key: any) => string): void {
  ctx.inject(['inputTriggers'], (scope: any) => {
    const load = async (signal?: AbortSignal) => {
      const response = await fetch('/studio-projects/control/catalog', { signal, cache: 'no-store' })
      if (!response.ok) throw new Error(t('mentions.unavailable'))
      return response.json() as Promise<CatalogProject[]>
    }
    /** 芯片引用：工作室 id，或「工作室 id:任务 id」。 */
    const resolve = (projects: CatalogProject[], ref: string) => {
      const [id, taskId] = ref.split(':')
      const project = projects.find(item => item.id === id)
      const task = taskId === undefined ? undefined : project?.tasks?.find(item => item.id === taskId)
      return { project, task, valid: !!project && (taskId === undefined || !!task) }
    }
    scope.effect(() => scope.inputTriggers.registerSource({
      name: 'studio', trigger: '@', order: -20, showGroupTitle: false,
      async candidates(_session: object, request: { query: string; signal: AbortSignal }) {
        const query = request.query.replace(/^工作室[:：]?/, '').replace(/：/g, ':').toLocaleLowerCase()
        const projects = await load(request.signal)
        const rows: { name: string; label: string; description: string; section: string; icon: string; value: string }[] = []
        for (const project of projects) {
          if ((project.id + ' ' + project.name).toLocaleLowerCase().includes(query)) rows.push({ name: project.id, label: project.name, description: project.description, section: t('title'), icon: 'session', value: project.id })
          if (!query) continue
          for (const task of project.tasks ?? []) {
            const label = project.name + ':' + task.label
            if (!(label + ' ' + project.id + ':' + task.id).toLocaleLowerCase().includes(query)) continue
            rows.push({ name: project.id + ':' + task.id, label, description: task.description ?? '', section: t('title'), icon: 'session', value: project.id + ':' + task.id })
          }
        }
        return rows
      },
      onPick({ candidate }: { candidate: { value: string; label: string } }) {
        return { insert: { source: 'studio', ref: candidate.value, label: candidate.label, appearance: 'session', clipboardText: '@' + candidate.label } }
      },
      codec: {
        clipboardText: (ref: string) => '@工作室:' + ref,
        async serialize(ref: string, signal: AbortSignal) {
          if (!resolve(await load(signal), ref).valid) throw new Error(t('mentions.disabled'))
          return '@工作室:' + ref
        },
      },
    }), '工作室：输入框 @ 候选')
  })
}
