import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type StudioModelMode = 'system' | 'custom'
export interface StudioModelChoice { mode: StudioModelMode; selection?: ModelSelection }

/** 工作室只保存跟随方式；模型与凭据仍由宿主管理。 */
export class StudioModels {
  private readonly listeners = new Set<() => void>()
  constructor(private readonly remote: TypertClientRemote['session'], private readonly storage: Pick<Storage, 'getItem' | 'setItem'>) {}

  /** 读取当前项目保存的跟随方式。 */
  mode(id: string): StudioModelMode {
    return this.storage.getItem('dsh.studio.modelMode.v1.' + id) === 'custom' ? 'custom' : 'system'
  }

  /** 订阅跟随方式的变化，释放时移除监听。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 连接和发送前同步最新默认模型，不覆盖宿主全局设置。 */
  async prepare(id: string): Promise<void> {
    if (this.mode(id) === 'system') await this.select(id, { mode: 'system' })
  }

  /** 通过正式会话接口选模型；成功后才保存跟随方式。 */
  async select(id: string, choice: StudioModelChoice): Promise<void> {
    let selection = choice.selection
    if (choice.mode === 'system') {
      const catalog = await this.remote.modelCatalog()
      if (!catalog.ok) throw new Error(catalog.error.message)
      selection = catalog.value.default
    }
    if (!selection) throw new Error('请选择一个可用模型')
    const result = await this.remote.selectModel({ sessionId: id as SessionId, ...selection, saveAsDefault: false })
    if (!result.ok) throw new Error(result.error.message)
    this.storage.setItem('dsh.studio.modelMode.v1.' + id, choice.mode)
    this.listeners.forEach(listener => listener())
  }
}
