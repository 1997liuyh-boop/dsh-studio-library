import { fileURLToPath } from 'node:url'
declare const STUDIO_PROJECT_ID: string
declare const STUDIO_PROJECT: { name: string; icon: string; description: string }
export const name = 'dsh-studio-' + STUDIO_PROJECT_ID
export const inject = ['studioProjects']

/** 独立插件拥有其静态页面，启停登记交给共享运行时。 */
export function apply(ctx: {studioProjects: {register(page: {id: string; name: string; icon: string; description: string; root: string}): () => void}; effect(callback: () => () => void,label: string): void}): void {
  ctx.effect(() => ctx.studioProjects.register({id:STUDIO_PROJECT_ID,...STUDIO_PROJECT,root:fileURLToPath(new URL('../static/',import.meta.url))}),'工作室：'+STUDIO_PROJECT_ID)
}
