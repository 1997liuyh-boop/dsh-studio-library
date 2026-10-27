export const projects = [
  { id: 'travel', name: '旅行', icon: '✈️', description: 'StarMap：地球足迹、国家城市、路线、相册与旅程时间线' },
  { id: 'knowledge', name: 'AI学习路线', icon: '🧠', description: '参考 AI Roadmap 的八条真实路线、119 个节点及本机学习进度' },
  { id: 'media', name: 'AI短剧工作台', icon: '✍️', description: 'Toonflow 原应用：无限画布、剧本分镜、角色素材与图片视频生成' },
  { id: 'fitness', name: '健身记录', icon: '🏋️', description: '基础版：记录训练、运动时长与训练容量' },
] as const
export type ProjectId = typeof projects[number]['id']
export const filmProject = { id: 'film', name: 'AI剧工作台', icon: '🎬', description: 'PRINTFILM 原应用：剧本、分集、分镜、资产库与视频工作流' } as const
export type Project = typeof projects[number] | typeof filmProject
export function projectOf(id: string): typeof projects[number] | undefined {
  return projects.find(project => project.id === id)
}
