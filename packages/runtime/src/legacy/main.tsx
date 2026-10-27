import { createRoot } from 'react-dom/client'
import { cloneElement, useEffect, useId, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react'
import { projectOf } from '../projects'
import { type Entry, type KnowledgeNode, type ProjectDocument, parseDocument, removeEntry, save, serialize, storageKey } from './data'
import { copy as t } from './copy'

const project = projectOf(location.pathname.split('/').filter(Boolean).at(-1) ?? '')
if (!project) throw new Error('无法识别工作室项目。')
const current = project
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
const primary = button + ' border-transparent! bg-indigo-600! text-white! hover:bg-indigo-500!'
const panel = 'rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900'
const statuses = { planned: t.planned, visited: t.visited, idea: t.idea, writing: t.writing, ready: t.ready, published: t.published }
type Draft = Record<'title' | 'notes' | 'destination' | 'startDate' | 'endDate' | 'budget' | 'category' | 'platform' | 'publishDate' | 'date' | 'sets' | 'reps' | 'weight' | 'minutes' | 'status', string> & { links: string[] }

function draftFor(entry?: Entry): Draft {
  const draft: Draft = { title: '', notes: '', destination: '', startDate: '', endDate: '', budget: '0', category: '', platform: '', publishDate: '', date: new Date().toLocaleDateString('en-CA'), sets: '3', reps: '10', weight: '0', minutes: '0', status: current.id === 'travel' ? 'planned' : 'idea', links: [] }
  if (entry) for (const [key, value] of Object.entries(entry)) {
    if (key === 'links' && Array.isArray(value)) draft.links = [...value]
    else if (key in draft && typeof value !== 'object') Object.assign(draft, { [key]: String(value) })
  }
  return draft
}

function readInitial(): { entries: Entry[]; error: boolean } {
  try {
    const raw = localStorage.getItem(storageKey(current.id))
    return { entries: raw ? parseDocument(raw, current.id).entries : [], error: false }
  } catch { return { entries: [], error: true } }
}

function download(source: string, suffix = ''): void {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${current.id}${suffix}-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return <div className="grid gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close() } }, [])
  return <dialog ref={ref} onCancel={onClose} aria-label={title} className="m-auto max-h-[90vh] w-[min(36rem,94vw)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"><h2 className="mb-5 text-lg font-semibold">{title}</h2>{children}</dialog>
}

function Editor({ entry, entries, onClose, onSave }: { entry?: Entry; entries: Entry[]; onClose(): void; onSave(entry: Entry): boolean }) {
  const [draft, setDraft] = useState(() => draftFor(entry))
  const [error, setError] = useState('')
  const set = (key: keyof Draft, value: string | string[]) => setDraft(prev => ({ ...prev, [key]: value }))
  const input = (key: Exclude<keyof Draft, 'links'>, label: string, type = 'text', required = false) => <Field label={label}><input name={key} value={draft[key]} onChange={e => set(key, e.target.value)} type={type} required={required} maxLength={100000} min={type === 'number' ? (key === 'sets' || key === 'reps' ? 1 : 0) : undefined} max={type === 'number' ? 1000000000 : undefined} step={type === 'number' ? (key === 'sets' || key === 'reps' ? 1 : 'any') : undefined} /></Field>
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const base = { id: entry?.id ?? crypto.randomUUID(), title: draft.title.trim(), notes: draft.notes }
    let next: Entry
    switch (current.id) {
      case 'travel':
        if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) { setError(t.invalidDates); return }
        next = { ...base, kind: 'travel', destination: draft.destination.trim(), startDate: draft.startDate, endDate: draft.endDate, budget: Number(draft.budget), status: draft.status === 'visited' ? 'visited' : 'planned' }; break
      case 'knowledge': next = { ...base, kind: 'knowledge', category: draft.category.trim(), links: draft.links }; break
      case 'media': next = { ...base, kind: 'media', platform: draft.platform.trim(), status: draft.status === 'writing' || draft.status === 'ready' || draft.status === 'published' ? draft.status : 'idea', publishDate: draft.publishDate }; break
      case 'fitness': next = { ...base, kind: 'fitness', date: draft.date, sets: Number(draft.sets), reps: Number(draft.reps), weight: Number(draft.weight), minutes: Number(draft.minutes) }; break
    }
    if (!onSave(next)) setError(t.storageError)
  }
  return <Modal title={entry ? t.edit : t.add} onClose={onClose}><form onSubmit={submit} className="grid gap-4">
    {input('title', current.id === 'travel' ? t.tripTitle : current.id === 'knowledge' ? t.knowledgeTitle : current.id === 'media' ? t.mediaTitle : t.fitnessTitle, 'text', true)}
    {current.id === 'travel' && <>{input('destination', t.destination, 'text', true)}<div className="grid grid-cols-2 gap-3">{input('startDate', t.startDate, 'date')}{input('endDate', t.endDate, 'date')}</div>{input('budget', t.budget, 'number', true)}<Field label={t.status}><select value={draft.status} onChange={e => set('status', e.target.value)}><option value="planned">{t.planned}</option><option value="visited">{t.visited}</option></select></Field></>}
    {current.id === 'knowledge' && <>{input('category', t.category)}<fieldset className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700"><legend className="px-1 text-sm">{t.links}</legend>{entries.filter(node => node.id !== entry?.id).map(node => <label key={node.id} className="flex items-center gap-2 text-sm"><input className="size-4! w-auto!" type="checkbox" checked={draft.links.includes(node.id)} onChange={e => set('links', e.target.checked ? [...draft.links, node.id] : draft.links.filter(id => id !== node.id))} />{node.title}</label>)}{entries.filter(node => node.id !== entry?.id).length === 0 && <p className="text-sm text-slate-500">{t.noNodes}</p>}</fieldset></>}
    {current.id === 'media' && <>{input('platform', t.platform, 'text', true)}{input('publishDate', t.publishDate, 'date')}<Field label={t.status}><select value={draft.status} onChange={e => set('status', e.target.value)}>{(['idea', 'writing', 'ready', 'published'] as const).map(status => <option key={status} value={status}>{statuses[status]}</option>)}</select></Field></>}
    {current.id === 'fitness' && <>{input('date', t.date, 'date', true)}<div className="grid grid-cols-2 gap-3">{input('sets', t.sets, 'number', true)}{input('reps', t.reps, 'number', true)}{input('weight', t.weight, 'number', true)}{input('minutes', t.minutes, 'number', true)}</div></>}
    <Field label={t.notes}><textarea name="notes" rows={4} maxLength={100000} placeholder={t.notesPlaceholder} value={draft.notes} onChange={e => set('notes', e.target.value)} /></Field>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <div className="mt-2 flex justify-end gap-2"><button className={button} type="button" onClick={onClose}>{t.cancel}</button><button className={primary} type="submit">{t.save}</button></div>
  </form></Modal>
}

