import { useEffect } from 'react'
interface Project { id: string; name: string; icon: string; description: string }
declare const STUDIO_CARD_CSS: string
declare const STUDIO_PROJECT: Project
declare const STUDIO_PROJECT_ORDER: number

interface ProjectCardProps {
  project: Project
  query?: string
  hidden?: string[]
  order?: string[]
  nameOverrides?: Record<string, string>
  iconOverrides?: Record<string, string>
  reportMeta?(project: { id: string; name: string; icon: string }): void
  reportUsed?(id: string): void
  openSplit?(spec: object): void
  activeSplitId?: string | null
}

/** 每个项目独立注册工作室卡片，布局和会话绑定交给工作室管理。 */
function ProjectCard(props: ProjectCardProps) {
  const { project, reportMeta } = props
  const id = 'studio-' + project.id
  useEffect(() => { reportMeta?.({ id, name: project.name, icon: project.icon }) }, [id, project, reportMeta])
  const name = props.nameOverrides?.[id] ?? project.name
  const icon = props.iconOverrides?.[id] ?? project.icon
  if (props.hidden?.includes(id) || (props.query && !name.toLocaleLowerCase().includes(props.query.toLocaleLowerCase()))) return null
  const position = props.order?.indexOf(id) ?? -1
  return <button type="button" className="sp:relative sp:flex sp:h-[34px] sp:w-full sp:items-center sp:gap-1.5 sp:rounded-(--dsw-radius-md) sp:border-0 sp:bg-transparent sp:px-2 sp:text-left sp:text-sm sp:leading-5 sp:text-(--dsw-alias-label-primary) sp:cursor-pointer sp:hover:bg-(--dsw-alias-interactive-bg-hover) sp:data-[on=true]:bg-(--dsw-alias-interactive-bg-hover)" data-worktable-project={id} data-on={props.activeSplitId === id ? 'true' : 'false'}
    style={{ order: position < 0 ? 1000 : position }} title={project.description}
    onClick={() => {
      props.openSplit?.({ id, title: name, icon, top: null, main: [{ id: id + '-main', title: name, min: 300, content: { kind: 'iframe', url: '/studio-projects/' + project.id, title: name } }], chatWidth: { default: 340, min: 260, max: 640 } })
      props.reportUsed?.(id)
    }}><span className="sp:flex sp:w-4 sp:shrink-0 sp:items-center sp:justify-center">{icon}</span><span className="sp:min-w-0 sp:flex-1 sp:truncate">{name}</span></button>
}

interface ClientContext {
  effect(callback: () => () => void, label: string): void
  slots: {
    inject(name: string, callback: () => () => void, label: string): void
    register(options: { name: string; id: string; order: number; inject(): { project: Project } }, component: typeof ProjectCard): () => void
  }
}
export const inject = ['slots']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = STUDIO_CARD_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, '工作室项目：卡片样式')
  const project = STUDIO_PROJECT
  ctx.slots.inject('sidebar.worktable.project', () => ctx.slots.register({ name: 'sidebar.worktable.project', id: 'studio-' + project.id, order: STUDIO_PROJECT_ORDER, inject: () => ({ project }) }, ProjectCard), '工作室项目：' + project.name)
}
