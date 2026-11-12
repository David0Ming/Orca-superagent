// Orca owns runs, messages and execution. This worker only reads, navigates and delivers owner text.
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import { ACTIVE_TASK_STATUSES, COMPLETED_STATUSES, isActionableMessage, belongsToTask } from './protocol'
import type { Action, ActionResult, Detail, MessageView, RunView, Selection, Snapshot, WorkerView } from './protocol'

const exec = promisify(execFile)
const CLI = process.env.ORCA_CLI_COMMAND || 'orca'
type Cli = (args: string[]) => Promise<any>
async function cli(args: string[]) {
  const { stdout } = await exec(CLI, [...args, '--json'], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 })
  const response = JSON.parse(stdout)
  if (response.ok === false) throw new Error(response.error?.message || 'Orca 请求失败')
  return response.result ?? response
}
function names() {
  const dir = join(process.env.OSA_TEAM_HOME || join(homedir(), 'osa-team'), 'state')
  const entries = new Map<string, Record<string, string>>()
  if (!existsSync(dir)) return entries
  for (const file of readdirSync(dir).filter(file => file.endsWith('.env'))) {
    const env: Record<string, string> = {}
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_0-9]+)='?(.*?)'?\s*$/)
      if (match) env[match[1]] = match[2]
    }
    if (env.RUN) entries.set(env.RUN, env)
  }
  return entries
}
function json(value: any): any {
  if (typeof value !== 'string') return value || {}
  try { return JSON.parse(value) } catch { return {} }
}
// Orca's SQLite timestamps without offsets are UTC, not the desktop's local timezone.
function time(value: string | null | undefined) {
  return value ? (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value) : ''
}
async function workersFor(runId: string, call: Cli): Promise<WorkerView[]> {
  const workers: WorkerView[] = []
  let cursor = ''
  do {
    const page = await call(['orchestration', 'worker-list', '--run', runId, '--full', ...(cursor ? ['--cursor', cursor] : [])])
    workers.push(...(page.workers || []).map((w: any) => ({
      dispatchId: w.dispatchId, taskId: w.taskId, state: w.projection?.outcome || w.workerState || '',
      liveness: w.projection?.liveness?.verdict || '', activity: w.projection?.stage?.activity || '',
      agent: w.projection?.provider?.id || '', agentSource: w.projection?.provider ? '派发记录' : '',
      terminal: w.agentTerminalHandle || '', terminalState: w.terminalState || '',
      workspace: w.projection?.workspace?.id || w.resource?.worktreeId || '',
    })))
    cursor = page.page?.nextCursor || page.nextCursor || ''
  } while (cursor)
  return workers
}
const dispatchTimes = new WeakMap<Cli, Map<string, Promise<string>>>()
async function dispatchTime(id: string, call: Cli) {
  let cache = dispatchTimes.get(call)
  if (!cache) { cache = new Map(); dispatchTimes.set(call, cache) }
  if (!cache.has(id)) cache.set(id, call(['orchestration', 'worker-show', '--dispatch', id, '--full'])
    .then(result => {
      const value = time(result.dispatch?.dispatchedAt || result.dispatch?.dispatched_at || result.dispatch?.createdAt || result.dispatch?.created_at)
      if (!Number.isFinite(Date.parse(value))) throw new Error('Orca 未返回有效派发时间')
      return value
    })
    .catch(error => { cache!.delete(id); throw error }))
  return cache.get(id)!
}
async function readRun(run: any, inbox: any[], call: Cli, environments = names(), warnings: string[] = []): Promise<RunView> {
  const [tasks, workers] = await Promise.all([
    call(['orchestration', 'task-list', '--run', run.id, '--full']), workersFor(run.id, call),
  ])
  const env = environments.get(run.id)
  const rawMessages = inbox.filter(message => message.run_id === run.id)
  const messages: MessageView[] = rawMessages.map(message => {
    const payload = json(message.payload)
    // Native replies are reverse-addressed status messages whose thread points at the question.
    const replied = rawMessages.some(reply => reply.id !== message.id && reply.thread_id === message.id
      && (reply.from_handle === message.to_handle || (message.to_handle === `run:${run.id}` && !!run.coordinator_handle && reply.from_handle === run.coordinator_handle))
      && (reply.to_handle === message.from_handle || (!!payload.dispatchId && reply.to_handle === `dispatch:${payload.dispatchId}`))
      && reply.type === 'status' && reply.subject === `Re: ${message.subject}`
      && Date.parse(time(reply.created_at)) >= Date.parse(time(message.created_at)))
    return { id: message.id, from: message.from_handle || '', to: message.to_handle || '', subject: message.subject || '', body: message.body || '',
      type: message.type || '', createdAt: time(message.created_at), unread: !message.read,
      threadId: message.thread_id || '', deliveredAt: time(message.delivered_at), replied, source: payload.source || '',
      taskId: payload.taskId || '', dispatchId: payload.dispatchId || '' }
  })
  const rawTasks: any[] = tasks.tasks || []
  const times = new Map<string, string>()
  const needingTime = rawTasks.filter(task => !task.updated_at && !COMPLETED_STATUSES.has(task.status)
    && (task.dispatch_id || task.dispatchId || workers.some(worker => worker.taskId === task.id)))
  for (let index = 0; index < needingTime.length; index += 5) await Promise.all(needingTime.slice(index, index + 5).map(async task => {
    const id = task.dispatch_id || task.dispatchId || workers.find(worker => worker.taskId === task.id)?.dispatchId
    try { times.set(task.id, await dispatchTime(id, call)) }
    catch (error) { warnings.push(`${task.id} 派发时间读取失败：${String(error)}`) }
  }))
  return {
    runId: run.id, name: run.objective && !/^osa\s+[a-f0-9]{16}/i.test(run.objective) ? run.objective : rawTasks[0]?.task_title || env?.NAME || '协调任务', objective: run.objective || env?.BRIEF || '',
    project: env?.PROJECT || '', handle: run.coordinator_handle || env?.HANDLE || '', updatedAt: time(run.updated_at), workers,
    tasks: rawTasks.map((task: any) => {
      const result = json(task.result)
      const worker = workers.find(worker => worker.dispatchId === (task.dispatch_id || task.dispatchId)) || workers.find(worker => worker.taskId === task.id)
      const view = { id: task.id, title: task.task_title || task.title || task.display_name || '待命名任务', status: task.status || 'unknown',
        spec: task.spec || '', resultTitle: result.subject || '', resultSource: result.provenance || '',
        dependencies: (Array.isArray(json(task.deps)) ? json(task.deps) : []).map((id: string) => { const dependency = rawTasks.find(task => task.id === id); return dependency && !COMPLETED_STATUSES.has(dependency.status) ? dependency.task_title || dependency.display_name || id : '' }).filter(Boolean),
        result: result.body || result.subject || (typeof task.result === 'string' ? task.result : ''), updatedAt: '',
        dispatchId: task.dispatch_id || task.dispatchId || worker?.dispatchId || '', assignee: task.assignee_handle || task.assignee || '' }
      const candidates = [time(task.completed_at), times.get(task.id) || '', ...messages.filter(message => belongsToTask(message, view, worker)).map(message => message.createdAt)].filter(value => Number.isFinite(Date.parse(value)))
      view.updatedAt = time(task.updated_at) || candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || ''
      return view
    }), messages,
  }
}
let listCache: { key: string; call: Cli; at: number; data: Snapshot } | undefined
export async function collect(limit = 20, call: Cli = cli, context?: { terminals: { id: string }[] } | null, query = '', force = false): Promise<Snapshot> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Run 数量须为 1–1000')
  if (typeof query !== 'string' || query.length > 500) throw new Error('搜索词过长')
  const key = JSON.stringify([limit, query, context === undefined ? 'active' : context?.terminals.map(t => t.id)])
  if (!force && listCache?.key === key && listCache.call === call && Date.now() - listCache.at < 15000) return listCache.data
  const needle = query.trim().toLocaleLowerCase()
  const warnings: string[] = []
  const [page, spaces, current, mail, projects, terminals] = await Promise.all([
    call(['orchestration', 'run-list', '--limit', String(limit), '--full']),
    call(['worktree', 'list', '--limit', '10000']),
    context === undefined ? call(['worktree', 'show', '--worktree', 'active']).catch(() => ({})) : Promise.resolve({}),
    call(['orchestration', 'inbox', '--limit', '1000', '--full']).catch(e => { warnings.push(`消息读取失败：${e.message}`); return { messages: [] } }),
    call(['project', 'list']),
    call(['terminal', 'list', '--limit', '10000']),
  ])
  if (mail.messages?.length >= 1000) warnings.push('消息仅包含最近 1000 条；更早会话仍可展开读取执行记录。')
  const runs: RunView[] = []
  const environments = names()
  // Five CLI collections at a time keeps the desktop responsive while browsing older Runs.
  for (let i = 0; i < (page.runs || []).length; i += 5) {
    const batch: (RunView | null)[] = await Promise.all(page.runs.slice(i, i + 5).map(async (run: any) => {
      try {
        const view = await readRun(run, mail.messages || [], call, environments, warnings)
        for (const worker of view.workers) {
          const terminal = (terminals.terminals || []).find((t: any) => t.handle === worker.terminal)
          if (terminal) {
            if (!worker.agent && terminal.agentIdentity) { worker.agent = terminal.agentIdentity; worker.agentSource = '当前关联窗口' }
            if (!worker.workspace) worker.workspace = terminal.worktreeId || ''
          }
        }
        return { ...view, canReassess: !!run.coordinator_handle, activeTaskCount: view.tasks.filter(t => ACTIVE_TASK_STATUSES.has(t.status)).length, actionableMessageCount: view.messages.filter(message => isActionableMessage(message, view)).length, objective: view.objective.slice(0, 300),
          completedTasks: view.tasks.filter(task => COMPLETED_STATUSES.has(task.status)).map(({ id, dispatchId }) => ({ id, dispatchId })),
          tasks: view.tasks.filter(task => !COMPLETED_STATUSES.has(task.status)).map(task => ({ ...task, spec: task.spec.slice(0, 300), result: task.result.slice(0, 300), searchMatch: needle && [task.title, task.spec, task.result, ...view.messages.filter(m => m.taskId === task.id).map(m => m.body)].join(' ').toLocaleLowerCase().includes(needle) ? needle : '' })),
          messages: view.messages.filter((message, index) => index < 20 || isActionableMessage(message, view))
            .map(message => ({ ...message, body: message.body.slice(0, 300) })),
        }
      }
      catch (e) { warnings.push(`${run.id} 读取失败：${String(e)}`); return null }
    }))
    runs.push(...batch.filter((run): run is RunView => run !== null))
  }
  const workspaces = (spaces.worktrees || []).map((w: any) => ({ id: w.id, name: w.displayName || basename(w.path), path: w.path,
    project: w.projectId || w.repoId || '', projectName: (projects.projects || []).find((p: any) => p.id === w.projectId || p.sourceRepoIds?.includes(w.repoId))?.displayName || w.projectId || w.repoId || '' }))
  const focusedTerminal = terminals.terminals?.find((terminal: any) => context?.terminals.some(t => t.id === terminal.ptyId || t.id === terminal.id || t.id === terminal.handle))
  const focused = workspaces.find((w: any) => w.id === focusedTerminal?.worktreeId)
  const data: Snapshot = { runs, workspaces, currentWorkspace: focused?.id || current.worktree?.id || '', currentProject: focused?.project || current.worktree?.projectId || current.worktree?.repoId || '',
    routers: (terminals.terminals || []).filter((t: any) => t.agentIdentity && t.connected && t.writable).map((t: any) => ({ handle: t.handle, title: t.title || t.handle, agent: t.agentIdentity })),
    more: !!page.nextCursor, warnings: [...warnings, ...(spaces.warnings || [])] }
  listCache = { key, call, at: Date.now(), data }
  return data
}
async function resolve(selection: Selection, call: Cli) {
  if (!selection || typeof selection.runId !== 'string' || !/^run_[\w-]+$/.test(selection.runId)) throw new Error('无效 Run')
  const [show, inbox] = await Promise.all([
    call(['orchestration', 'run-show', '--id', selection.runId, '--full']),
    call(['orchestration', 'inbox', '--limit', '1000', '--full']),
  ])
  const run = await readRun(show.run, inbox.messages || [], call)
  const task = run.tasks.find(t => t.id === selection.taskId)
  if (selection.taskId && !task) throw new Error('任务已不存在，请刷新')
  const worker = selection.dispatchId ? run.workers.find(w => w.dispatchId === selection.dispatchId && (!task || w.taskId === task.id))
    : run.workers.find(w => w.dispatchId === task?.dispatchId) || run.workers.find(w => w.taskId === task?.id)
  if (selection.dispatchId && !worker) throw new Error('执行记录不属于此任务，请刷新')
  if (worker?.terminal && (!worker.workspace || !worker.agent)) {
    const terminal = (await call(['terminal', 'show', '--terminal', worker.terminal]).catch(() => ({}))).terminal
    if (terminal) { worker.workspace ||= terminal.worktreeId || ''; worker.agent ||= terminal.agentIdentity || '' }
  }
  return { run, task, worker, coordinatorHandle: show.run.coordinator_handle || '' }
}
export async function detail(input: Selection & { cursor?: string; history?: boolean }, call: Cli = cli): Promise<Detail> {
  const { run, task, worker } = await resolve(input, call)
  const fields = { spec: task?.spec || run.objective, result: task?.result || '', messages: run.messages.filter(m => !task || belongsToTask(m, task, worker)) }
  if (!worker) return { ...fields, source: '尚无会话', text: '尚无执行者会话；可展开任务与消息记录。', cursor: '', limited: false, warnings: [] }
  let result
  try { result = await call(['orchestration', 'worker-read', '--dispatch', worker.dispatchId, '--limit', input.history ? '50' : '32', '--full', ...(input.cursor ? ['--cursor', input.cursor] : [])]) }
  catch (e) { return { ...fields, source: '任务与消息记录', text: '', cursor: '', limited: true, warnings: [`执行者会话记录不可用：${String(e)}`] } }
  // The first native page is a tail window; its cursor follows new output, not older pages.
  const transcript = result.transcript
  const cursor = String(result.cursor || transcript?.nextCursor || '')
  const messages = transcript?.messages || []
  let text: string
  let partial = false
  let clipped = false
  if (transcript && !input.history) {
    const conversation = messages.filter((m: any) => ['user', 'assistant'].includes(m.role))
      .map((m: any) => ({ role: m.role, text: (m.blocks || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') }))
      .filter((m: any) => m.text.trim())
    const lastUser = conversation.map((m: any) => m.role).lastIndexOf('user')
    partial = lastUser < 0
    const user = lastUser >= 0 ? conversation[lastUser].text : ''
    const replies = (lastUser >= 0 ? conversation.slice(lastUser + 1) : conversation.slice(-1)).filter((m: any) => m.role === 'assistant').map((m: any) => m.text).join('\n\n')
    clipped = user.length > 4000 || replies.length > 7900
    text = `${user ? `user：${user.slice(0, 4000)}` : ''}${user && replies ? '\n\n' : ''}${replies ? `assistant：${replies.slice(-7900)}` : ''}`
    if (!text) text = '最近窗口没有可展示的用户输入或智能体回复。'
  } else {
    text = transcript ? messages.filter((m: any) => m.role !== 'reasoning').map((m: any) => {
      const body = (m.blocks || []).map((b: any) => b.type === 'text' ? b.text : b.type === 'tool-call' ? `[工具 ${b.name}]` : b.type === 'tool-result' ? String(b.output || '') : '').join('\n')
      return `${m.role}：${body}`
    }).join('\n\n') : (result.terminal?.tail || result.tail || []).join('\n')
    clipped = text.length > (input.history ? 60000 : 12000)
    text = text.slice(input.history ? 0 : -12000, input.history ? 60000 : undefined)
    partial = !input.history
  }
  return { ...fields, history: !!input.history, source: `${result.source || '执行记录'} · ${input.history ? '历史记录' : transcript ? '最近一轮' : '终端尾部（无法识别完整轮次）'}`, text: text || '这页没有可展示的对话内容',
    cursor: input.history ? cursor : '',
    limited: partial || clipped || result.contentComplete === false,
    warnings: [...(result.warnings || []), ...(partial && transcript ? ['尾部窗口未找到用户输入，仅展示最近回复；本轮不完整。'] : []), ...(clipped ? ['输出超过显示预算，已截断；可读取历史记录。'] : [])] }

}
export async function action(input: Action, call: Cli = cli): Promise<ActionResult> {
  if (!input || !['open', 'reassess', 'mention'].includes(input.kind)) throw new Error('不支持的操作')
  const { run, task, worker, coordinatorHandle } = await resolve(input, call)
  const handle = worker?.terminal || task?.assignee || run.handle
  if (input.kind === 'mention') {
    const router = input.router || run.handle
    if (!router || !/^term_[\w-]+$/.test(router)) throw new Error('没有可写的 Router 终端，请先选择 Router 窗口')
    const target = (await call(['terminal', 'show', '--terminal', router])).terminal
    if (!target?.connected || !target.writable || !target.agentIdentity) throw new Error('Router 窗口当前不是可写的智能体输入框')
    const location = handle && !worker?.workspace ? (await call(['terminal', 'show', '--terminal', handle]).catch(() => ({}))).terminal?.worktreeId : worker?.workspace
    const reference = `@任务「${task?.title || run.name}」 run=${run.runId}${task ? ` task=${task.id}` : ''}${worker ? ` dispatch=${worker.dispatchId}` : ''}${handle ? ` window=${handle}` : ''}${location ? ` workspace=${location}` : ''} `
      .replace(/[\x00-\x1f\x7f]/g, ' ')
    // A single line, no Enter: append a reference to the owner's existing draft, never submit it.
    const receipt = await call(['terminal', 'send', '--terminal', router, '--text', reference])
    if (receipt.accepted === false) throw new Error('Orca 未接受定位文本，未自动重试')
    await call(['terminal', 'switch', '--terminal', router])
    return { ok: true, message: '任务与窗口定位已填入 Router 输入框，未发送。' }
  }
  if (input.kind === 'open') {
    if (handle) {
      try { await call(['terminal', 'switch', '--terminal', handle]); return { ok: true, message: '已定位窗口' } }
      catch (e) { if (!worker?.workspace) throw e }
    }
    if (!worker?.workspace) throw new Error('没有可定位的窗口或工作区')
    await call(['worktree', 'activate', '--worktree', `id:${worker.workspace}`])
    return { ok: true, message: '原窗口不可用，已定位工作区' }
  }
  if (!coordinatorHandle) throw new Error('此 Run 没有绑定的 Router，无法请求重新判断')
  const phrase = '条件可能具备，请重新判断'
  const receipt = await call(['orchestration', 'send', '--run', run.runId, '--to', `run:${run.runId}`, '--from', `run:${run.runId}`,
    '--type', 'question', '--subject', phrase, '--body', phrase, '--payload', JSON.stringify({ source: 'osa-panel', runId: run.runId, ...(task || worker?.taskId ? { taskId: task?.id || worker?.taskId } : {}), ...(worker ? { dispatchId: worker.dispatchId } : {}) }), '--full'])
  return { ok: true, message: '已请求 Router 重新判断；原任务状态未变。', receipt: JSON.stringify(receipt, null, 2) }

}
export default function activate(orca: OrcaWorkerApi) {
  orca.panels.handle('osa-tasks.list', async input => collect(input?.limit, cli, await orca.host.call('workspace.readContext'), input?.query, input?.force))
  orca.panels.handle('osa-tasks.detail', input => detail(input))
  orca.panels.handle('osa-tasks.action', input => action(input))
}