function KnowledgeGraph({ nodes, onSelect }: { nodes: KnowledgeNode[]; onSelect(node: KnowledgeNode): void }) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  const width = Math.max(400, columns * 180)
  const height = Math.max(240, Math.ceil(nodes.length / columns) * 110)
  const points = new Map(nodes.map((node, index) => [node.id, { x: 90 + (index % columns) * 180, y: 65 + Math.floor(index / columns) * 110 }]))
  return <section className={panel + ' mb-5'}><h2 className="font-semibold">{t.graph}</h2><p className="mt-1 text-xs text-slate-500">{t.graphHint}</p>{nodes.length === 0 ? <p className="py-12 text-center text-sm text-slate-500">{t.graphEmpty}</p> : <div className="mt-3 max-h-96 overflow-auto"><svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width, height }} role="group" aria-label={t.graph} className="w-full">
    {nodes.flatMap(node => node.links.map(link => { const a = points.get(node.id); const b = points.get(link); return a && b ? <line key={node.id + link} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" className="text-indigo-300 dark:text-indigo-700" strokeWidth={2} /> : null }))}
    {nodes.map(node => { const point = points.get(node.id)!; return <g key={node.id} role="button" tabIndex={0} aria-label={node.title} onClick={() => onSelect(node)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node) } }} className="cursor-pointer outline-none focus:text-indigo-500"><title>{node.title}</title><rect x={point.x - 75} y={point.y - 28} width={150} height={56} rx={12} fill="currentColor" className="text-indigo-50 dark:text-indigo-950" stroke="currentColor" /><text x={point.x} y={point.y - 2} textAnchor="middle" className="fill-indigo-800 text-[12px] font-semibold dark:fill-indigo-200">{node.title.length > 11 ? node.title.slice(0, 10) + '…' : node.title}</text><text x={point.x} y={point.y + 16} textAnchor="middle" className="fill-slate-500 text-[10px]">{node.category || t.uncategorized}</text></g> })}
  </svg></div>}</section>
}

