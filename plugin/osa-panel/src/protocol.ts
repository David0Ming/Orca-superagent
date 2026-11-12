export const ACTIVE_TASK_STATUSES = new Set(['pending', 'ready', 'dispatched'])
export const COMPLETED_STATUSES = new Set(['completed', 'succeeded', 'success', 'done'])
export type Section = 'attention' | 'queued' | 'active' | 'history'
export interface MessageView {
  id: string; from: string; to: string; subject: string; body: string; type: string
  createdAt: string; unread: boolean; taskId: string; dispatchId: string
  threadId?: string; deliveredAt?: string; replied?: boolean; source?: string
}
export function isSystemReceipt(message: Pick<MessageView, 'id' | 'subject' | 'body'>) {
  return message.id.toLowerCase().startsWith('msg_stop_')
    || /did\s+not\s+reach|reach\s+the\s+finished\s+worker|worker\s+stopped\s+without\s+reporting|waiting\s+on\s+a\s+prompt/i.test(`${message.subject} ${message.body}`)
}
// Status has no reliable human-author marker in the native inbox response.
export function isActionableMessage(message: Pick<MessageView, 'id' | 'subject' | 'body' | 'type' | 'unread' | 'to' | 'from' | 'replied' | 'source'>, run: Pick<RunView, 'runId' | 'handle'>) {
  return !message.replied && (message.to === `run:${run.runId}` || (!!run.handle && message.to === run.handle))
    && ['question', 'escalation'].includes(message.type) && !isSystemReceipt(message)
    && message.source !== 'osa-panel'
    && !(message.from === `run:${run.runId}` && message.to === message.from)
}
export function belongsToTask(message: MessageView, task: TaskView, worker?: WorkerView) {
  if (message.taskId) return message.taskId === task.id
  if (message.dispatchId) return message.dispatchId === (worker?.dispatchId || task.dispatchId)
  return !!worker?.terminal && (message.from === worker.terminal || message.to === worker.terminal)
}
export interface WorkerView {
  dispatchId: string; taskId: string; state: string; liveness: string
  activity?: string; agentSource?: string; agent: string; terminal: string; terminalState: string; workspace: string
}
export interface TaskView {
  id: string; title: string; status: string; spec: string; result: string; resultTitle?: string; resultSource?: string; dependencies?: string[]
  updatedAt: string; dispatchId: string; assignee: string; searchMatch?: string; waitingCondition?: string
}
export function waitingCondition(task: Pick<TaskView, 'resultTitle' | 'result' | 'spec' | 'dependencies'>) {
  if (task.dependencies?.length) return `等待：${task.dependencies.join('、')}`
  for (const text of [task.resultTitle, task.result, task.spec]) {
    for (const clause of (text || '').split(/[。；;\n]/)) {
      if (/(?:不|无需|无须|不用|不要)\s*(?:等待|等|待|依赖)/.test(clause) || /^\s*(?:若|如果|假如|如需|当.+?时)/.test(clause)) continue
      const match = clause.match(/((?:等待|依赖)[^。；;\n]{1,80})/)
        || clause.match(/(?:^|[：:，,])\s*((?:等|待)[^。；;\n]{1,80})/)
        || clause.match(/【前置[^】]*】\s*(.+)/)
      if (match) return match[1].trim()
    }
  }
  return '等待条件未注明'
}
export interface RunView {
  name: string; runId: string; objective: string; project: string; handle: string
  canReassess?: boolean; activeTaskCount?: number; actionableMessageCount?: number
  completedTasks?: Pick<TaskView, 'id' | 'dispatchId'>[]
  tasks: TaskView[]; workers: WorkerView[]; messages: MessageView[]; updatedAt: string
}
export function isLiveRun(run: RunView) {
  return run.workers.some(worker => worker.liveness === 'live')
    || !!(run.activeTaskCount ?? run.tasks.filter(task => ACTIVE_TASK_STATUSES.has(task.status)).length)
}
export interface WorkspaceView { id: string; name: string; path: string; project: string; projectName: string }
export interface Snapshot {
  runs: RunView[]; workspaces: WorkspaceView[]; currentWorkspace: string; currentProject: string
  routers?: { handle: string; title: string; agent: string }[]
  more: boolean; warnings: string[]
}
export interface Selection { runId: string; taskId?: string; dispatchId?: string }
export interface Detail {
  source: string; text: string; cursor: string; limited: boolean; warnings: string[]
  history?: boolean; spec: string; result: string; messages: MessageView[]
}
export interface Action extends Selection {
  kind: 'open' | 'reassess' | 'mention'; router?: string
}
export interface ActionResult { ok: boolean; message: string; receipt?: string }
declare module 'orca' {
  interface PluginRequests {
    'osa-tasks.list': { input: { limit?: number; query?: string; force?: boolean } | undefined; output: Snapshot }
    'osa-tasks.detail': { input: Selection & { cursor?: string; history?: boolean }; output: Detail }
    'osa-tasks.action': { input: Action; output: ActionResult }
  }
}
