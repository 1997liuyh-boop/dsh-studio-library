/** 工作室更新接口只传版本和状态；本机路径和管理器日志不发给页面。 */
export type StudioUpdateState = 'idle' | 'available' | 'latest' | 'unpublished' | 'incompatible' | 'unconfigured' | 'failed'
export type StudioUpdatePhase = 'downloading' | 'verifying' | 'installing' | 'complete' | 'restart-required' | 'failed' | 'unknown'
export interface StudioUpdateOperation { id: string; studio: string; from: string; to: string; phase: StudioUpdatePhase; error?: string }
export interface StudioUpdateRow {
  id: string; name: string; packageName: string; version: string; repository?: string; upstreamVersion?: string
  state: StudioUpdateState; checkedAt?: string; latest?: string; error?: string; operation?: StudioUpdateOperation
}
export interface StudioUpdateReport { hostVersion: string; studios: StudioUpdateRow[]; busy: boolean; issue?: 'record' }