function App() {
  const [initial] = useState(readInitial)
  const [entries, setEntries] = useState(initial.entries)
  const [loadError, setLoadError] = useState(initial.error)
  const [message, setMessage] = useState('')
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<{ entry?: Entry } | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [pendingImport, setPendingImport] = useState<ProjectDocument | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    document.title = current.name
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey(current.id) && event.key !== null) return
      const next = readInitial(); setEntries(next.entries); setLoadError(next.error); setEditor(null); setDeleteId(null); setPendingImport(null)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const persist = (next: Entry[], success: string) => {
    try { save(localStorage, current.id, next) } catch { setMessage(t.storageError); return false }
    setEntries(next); setLoadError(false); setMessage(success); return true
  }
  const onSave = (entry: Entry) => { const success = persist(entries.some(row => row.id === entry.id) ? entries.map(row => row.id === entry.id ? entry : row) : [...entries, entry], t.saved); if (success) setEditor(null); return success }
  const number = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
  const trips = entries.filter(entry => entry.kind === 'travel')
  const nodes = entries.filter(entry => entry.kind === 'knowledge')
  const posts = entries.filter(entry => entry.kind === 'media')
  const workouts = entries.filter(entry => entry.kind === 'fitness')
  const stats = current.id === 'travel' ? [[t.allTrips, trips.length], [t.totalBudget, number(trips.filter(row => row.status === 'planned').reduce((sum, row) => sum + row.budget, 0))], [t.visitedCount, new Set(trips.filter(row => row.status === 'visited').map(row => row.destination)).size]] : current.id === 'knowledge' ? [[t.nodes, nodes.length], [t.connections, new Set(nodes.flatMap(row => row.links.map(id => [row.id, id].sort().join(':')))).size], [t.categories, new Set(nodes.map(row => row.category).filter(Boolean)).size]] : current.id === 'media' ? [[t.mediaCount, posts.length], [t.mediaActive, posts.filter(row => row.status === 'writing').length], [t.mediaPublished, posts.filter(row => row.status === 'published').length]] : [[t.workoutCount, workouts.length], [t.workoutMinutes, number(workouts.reduce((sum, row) => sum + row.minutes, 0))], [t.workoutVolume, number(workouts.reduce((sum, row) => sum + row.sets * row.reps * row.weight, 0))]]
  const filtered = entries.filter(entry => JSON.stringify(entry).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const card = (entry: Entry) => <article key={entry.id} data-record-id={entry.id} className={panel + ' flex flex-col gap-3'}>
    <div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-words font-semibold">{entry.title}</h3>{'status' in entry && <span className="shrink-0 rounded-md bg-indigo-50 px-2 py-1 text-xs text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">{statuses[entry.status]}</span>}</div>
    {entry.kind === 'travel' && <div className="space-y-1 text-sm text-slate-500"><p>{entry.destination}</p><p>{entry.startDate || t.undated} — {entry.endDate || t.undated}</p><p>{number(entry.budget)} {t.currency}</p></div>}
    {entry.kind === 'knowledge' && <div className="text-sm text-slate-500"><p>{entry.category || t.uncategorized}</p>{entry.links.length > 0 && <p className="mt-2">{t.links} · {entry.links.map(id => entries.find(node => node.id === id)?.title).join('、')}</p>}</div>}
    {entry.kind === 'media' && <div className="text-sm text-slate-500"><p>{entry.platform}</p><p className="mt-1">{entry.publishDate || t.undated}</p></div>}
    {entry.kind === 'fitness' && <div className="text-sm text-slate-500"><p>{entry.date}</p><p className="mt-1">{entry.sets} {t.unitSets} × {entry.reps} {t.unitReps} · {entry.weight} {t.unitKg}</p><p>{entry.minutes} {t.unitMinutes} · {number(entry.sets * entry.reps * entry.weight)} {t.unitKg}</p></div>}
    {entry.notes && <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600 dark:text-slate-400">{entry.notes}</p>}
    <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-2">{entry.kind === 'media' && <select aria-label={`${entry.title} · ${t.status}`} className="mr-auto w-auto! text-xs!" value={entry.status} onChange={event => { const status = event.target.value; if (status === 'idea' || status === 'writing' || status === 'ready' || status === 'published') persist(entries.map(row => row.id === entry.id ? { ...entry, status } : row), t.saved) }}>{(['idea', 'writing', 'ready', 'published'] as const).map(status => <option key={status} value={status}>{statuses[status]}</option>)}</select>}<button className={button + ' px-2! py-1! text-xs!'} onClick={() => setEditor({ entry })}>{t.edit}</button><button className={button + ' px-2! py-1! text-xs! text-red-600!'} onClick={() => setDeleteId(entry.id)}>{t.remove}</button></div>
  </article>
  return <main className="mx-auto max-w-7xl p-5 sm:p-7">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><p className="mb-2 text-xs font-semibold tracking-widest text-indigo-600 dark:text-indigo-400">{t.studio} / {t.local}</p><h1 className="text-2xl font-semibold tracking-tight"><span className="mr-2">{current.icon}</span>{current.name}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{current.description}</p></div><button className={primary} disabled={loadError} onClick={() => setEditor({})}>＋ {t.add}</button></header>
    <div className="mb-6 grid grid-cols-3 gap-3">{stats.map(([label, value]) => <div key={label} className={panel}><p className="text-xs text-slate-500">{label}</p><p className="mt-2 break-words text-2xl font-semibold tabular-nums">{value}</p></div>)}</div>
    <div className="mb-5 flex flex-wrap items-center gap-2"><input aria-label={t.search} className="mr-auto w-full! sm:w-60!" type="search" placeholder={t.searchPlaceholder} value={query} onChange={event => setQuery(event.target.value)} /><button className={button} disabled={loadError} onClick={() => { download(serialize(current.id, entries)); setMessage(t.exported) }}>{t.export}</button><button className={button} onClick={() => fileRef.current?.click()}>{t.import}</button><input ref={fileRef} type="file" accept=".json,application/json" className="hidden!" aria-label={t.import} onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { if (file.size > 10 * 1024 * 1024) throw new Error(t.importTooLarge); setPendingImport(parseDocument(await file.text(), current.id)) } catch (error) { setMessage(t.importError + (error instanceof Error ? error.message : String(error))) } }} /></div>
    {loadError && <div role="alert" className="mb-5 rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-200"><p>{t.loadError}</p><button className={button + ' mt-3'} onClick={() => { try { download(localStorage.getItem(storageKey(current.id)) ?? '', '-raw') } catch { setMessage(t.storageError) } }}>{t.rawExport}</button></div>}
    {message && <p role="status" className="mb-4 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">{message}</p>}
    {current.id === 'knowledge' && <KnowledgeGraph nodes={nodes} onSelect={node => setEditor({ entry: node })} />}
    {entries.length === 0 && !loadError ? <div className={panel + ' py-14! text-center'}><p className="mb-4 text-4xl" aria-hidden="true">{current.icon}</p><h2 className="font-semibold">{t.empty}</h2><p className="mt-2 text-sm text-slate-500">{t.emptyDescription}</p><button className={primary + ' mt-5'} onClick={() => setEditor({})}>{t.add}</button></div> : current.id === 'media' ? <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-4">{(['idea', 'writing', 'ready', 'published'] as const).map(status => <section key={status} className="rounded-xl bg-slate-100 p-3 dark:bg-slate-800/50"><h2 className="mb-3 flex justify-between text-sm font-semibold">{statuses[status]}<span className="text-slate-500">{filtered.filter(entry => entry.kind === 'media' && entry.status === status).length}</span></h2><div className="grid gap-3">{filtered.filter(entry => entry.kind === 'media' && entry.status === status).map(card)}</div></section>)}</div> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map(card)}</div>}
    {entries.length > 0 && filtered.length === 0 && <p className="py-10 text-center text-sm text-slate-500">{t.noResults}</p>}
    <footer className="mt-8 text-xs leading-6 text-slate-500">{t.privacy}</footer>
    {editor && <Editor entry={editor.entry} entries={entries} onClose={() => setEditor(null)} onSave={onSave} />}
    {deleteId && <Modal title={t.deleteTitle} onClose={() => setDeleteId(null)}><p className="text-sm text-slate-500">{t.deleteDescription}</p><div className="mt-6 flex justify-end gap-2"><button className={button} onClick={() => setDeleteId(null)}>{t.cancel}</button><button className={primary + ' bg-red-600!'} onClick={() => { if (persist(removeEntry(entries, deleteId), t.deleted)) setDeleteId(null) }}>{t.confirmDelete}</button></div></Modal>}
    {pendingImport && <Modal title={t.importTitle} onClose={() => setPendingImport(null)}><p className="text-sm text-slate-500">{t.importDescription}</p><p className="mt-3 text-sm">{current.name} · {pendingImport.entries.length}</p><div className="mt-6 flex justify-end gap-2"><button className={button} onClick={() => setPendingImport(null)}>{t.cancel}</button><button className={primary} onClick={() => { if (persist(pendingImport.entries, t.imported)) setPendingImport(null) }}>{t.confirmImport}</button></div></Modal>}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
