import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import { Projects, type TicketTarget, type TaskPlan } from './projects.ts'
import { promisify } from 'node:util'
import type { Assignment, Engine, Executor, Ticket } from '../vendor/dsh-core/src/index.ts'
import type { Store } from './store.ts'
import type { Request } from './app.ts'

const execute = promisify(execFile)
type Json = Record<string, any>
type Job = { id: string; kind: 'start' | 'deliver' | 'stop'; ticketId: string; assignmentId: string; inputIds?: string[]; reason?: string; done?: boolean; error?: string; nextAttemptAt?: number }
type Binding = { id: string; ticketId: string; anchor?: string; generation: number; runId?: string; taskId?: string; dispatchId?: string; terminal?: string; poll: number; nextPollAt?: number; nextObservationAt?: number; settled?: string; released?: boolean; closing?: boolean; finished?: boolean; releaseState?: 'released' | 'retained' }
type Operation = { id: string; requestId: string; args: string[]; attempted?: boolean; response?: Json }
type Recovery = { id: string; ticketId: string; assignmentId: string; previous: string; done?: boolean }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`Orca omitted ${label}`)
  return value
}

/** Synchronous ports only enqueue; tick performs and records external effects. */
export class OrcaExecutor implements Executor {
  private readonly working = new Map<string, Promise<void>>()
  private retrying = new Map<string, Promise<unknown>>()
  constructor(private readonly store: Store, private readonly options: { repository: string; cli: string; osaCommand: string; twoLayer?: boolean; stallMs?: number; agent?: string; model?: string; maxExecutors?: number; report?: (request: Request) => Promise<unknown> }) {
    if (!Number.isSafeInteger(options.maxExecutors ?? 1) || (options.maxExecutors ?? 1) < 1) throw new Error('maxExecutors must be a positive integer')
  }

  retryTicket(engine: Engine, ticketId: string): Promise<unknown> {
    const active = this.retrying.get(ticketId)
    if (active) return active
    const work = this.retry(engine, ticketId).finally(() => { this.retrying.delete(ticketId) })
    this.retrying.set(ticketId, work)
    return work
  }

  private async retry(engine: Engine, ticketId: string): Promise<unknown> {
    const blocked = new Projects(this.store).blocked(ticketId)
    if (blocked) throw new Error(blocked)
    this.pulse(engine)
    await this.working.get(this.store.tickets.get(ticketId)?.assignments.at(-1)?.id ?? '')
    const ticket = this.store.tickets.get(ticketId), assignment = ticket?.assignments.at(-1)
    const binding = assignment && this.store.get<Binding>('orca-assignment', assignment.id)
    if (!ticket || ticket.ended || !binding?.dispatchId || !binding.taskId || !ticket.execution?.directory) throw new Error('No recoverable Executor assignment')
    const completed = this.store.get<Recovery>('orca-recovery', `retry:${binding.id}:${binding.dispatchId}`)
    if (completed?.done) {
      if (this.store.get('execution-hold', binding.id)) throw new Error('Held assignment has a completed recovery receipt; inspect before retrying')
      const response = this.store.get<Operation>('orca-operation', completed.id)?.response
      const receipt = response?.ok === true && response.result
      if (!receipt || receipt.state !== 'ready' || !receipt.dispatchId || receipt.dispatchId === binding.dispatchId || receipt.taskId !== binding.taskId || receipt.runId !== binding.runId || !receipt.effects?.some((item: Json) => item.kind === 'terminal' && item.role === 'agent' && item.id))
        throw new Error('Completed recovery has no usable receipt; inspect before retrying')
      this.store.put('orca-recovery', completed.id, { ...completed, done: false })
      await this.working.get(binding.id)
      this.pulse(engine)
      await this.working.get(binding.id)
      if (this.store.get<Binding>('orca-assignment', binding.id)?.dispatchId === binding.dispatchId)
        throw new Error('Completed recovery could not be reconciled; inspect its saved receipt')
      return this.retry(engine, ticketId)
    }
    const pending = this.store.list<Recovery>('orca-recovery').find(item => item.assignmentId === binding.id && !item.done)
    if (pending) throw new Error('Recovery remains pending; inspect status before another request')
    let shown = await this.read(['orchestration', 'worker-show', '--dispatch', binding.dispatchId])
    if (shown.dispatch?.id !== binding.dispatchId || shown.dispatch?.taskId !== binding.taskId || shown.dispatch?.runId !== binding.runId
      || shown.projection?.liveness?.verdict === 'live')
      throw new Error('Retry requires a positively failed or stopped attempt; inspect or explicitly stop it first')
    if (shown.terminalResource?.ownershipState === 'user_owned') throw new Error('Executor is user-owned; inspect before recovery')
    if (!['failed', 'stopped'].includes(shown.worker?.state) || shown.dispatch?.status !== 'failed') {
      const fleet = await this.read(['orchestration', 'worker-list', '--run', binding.runId!, '--include-remote'])
      const worker = fleet.workers?.find((item: Json) => item.dispatchId === binding.dispatchId && item.taskId === binding.taskId && item.runId === binding.runId)
      if (fleet.page?.hasMore || worker?.projection?.liveness?.verdict !== 'exited')
        throw new Error('Retry requires a positively failed or stopped attempt; inspect or explicitly stop it first')
      const stopped = await this.mutation(`retire:${binding.dispatchId}`, ['orchestration', 'worker-stop', '--dispatch', binding.dispatchId])
      if (stopped.state !== 'stopped') throw new Error('Exited Executor stop is unresolved; preserve assignment')
      shown = await this.read(['orchestration', 'worker-show', '--dispatch', binding.dispatchId])
      if (shown.dispatch?.id !== binding.dispatchId || shown.dispatch?.taskId !== binding.taskId || shown.dispatch?.runId !== binding.runId
        || shown.dispatch?.status !== 'failed' || !['failed', 'stopped'].includes(shown.worker?.state)) throw new Error('Executor stop is unconfirmed')
    }
    this.store.put('execution-attempt', binding.dispatchId, { ...this.store.get<Json>('execution', binding.id),
      id: binding.id, ticketId, taskId: binding.taskId, dispatchId: binding.dispatchId,
      report: this.store.tickets.get(ticketId)?.assignments.find(item => item.id === binding.id)?.report,
      provider: shown.projection?.provider?.id ?? shown.worker?.startOptions?.launch?.effective?.agent ?? this.store.get<Json>('execution', binding.id)?.provider ?? null,
      model: shown.projection?.provider?.model ?? shown.worker?.startOptions?.launch?.effective?.model ?? this.store.get<Json>('execution', binding.id)?.model ?? null,
      observedAt: Date.now(), nativeState: shown.worker.state, outcome: 'failed', liveness: shown.projection?.liveness?.verdict ?? 'unverifiable' })
    await this.assertChildrenReleased(binding)
    this.store.atomic(() => {
      const current = this.store.tickets.get(ticketId)!
      if (current.ended || current.assignments.at(-1)?.id !== binding.id) throw new Error('Ticket changed during recovery inspection')
      const recovery: Recovery = { id: `retry:${binding.id}:${binding.dispatchId}`, ticketId, assignmentId: binding.id, previous: binding.dispatchId! }
      if (this.store.get('orca-recovery', recovery.id)) return
      if (this.store.get<Binding>('orca-assignment', binding.id)?.dispatchId !== binding.dispatchId) throw new Error('Executor changed during recovery inspection')
      if (!this.canStart(current, binding.id)) throw new Error('Executor capacity, target or resource is blocked; retry later')
      this.store.put('orca-recovery', recovery.id, recovery)
      this.store.delete('execution-hold', binding.id)
      binding.finished = false
      this.save(binding)
      engine.note(ticketId, `Recovery after confirmed ${shown.worker.state} of ${binding.dispatchId}. Inspect the existing worktree, git history and external state; preserve completed work and do not repeat external effects. Previous report: ${current.assignments.at(-1)?.report?.summary ?? 'none'}. Read all unread inputs before continuing.`)
    })
    // A lane already in flight may predate the newly queued recovery.
    await this.working.get(binding.id)
    this.pulse(engine)
    await this.working.get(binding.id)
    const remaining = this.store.list<Recovery>('orca-recovery').find(item => item.assignmentId === binding.id && !item.done)
    if (remaining) throw new Error('Recovery remains pending; inspect status before another request')
    return this.store.get('execution', binding.id)
  }

  private async assertChildrenReleased(binding: Binding): Promise<void> {
    // A stopped coordinator may leave editors in its child Run. Never overlap them with a replacement.
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      const runs = await this.read(['orchestration', 'run-list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])
      if (!Array.isArray(runs.runs)) throw new Error('Cannot verify child Runs')
      for (const run of runs.runs.filter((item: Json) => item.coordinator_handle === binding.terminal)) {
        const children = await this.read(['orchestration', 'worker-list', '--run', text(run.id, 'child Run ID'), '--include-remote'])
        if (!Array.isArray(children.workers) || children.page?.hasMore) throw new Error(`Cannot verify child workers in Run ${run.id}`)
        for (const child of children.workers.filter((item: Json) => item.dispatchId !== binding.dispatchId)) {
          const liveness = child.projection?.liveness?.verdict
          if (liveness === 'live' || (child.terminalState !== 'released' && liveness !== 'exited' && !['succeeded', 'failed'].includes(child.workerState)))
            throw new Error(`Child worker resources remain unresolved: ${child.dispatchId ?? 'unknown'} (state ${child.workerState ?? 'unknown'}, liveness ${liveness ?? 'unknown'}, terminal ${child.terminalState ?? 'unknown'}); inspect before recovery`)
        }
      }
      cursor = runs.nextCursor || undefined
      if (cursor && cursors.has(cursor)) throw new Error('Run pagination did not advance')
      if (cursor) cursors.add(cursor)
    } while (cursor)
  }

  private async recover(recovery: Recovery, engine: Engine): Promise<void> {
    const binding = this.store.get<Binding>('orca-assignment', recovery.assignmentId)!, ticket = this.store.tickets.get(recovery.ticketId)!
    const operation = this.store.get<Operation>('orca-operation', recovery.id)
    if ((ticket.ended || ticket.assignments.at(-1)?.id !== binding.id)
      && (!operation?.attempted || (operation.response?.ok === false && operation.response.error?.code === 'task_not_startable'))) {
      this.store.put('orca-recovery', recovery.id, { ...recovery, done: true })
      return
    }
    if (!operation?.attempted && !this.canStart(ticket, binding.id)) return
    await this.verifyWorkspace(ticket)
    await this.anchor(binding)
    if (!operation?.attempted) {
      const current = this.store.tickets.get(ticket.id)
      if (!current || current.ended || current.assignments.at(-1)?.id !== binding.id) {
        this.store.put('orca-recovery', recovery.id, { ...recovery, done: true })
        return
      }
      if (!this.canStart(current, binding.id)) return
    }
    const receipt = await this.mutation(recovery.id, ['orchestration', 'worker-start', '--task', binding.taskId!, '--retry-of', recovery.previous,
      '--worktree', `path:${ticket.execution!.directory}`, '--agent', this.options.agent ?? 'codex', ...(this.options.model ? ['--model', this.options.model] : []), '--run', binding.runId!, '--from', binding.anchor!])
    if (receipt.taskId !== binding.taskId || receipt.runId !== binding.runId) throw new Error('Recovery did not return the original Task; inspect saved receipt')
    const dispatchId = text(receipt.dispatchId, 'recovery dispatch'), terminal = receipt.effects?.find((item: Json) => item.kind === 'terminal' && item.role === 'agent')?.id
    if (receipt.state === 'ready') text(terminal, 'recovery terminal')
    this.store.atomic(() => {
      if (this.store.get<Recovery>('orca-recovery', recovery.id)?.done) return
      const current = this.store.tickets.get(ticket.id)!
      binding.dispatchId = dispatchId; binding.terminal = terminal
      delete binding.settled; delete binding.released; delete binding.closing; delete binding.finished
      delete binding.nextPollAt
      delete binding.nextObservationAt
      this.save(binding)
      this.store.delete('orca-operation', `close:${binding.id}`)
      this.store.put('orca-recovery', recovery.id, { ...recovery, done: true })
      const record = { id: binding.id, ticketId: ticket.id, dispatchId, taskId: binding.taskId, startedAt: Date.now(), provider: receipt.launch?.effective?.agent ?? null,
        model: receipt.launch?.effective?.model ?? null, outcome: receipt.state === 'ready' ? 'in_progress' : ['failed', 'stopped'].includes(receipt.state) ? 'failed' : 'unknown', nativeState: receipt.state, recoveredFrom: recovery.previous }
      this.store.put('execution', binding.id, record)
      this.store.put('execution-attempt', dispatchId, record)
      this.store.delete('notice', recovery.id)
      this.store.delete('notice', `recovery:${binding.id}`)
      for (const op of this.store.list<Operation>('orca-operation').filter(op => op.id.startsWith(`deliver:${binding.id}:`))) {
        if (op.response?.ok === false && ['dispatch_inactive', 'recipient_run_mismatch'].includes(op.response.error?.code)) {
          this.store.put('orca-rejected-operation', op.requestId, op)
          this.store.delete('orca-operation', op.id)
        }
      }
      if (current.ended || current.assignments.at(-1)?.id !== binding.id) {
        this.store.put('orca-job', `stop:${binding.id}`, { id: `stop:${binding.id}`, kind: 'stop', ticketId: current.id, assignmentId: binding.id, reason: 'Ticket changed during recovery' })
      } else if (receipt.state === 'ready') {
        delete current.assignments.at(-1)!.report
        current.assignments.at(-1)!.state = 'running'
        this.store.tickets.save(current)
        engine.assignmentStarted(ticket.id, binding.id)
      } else this.notice(`supervision:${binding.id}`, ticket.id, `Orca recovery ${receipt.state}; inspect the same Task before explicit retry.`)
    })
  }

  start(ticket: Ticket, assignment: Assignment): void {
    this.store.atomic(() => {
      if (!this.store.get('capability', assignment.id)) this.store.put('capability', assignment.id, { token: randomUUID() })
      this.queue({ id: `start:${assignment.id}`, kind: 'start', ticketId: ticket.id, assignmentId: assignment.id })
    })
  }

  deliver(ticket: Ticket, assignment: Assignment): void {
    this.store.atomic(() => {
      // One durable job per input also deduplicates overlapping delivery batches.
      for (const id of ticket.undelivered) this.queue({ id: `deliver:${assignment.id}:${id}`, kind: 'deliver', ticketId: ticket.id, assignmentId: assignment.id, inputIds: [id] })
    })
  }

  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.store.atomic(() => this.queue({ id: `stop:${assignment.id}`, kind: 'stop', ticketId: ticket.id, assignmentId: assignment.id, reason,
      done: ticket.ended?.by === 'executor' }))
  }

  tick(engine: Engine): Promise<void> {
    this.pulse(engine)
    return Promise.all(this.working.values()).then(() => {})
  }

  pulse(engine: Engine): void {
    const jobs = this.store.list<Job>('orca-job').filter(job => !job.done)
    const starts = this.orderStarts(jobs.filter(job => job.kind === 'start'))
    const ids = new Set([
      ...this.store.list<Recovery>('orca-recovery').filter(r => !r.done).map(r => r.assignmentId),
      ...jobs.filter(job => job.kind !== 'start').map(job => job.assignmentId),
      ...starts.map(job => job.assignmentId),
      ...this.store.list<Binding>('orca-assignment').filter(b => b.dispatchId && (!b.finished || (b.released && !this.store.get<{done?: boolean}>('orca-operation', `close:${b.id}`)?.done))).map(b => b.id),
    ])
    for (const id of ids) if (!this.working.has(id) && !this.store.get('execution-hold', id)) {
      const work = this.runAssignment(engine, id).catch(error => this.notice(`assignment:${id}`, this.store.get<Binding>('orca-assignment', id)?.ticketId ?? '', String(error)))
        .finally(() => { this.working.delete(id) })
      this.working.set(id, work)
    }
  }

  async drain(): Promise<void> { await Promise.all(this.working.values()) }

  private queue(job: Job): void {
    if (!this.store.get('orca-job', job.id)) this.store.put('orca-job', job.id, job)
  }

  private notice(id: string, ticketId: string, message: string): void {
    this.store.put('notice', id, { id, ticketId, text: message })
  }

  private repository(ticketId: string): string {
    return this.store.get<TicketTarget>('ticket-target', ticketId)?.repository ?? this.options.repository
  }

  private async verifyWorkspace(ticket: Ticket): Promise<void> {
    const projects = new Projects(this.store), targets = projects.targets(ticket.id)
    if (!targets.length) return
    for (const target of targets) {
      const directory = projects.directory(ticket.id, target.locationId)
      if (!directory) throw new Error(`Missing workspace for ${target.locationId}`)
      await this.verifyTargetWorkspace(ticket, target, directory)
    }
  }

  private async verifyTargetWorkspace(ticket: Ticket, target: ReturnType<Projects['targets']>[number], directory: string): Promise<void> {
    if (!isAbsolute(directory)) throw new Error('Ticket execution.directory must be absolute')
    const plan = this.store.get<TaskPlan>('task-plan', ticket.id)
    if (plan?.workspace === 'inspect') {
      if (realpathSync(directory) !== realpathSync(target.repository)) throw new Error('Inspection directory changed')
      return
    }
    const common = async (path: string) => realpathSync((await execute('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim())
    if (realpathSync(directory) === realpathSync(target.repository) || await common(directory) !== await common(target.repository)) throw new Error('Execution workspace is not an isolated worktree of the frozen target')
    const projects = new Projects(this.store), owner = projects.workspaceOwner(ticket.id)
    const primary = projects.targets(owner)[0]?.locationId === target.locationId
    const operation = this.store.get<Operation>('orca-operation', `worktree:${owner}${primary ? '' : ':' + target.locationId}`)
    const ownedPath = operation?.response && this.result(operation.response).worktree?.path
    if (!ownedPath || realpathSync(ownedPath) !== realpathSync(directory)) throw new Error('Execution workspace has no ticket-owned creation receipt')
  }

  private canStart(ticket: Ticket, assignmentId: string): boolean {
    const projects = new Projects(this.store), blocked = projects.blocked(ticket.id)
    const active = this.store.list<Binding>('orca-assignment').filter(item => item.id !== assignmentId && !item.finished && !this.store.get<{capacityReleased?: boolean}>('execution-hold', item.id)?.capacityReleased)
    const resources = this.store.get<TaskPlan>('task-plan', ticket.id)?.resources ?? []
    const directories = (id: string) => {
      const targets = projects.targets(id)
      return (targets.length ? targets.map(target => projects.directory(id, target.locationId)) : [projects.directory(id)]).filter((path): path is string => !!path).map(path => realpathSync(path))
    }
    const paths = directories(ticket.id)
    const conflict = active.some(item => {
      const other = this.store.tickets.get(item.ticketId)
      return resources.some(resource => this.store.get<TaskPlan>('task-plan', item.ticketId)?.resources.includes(resource)) ||
        (!!other && directories(other.id).some(path => paths.includes(path)))
    })
    const reason = blocked ?? (active.length >= (this.options.maxExecutors ?? 1) ? 'Executor capacity reached' : conflict ? 'Shared resource or workspace occupied' : undefined)
    if (reason) this.notice(`queue:${ticket.id}`, ticket.id, reason)
    else this.store.delete('notice', `queue:${ticket.id}`)
    return !reason
  }

  private orderStarts(jobs: Job[]): Job[] {
    const served = new Map<string, number>()
    const project = (job: Job) => this.store.get<TicketTarget>('ticket-target', job.ticketId)?.projectId ?? 'legacy'
    const turn = (id: string) => served.get(id) ?? this.store.get<{ turn: number }>('scheduler-project', id)?.turn ?? 0
    const score = (job: Job) => {
      const plan = this.store.get<TaskPlan>('task-plan', job.ticketId)
      const created = Date.parse(plan?.createdAt ?? this.store.tickets.get(job.ticketId)?.createdAt ?? '')
      return (plan?.priority ?? 0) + (Number.isFinite(created) ? (Date.now() - created) / 60_000 : 0)
    }
    const pending = [...jobs], ordered: Job[] = []
    let nextTurn = (this.store.get<{ turn: number }>('scheduler', 'clock')?.turn ?? 0) + 1
    while (pending.length) {
      pending.sort((a, b) => turn(project(a)) - turn(project(b)) || score(b) - score(a))
      const job = pending.shift()!
      ordered.push(job); served.set(project(job), nextTurn++)
    }
    return ordered
  }

  private async runAssignment(engine: Engine, assignmentId: string): Promise<void> {
    if (this.store.get('execution-hold', assignmentId)) return
    for (const recovery of this.store.list<Recovery>('orca-recovery').filter(item => !item.done && item.assignmentId === assignmentId)) {
      try { await this.recover(recovery, engine) }
      catch (error) { this.notice(recovery.id, recovery.ticketId, String(error)) }
    }
    const jobs = this.store.list<Job>('orca-job').filter(item => !item.done && item.assignmentId === assignmentId)
    for (const job of jobs) {
      try {
        const ticket = this.store.tickets.get(job.ticketId)
        if ((job.nextAttemptAt ?? 0) > Date.now() && (job.kind !== 'start' || !ticket?.ended || this.store.get<Operation>('orca-operation', `launch:${job.assignmentId}`)?.attempted)) continue
        if (!ticket) throw new Error('Missing ticket for Orca job')
        if (this.store.list<Recovery>('orca-recovery').some(item => item.assignmentId === job.assignmentId && !item.done)) continue
        if (job.kind === 'start') await this.launch(job, ticket, engine)
        else if (job.kind === 'deliver') await this.sendInputs(job, ticket, engine)
        else await this.cancel(job)
      } catch (error) {
        job.error = String(error)
        job.nextAttemptAt = Date.now() + 15_000
        this.store.atomic(() => {
          this.store.put('orca-job', job.id, job)
          this.notice(job.id, job.ticketId, job.error!)
          if (job.kind === 'deliver') engine.deliveryFailed(job.ticketId, job.assignmentId, job.error!)
        })
      }
    }
    for (const binding of this.store.list<Binding>('orca-assignment').filter(item => item.id === assignmentId && item.dispatchId
      && (!item.finished || (item.released && !this.store.get<{ done?: boolean }>('orca-operation', `close:${item.id}`)?.done)))) {
      if (this.store.list<Recovery>('orca-recovery').some(item => item.assignmentId === binding.id && !item.done)) continue
      try { await this.poll(binding) }
      catch (error) { binding.nextPollAt = Date.now() + 15_000; this.save(binding); this.notice(`poll:${binding.id}`, binding.ticketId, String(error)) }
      try { await this.observe(binding) }
      catch (error) { this.notice(`supervision:${binding.id}`, binding.ticketId, `Executor observation unavailable; preserve the original Dispatch and inspect: ${String(error)}`) }
    }
  }

  private async observe(binding: Binding): Promise<void> {
    const previous = this.store.get<Json>('execution', binding.id)
    if ((binding.nextObservationAt ?? 0) > Date.now()) return
    binding.nextObservationAt = Date.now() + 15_000
    this.save(binding)
    const shown = await this.read(['orchestration', 'worker-show', '--dispatch', binding.dispatchId!])
    if (shown.dispatch?.id !== binding.dispatchId || shown.dispatch?.taskId !== binding.taskId || shown.dispatch?.runId !== binding.runId) throw new Error('Observation does not match Executor')
    const projection = shown.projection, launch = shown.worker?.startOptions?.launch?.effective, now = Date.now()
    const outcome = projection?.outcome ?? (binding.settled ? (shown.dispatch.status === 'completed' ? 'succeeded' : 'failed')
      : previous?.outcome === 'stopped' ? 'stopped' : shown.dispatch.status === 'failed' && ['failed', 'stopped'].includes(shown.worker?.state) ? shown.worker.state : 'unknown')
    const record = { ...previous, id: binding.id, ticketId: binding.ticketId, dispatchId: binding.dispatchId, taskId: binding.taskId,
      startedAt: previous?.startedAt ?? now, observedAt: now, provider: projection?.provider?.id ?? launch?.agent ?? previous?.provider ?? null,
      model: projection?.provider?.model ?? launch?.model ?? previous?.model ?? null, outcome,
      liveness: projection?.liveness?.verdict ?? 'unverifiable', nativeState: shown.worker?.state,
      report: this.store.tickets.get(binding.ticketId)?.assignments.find(item => item.id === binding.id)?.report }
    this.store.put('execution', binding.id, record)
    this.store.put('execution-attempt', binding.dispatchId!, record)
    if (!binding.finished && (!binding.settled || this.store.get<{text: string}>('notice', `poll:${binding.id}`)?.text.includes('consumer_fenced'))) await this.reconcileSettlement(binding, shown)
    if (!binding.finished && !binding.settled && (now - record.startedAt >= (this.options.stallMs ?? 30 * 60_000) || ['failed', 'stopped'].includes(shown.worker?.state)))
      this.notice(`supervision:${binding.id}`, binding.ticketId, `Executor requires inspection: ${record.nativeState}, liveness ${record.liveness}. Timeout is not proof of exit. Inspect the original Dispatch; retry only after confirmed failure/stop and resolved children.`)
    else this.store.delete('notice', `supervision:${binding.id}`)
  }

  private async reconcileSettlement(binding: Binding, shown: Json): Promise<void> {
    let changed = !binding.settled
    if (!binding.settled) {
      const status = shown.dispatch.status, state = shown.worker?.state
      if (!((status === 'completed' && state === 'succeeded') || (status === 'failed' && state === 'failed'))) {
        // A cancelled/abandoned attempt may have no worker_done, but absence never releases a slot.
        if (!['stopped', 'abandoned'].includes(state)) return
        const fleet = await this.read(['orchestration', 'worker-list', '--run', binding.runId!, '--include-remote'])
        const worker = fleet.workers?.find((w: Json) => w.dispatchId === binding.dispatchId && w.taskId === binding.taskId && w.runId === binding.runId)
        const liveness = worker?.projection?.liveness
        const hostExit = liveness?.verdict === 'unverifiable' && ['missing_status', 'capability_unsupported'].includes(liveness.reason)
          && shown.dispatch.hostScope?.kind === 'local' && shown.observation?.exactWorker === true && shown.observation.status === 'exited'
        if (fleet.page?.hasMore || (liveness?.verdict !== 'exited' && !hostExit)) return
        await this.assertChildrenReleased(binding)
        this.store.put('orca-retirement', binding.dispatchId!, { dispatch: shown.dispatch, worker, observation: shown.observation, observedAt: Date.now() })
        binding.closing = true
        this.save(binding)
        await this.closeAnchor(binding)
        if (!this.store.tickets.get(binding.ticketId)?.ended) this.notice(`recovery:${binding.id}`, binding.ticketId, 'Executor positively exited; capacity released, unfinished goal and inputs preserved. Inspect the original attempt and use route retry within the existing authorization; do not cancel the business ticket.')
        return
      }
      const current = await this.read(['orchestration', 'dispatch-show', '--task', binding.taskId!])
      if (current.dispatch?.id !== binding.dispatchId) throw new Error('Settlement belongs to a superseded Dispatch; preserve ownership')
      const tasks = await this.read(['orchestration', 'task-list', '--run', binding.runId!])
      const task = tasks.tasks?.find((t: Json) => t.id === binding.taskId && t.run_id === binding.runId)
      const result = typeof task?.result === 'string' ? JSON.parse(task.result) : task?.result
      if (task?.status !== status || result?.provenance !== 'worker_report'
        || result.outcome !== (status === 'completed' ? 'succeeded' : 'failed')
        || result.reportedBy !== binding.terminal || result.completedBy !== binding.terminal
        || typeof result.messageId !== 'string' || !result.messageId) return
      await this.assertChildrenReleased(binding)
      this.store.atomic(() => {
        this.store.put('orca-settlement', binding.dispatchId!, { dispatch: shown.dispatch, result })
        binding.settled = result.messageId
        this.save(binding)
        if (!this.store.tickets.get(binding.ticketId)?.assignments.find(a => a.id === binding.id)?.report) this.notice(result.messageId, binding.ticketId, 'Reconciled worker completion has no domain report; ticket is not ready.')
      })
    }
    // Only reclaim our own Run from its settled worker, never from another coordinator.
    const run = (await this.read(['orchestration', 'run-show', '--id', binding.runId!])).run
    if (run?.id !== binding.runId) throw new Error('Settlement Run identity mismatch')
    if (run.coordinator_handle !== binding.anchor) {
      if (run.coordinator_handle !== binding.terminal) throw new Error('Run has a different coordinator; preserve ownership')
      await this.assertChildrenReleased(binding)
      await this.anchor(binding)
      changed = true
      await this.mutation(`rebind:${binding.id}:${binding.dispatchId}:${run.consumer_generation}`, ['orchestration', 'run-use', '--id', binding.runId!, '--from', binding.anchor!])
      for (const op of this.store.list<Operation>('orca-operation').filter(op => op.id.startsWith(`check:${binding.id}:`) || op.id.startsWith(`ack:${binding.id}:`))) {
        if (op.response?.ok === false && op.response.error?.code === 'consumer_fenced') {
          this.store.put('orca-rejected-operation', op.requestId, op)
          this.store.delete('orca-operation', op.id)
        }
      }
    }
    if (changed) delete binding.nextPollAt
    this.save(binding)
  }

  private finish(job: Job): void {
    job.done = true
    delete job.error
    delete job.nextAttemptAt
    this.store.put('orca-job', job.id, job)
    this.store.delete('notice', job.id)
  }

  private async cli(args: string[]): Promise<Json> {
    // An attested parent shell cannot impersonate our external coordinator anchors.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ORCA_')))
    let stdout: string
    try {
      ;({ stdout } = await execute(this.options.cli, [...args, '--json', ...(args[0] === 'orchestration' ? ['--full'] : [])], { env, cwd: this.options.repository, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }))
    } catch (error) {
      stdout = (error as { stdout?: string }).stdout ?? ''
      if (!stdout.trim()) throw error
    }
    const response = JSON.parse(stdout)
    if (!response || typeof response.ok !== 'boolean') throw new Error('Invalid Orca JSON envelope')
    return response
  }

  private result(response: Json): Json {
    if (!response.ok) throw new Error(`Orca ${response.error?.code ?? 'error'}: ${response.error?.message ?? JSON.stringify(response.error)}`)
    if (!response.result || typeof response.result !== 'object') throw new Error('Orca omitted result')
    return response.result
  }

  private async read(args: string[]): Promise<Json> { return this.result(await this.cli(args)) }

  private async mutation(id: string, args: string[], reconcile?: () => Promise<Json>): Promise<Json> {
    let operation = this.store.get<Operation>('orca-operation', id)
    // A local missing-runtime response never reached Orca; retry the same request after it returns.
    if (operation?.response?.ok === false && operation.response.id === 'local' && operation.response.error?.code === 'runtime_unavailable' && operation.response._meta?.runtimeId === null) {
      this.store.put('orca-rejected-operation', operation.requestId, operation)
      operation = { ...operation, attempted: false }
      delete operation.response
      this.store.put('orca-operation', id, operation)
    }
    if (!operation) {
      operation = { id, requestId: randomUUID(), args }
      this.store.put('orca-operation', id, operation)
    }
    if (!operation.response && operation.attempted) {
      const request = await this.read(['orchestration', 'request-show', '--request', operation.requestId])
      if (request.state === 'completed' && request.receipt) operation.response = { ok: true, result: request.receipt }
      else if (request.state === 'absent' && reconcile) operation.response = { ok: true, result: await reconcile() }
      else if (request.state !== 'pending') throw new Error(`Uncertain Orca operation ${id}; request ${operation.requestId} is ${request.state}; inspect before retrying`)
    }
    if (!operation.response) {
      operation.attempted = true
      this.store.put('orca-operation', id, operation)
      operation.response = await this.cli([...operation.args, '--retry-request', operation.requestId])
    }
    this.store.put('orca-operation', id, operation)
    return this.result(operation.response)
  }

  private save(binding: Binding): void { this.store.put('orca-assignment', binding.id, binding) }

  private async anchor(binding: Binding): Promise<void> {
    if (binding.anchor) {
      const response = await this.cli(['terminal', 'show', '--terminal', binding.anchor])
      if (response.ok) return
      if (!['terminal_not_found', 'terminal_handle_stale', 'not_found'].includes(response.error?.code)) this.result(response)
      delete binding.anchor
      binding.generation++
      this.save(binding)
    }
    const id = `anchor:${binding.id}:${binding.generation}`
    const title = `osa-${binding.id}-${binding.generation}`
    let operation = this.store.get<Operation>('orca-operation', id)
    if (!operation) {
      operation = { id, requestId: randomUUID(), args: ['terminal', 'create', '--worktree', `path:${this.repository(binding.ticketId)}`, '--title', title] }
      this.store.put('orca-operation', id, operation)
    }
    if (!operation.response && operation.attempted) {
      const listing = await this.read(['terminal', 'list', '--worktree', `path:${this.repository(binding.ticketId)}`])
      const matches = listing.terminals?.filter((item: Json) => item.title === title)
      if (matches?.length !== 1 || listing.truncated) throw new Error(`Uncertain anchor creation ${id}; inspect terminals before retrying`)
      operation.response = { ok: true, result: { terminal: matches[0] } }
    }
    if (!operation.response) {
      operation.attempted = true
      this.store.put('orca-operation', id, operation)
      operation.response = await this.cli(operation.args)
    }
    this.store.put('orca-operation', id, operation)
    binding.anchor = text(this.result(operation.response).terminal?.handle, 'anchor handle')
    // Save only after run-use; a crash replays the same operation and never forgets the binding.
    if (binding.runId) await this.mutation(`bind:${id}`, ['orchestration', 'run-use', '--id', binding.runId, '--from', binding.anchor])
    this.save(binding)
  }

  private command(ticket: Ticket, assignmentId: string): string {
    const token = this.store.get<{ token: string }>('capability', assignmentId)?.token
    return `--ticket ${quote(ticket.id)} --assignment ${quote(assignmentId)} --token ${quote(text(token, 'executor capability'))}`
  }

  private prompt(ticket: Ticket, assignmentId: string): string {
    const auth = this.command(ticket, assignmentId), osa = this.options.osaCommand
    const run = text(this.store.get<Binding>('orca-assignment', assignmentId)?.runId, 'report Run')
    const report = `${osa} --cli ${quote(this.options.cli)} --report-to ${quote(`run:${run}`)} --terminal '<your worker handle from the Orca preamble>'`
    const plan = this.store.get<TaskPlan>('task-plan', ticket.id)
    return `Target: ${ticket.title}\nOwner request (verbatim):\n${ticket.mandate.scope}\nTarget location: ${JSON.stringify(this.store.get<TicketTarget>('ticket-target', ticket.id) ?? { repository: this.repository(ticket.id) })}\nWorkspaces: ${JSON.stringify(new Projects(this.store).workspaces(ticket.id))}
You are the Executor, a peer of the Router. You own exploration, technical planning, implementation and debugging. Resolve technical friction within the owner's authorization and report afterwards. If a premise is false (wrong project, missing data, already implemented, or the request conflicts with the owner's intent), stop and explain the evidence and where the work belongs; do not force it or add mechanisms. Preserve refusals and disagreements explicitly in your domain report, with original wording and evidence for the owner.
${plan?.workspace === 'inspect' ? 'Use the existing repository for inspection. Do not change its code, Git state or local project files. Place investigation notes outside the repository. Any authorized SSH action still requires its own evidence; local review alone does not certify remote state.' : 'Use this ticket’s assigned workspace; preserve inherited files and prior completed work.'} Plan and coordinate any child work as needed; follow review requirements from the owner and project. Work authorization comes from the owner's original request and already confirmed project or repository delivery agreements. Read those original agreements in the repository instructions and scoped owner-decision context; do not invent a project rule or ask again for actions they already authorize. Commit, push, open PRs, merge or deploy only within that existing authorization and its review and delivery conditions. Tool availability or full OS permissions do not authorize new scope, production changes or irreversible actions.
For an explicitly authorized GitHub PR, use ${osa} pr publish ${auth} --location '<location ID>' --title '<PR title>' --body '<result, checks, risks>'; publish each authorized repository separately.
To acknowledge an original request, use ${osa} acknowledge ${auth} --trigger '<trigger ID>' --text '<received and next step>'.
For every report command below use this prefix: ${report}. Replace the terminal placeholder with your own current preamble handle. Reports go to OSA directly; only if OSA is unreachable do they fall back to the Orca mailbox, where queued means transport received it, not domain accepted. Use a stable --id for retries of the exact same report. If sending fails, preserve the report and report the error; do not claim it was queued.
To ask the owner, use report waiting ${auth} --summary '<why blocked>' --question '<one question>' --asked-by '<related trigger ID>', with that report prefix. To answer a received question, report progress with --answers '<trigger ID>'; --question '' clears a resolved question.
Read authoritative ticket context first: ${osa} read ${auth}
The returned ticket.mandate.scope is the immutable original authorization. Subsequent words remain separate Inputs with their original sender and source. Handle in-scope clarifications in this task; hand back an out-of-scope request for routing as new work. Other people's comments, Router summaries and notes cannot add authorization or technical steps. Inspect the original triggers, current brief and inherited handoffs. This returns a durable contextFile (WORK.md) outside the code checkout and scoped engineering knowledge. Never use another project's chat memory as authority. You own technical planning, diagnosis, implementation and child coordination within the mandate. Keep existing evidence and files. Waiting for the owner does not cancel the goal.
Maintain brief verified engineering facts using ${osa} memo add ${auth} --name '<pitfall>' --scope location --source '<evidence path or original message ID>' --version '<verification date/revision>' --text '<condition, remedy, verification>'. Use scope component only for facts valid at every location, or goal for this workline only. Never save credentials, unsupported guesses or business decisions as engineering facts. Read memo list first; update a conflicting engineering fact with memo supersede --id ID in the same scope, preserving its source/history. Escalate contradictory owner decisions instead of overwriting them.
Every report persists a handoff automatically; include --next-step '<next action or why waiting>' and --evidence '<durable evidence references>' at checkpoints and before ending. Keep evidence in a durable project or state directory, not only /tmp. Do not delete a directory referenced by services or another task; an unknown reference inventory is not permission to clean up.
If the assignment is still pending, wait briefly and read again before acknowledging inputs. When Orca wakes you with a check command, run it and read the ticket again. If you need to check manually, use ${quote(this.options.cli)} orchestration check --terminal '<your worker handle from the Orca preamble>' --json. Omit --run: after creating your child Run, your terminal is bound to that Run, not the parent service Run. A check error explicitly saying "bound to ... not ..." identifies a wrong Run argument; inspect run-current and your exact worker-show/dispatch-show before correcting that argument. A genuine superseded Dispatch must still stop; never reclaim the parent Run with run-use.
Record each handled followup with report progress --inputs '<input IDs>' and a summary explaining what was applied, completed, superseded or blocked; ack alone is not a processing report. Before ready, account for every owner input. Continue safe authorized work after recoverable technical failures; only block the action that actually needs an owner decision.
A progress report or acknowledgement is a checkpoint, not a reason to end the turn while authorized work remains. After starting independent child work, end your turn; Orca wakes you when a result or question arrives. Follow the current Orca orchestration guide and any receipt next action; do not poll or run wait loops. If work cannot continue, report the concrete missing premise or owner question, then settle the native attempt instead of silently leaving it dispatched.
For each input actually read, run: ${osa} ack ${auth} --inputs '<original input IDs, comma separated>'
When handling an Orca followup, preserve the original message ID from check and add --message '<original Orca message ID>' to that ack; only acknowledge its listed input IDs. If its receipt is not recorded yet, read again and retry the ack. Then acknowledge its Orca delivery via the same bound-Run check command with --ack. Deduplicate replays by message/input IDs.
Before worker_done, report the domain result: ${report} report ready ${auth} --summary '<result, checks, risks>'
Use blocked, failed, dropped, waiting, or progress instead of ready when appropriate. Completion of Orca alone is not a domain report. Finally send exactly one worker_done using the exact preamble command and matching outcome, then stop.`
  }

  private async workspace(ticket: Ticket, name: string): Promise<string> {
    const projects = new Projects(this.store), registered = projects.targets(ticket.id)
    const targets: ReturnType<Projects['targets']> = registered.length ? registered : [{ projectId: 'legacy', componentId: 'legacy', locationId: 'legacy', hostId: 'local', kind: 'git' as const, repository: this.options.repository }]
    let primary = ''
    for (const [index, target] of targets.entries()) {
      const suffix = index ? `:${target.locationId}` : ''
      const plan = this.store.get<TaskPlan>('task-plan', ticket.id)
      let directory = registered.length ? projects.directory(ticket.id, target.locationId) : ticket.execution?.directory || undefined
      if (directory) {
        if (!isAbsolute(directory)) throw new Error('Ticket execution.directory must be absolute')
        if (plan?.continueFrom && !projects.workspaces(ticket.id).some(item => item.locationId === target.locationId)) {
          const terminals = await this.read(['terminal', 'list', '--worktree', `path:${directory}`, '--limit', '1000'])
          if (!Array.isArray(terminals.terminals) || terminals.truncated || terminals.terminals.length) throw new Error('Continuation workspace still has terminals; inspect ownership before reuse')
        }
        if (registered.length) await this.verifyTargetWorkspace(ticket, target, directory)
      } else {
        const id = `worktree:${ticket.id}${suffix}`, marker = `osa ticket ${ticket.id}${suffix}`
        let operation = this.store.get<Operation>('orca-operation', id)
        if (!operation) {
          operation = { id, requestId: randomUUID(), args: ['worktree', 'create', '--repo', `path:${target.repository}`, '--name', name, '--comment', marker, '--no-parent', ...(target.baseBranch ? ['--base-branch', target.baseBranch] : [])] }
          this.store.put('orca-operation', id, operation)
        }
        if (!operation.response && operation.attempted) {
          const listing = await this.read(['worktree', 'list', '--repo', `path:${target.repository}`])
          const matches = listing.worktrees?.filter((item: Json) => item.comment === marker)
          if (listing.truncated || matches?.length !== 1) throw new Error('Uncertain worktree creation; inspect before retrying')
          operation.response = { ok: true, result: { worktree: matches[0] } }
        }
        if (!operation.response) {
          operation.attempted = true
          this.store.put('orca-operation', id, operation)
          operation.response = await this.cli(operation.args)
        }
        this.store.put('orca-operation', id, operation)
        directory = text(this.result(operation.response).worktree?.path, 'worktree directory')
        if (!isAbsolute(directory)) throw new Error('Orca returned a relative worktree directory')
        if (registered.length) await this.verifyTargetWorkspace(ticket, target, directory)
        const branch = (await execute('git', ['-C', directory, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim()
        const renameId = `branch:${ticket.id}${suffix}`
        let rename = this.store.get<{ branch: string; name: string; done?: boolean }>('orca-operation', renameId)
        if (!rename) { rename = { branch, name }; this.store.put('orca-operation', renameId, { id: renameId, ...rename }) }
        if (branch !== name) {
          if (branch !== rename.branch || rename.done) throw new Error('Worktree branch changed externally; refusing rename')
          await execute('git', ['-C', directory, 'branch', '-m', name])
        }
        const baseline = (await execute('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim()
        this.store.put('workspace-baseline', `${ticket.id}${suffix}`, { directory, revision: baseline })
        this.store.put('orca-operation', renameId, { id: renameId, ...rename, done: true })
      }
      const branch = (await execute('git', ['-C', directory, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim()
      const worktree = this.store.get<Operation>('orca-operation', `worktree:${projects.workspaceOwner(ticket.id)}${suffix}`)?.response?.result?.worktree
      this.store.atomic(() => {
        this.store.put('ticket-workspace', `${ticket.id}:${target.locationId}`, { ticketId: ticket.id, locationId: target.locationId, repository: target.repository, directory, name: branch, ...(worktree?.id ? { worktreeId: worktree.id } : {}) })
        if (!index) {
          const current = this.store.tickets.get(ticket.id)!
          current.execution = { name: plan?.continueFrom ? branch : name, directory: directory!, assignment: current.execution?.assignment ?? ticket.mandate.scope }
          this.store.tickets.save(current)
        }
      })
      if (!index) primary = directory
    }
    return primary
  }

  private async launch(job: Job, ticket: Ticket, engine: Engine): Promise<void> {
    let binding = this.store.get<Binding>('orca-assignment', job.assignmentId)
    const launch = this.store.get<Operation>('orca-operation', `launch:${job.assignmentId}`)
    if (binding?.settled || binding?.finished) { this.finish(job); return }
    // A completed recovery owns the binding; the cached initial receipt is obsolete.
    if (binding?.dispatchId && this.store.list<Recovery>('orca-recovery').some(item => item.assignmentId === job.assignmentId && item.done)) { this.finish(job); return }
    const launching = launch?.attempted && !(launch.response?.ok === false && launch.response.error?.code === 'task_not_startable')
    if ((!launching || binding?.dispatchId) && ticket.assignments.find(item => item.id === job.assignmentId)?.state === 'ended') { this.finish(job); return }
    if (!launching && !this.canStart(ticket, job.assignmentId)) return
    if (!binding) {
      const projectId = this.store.get<TicketTarget>('ticket-target', ticket.id)?.projectId ?? 'legacy'
      const turn = (this.store.get<{ turn: number }>('scheduler', 'clock')?.turn ?? 0) + 1
      this.store.put('scheduler', 'clock', { turn })
      this.store.put('scheduler-project', projectId, { turn })
      binding = { id: job.assignmentId, ticketId: ticket.id, generation: 0, poll: 0 }; this.save(binding) }
    await this.anchor(binding)
    if (!binding.runId) {
      const receipt = await this.mutation(`run:${binding.id}`, ['orchestration', 'run-create', '--objective', `osa ${ticket.id} ${binding.id}`, '--from', binding.anchor!])
      binding.runId = text(receipt.run?.id, 'run ID')
      this.save(binding)
    }
    const name = ticket.execution?.name || ticket.id
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) throw new Error('Ticket short name must be a safe single branch name')
    // A previously attempted launch keeps its original placement verbatim during recovery.
    if (launching) await this.verifyWorkspace(ticket)
    const directory = launching ? ticket.execution?.directory : await this.workspace(ticket, name)
    if (!launching) {
      const current = this.store.tickets.get(ticket.id)
      if (!current || current.ended || current.assignments.at(-1)?.id !== job.assignmentId || current.assignments.at(-1)?.state === 'ended') { this.finish(job); return }
      if (!this.canStart(current, job.assignmentId)) return
    }
    const receipt = await this.mutation(`launch:${binding.id}`, ['orchestration', 'worker-start', '--spec', this.prompt(ticket, binding.id), '--task-title', ticket.title,
      '--worktree', `path:${directory}`, '--agent', this.options.agent ?? 'codex', ...(this.options.model ? ['--model', this.options.model] : []), '--run', binding.runId, '--from', binding.anchor!], async () => {
      const listing = await this.read(['orchestration', 'worker-list', '--run', binding!.runId!])
      if (listing.page?.hasMore || listing.workers?.length !== 1) throw new Error('Uncertain launch: no unique worker in assignment Run; refusing duplicate launch')
      const worker = listing.workers[0]
      const shown = await this.read(['orchestration', 'worker-show', '--dispatch', text(worker.dispatchId, 'dispatch ID')])
      if (!['ready', 'succeeded', 'failed'].includes(shown.worker?.state) || !['input_accepted', 'turn_started'].includes(shown.worker?.stage)) throw new Error('Uncertain launch requires inspection')
      return { runId: binding!.runId, taskId: worker.taskId, dispatchId: worker.dispatchId, state: 'ready', effects: shown.worker.effects }
    })
    if (receipt.runId !== binding.runId) throw new Error('Launch receipt Run mismatch')
    binding.taskId = text(receipt.taskId, 'task ID')
    binding.dispatchId = text(receipt.dispatchId, 'dispatch ID')
    binding.terminal = receipt.effects?.find((effect: Json) => effect.kind === 'terminal' && effect.role === 'agent')?.id
    // Proven native identities must survive an unexpected state or later placement validation failure.
    this.save(binding)
    if (['failed', 'stopped'].includes(receipt.state)) {
      binding.terminal = receipt.effects?.find((effect: Json) => effect.kind === 'terminal' && effect.role === 'agent')?.id
      this.store.atomic(() => {
        this.save(binding!)
        const record = { id: binding!.id, ticketId: ticket.id, dispatchId: binding!.dispatchId, taskId: binding!.taskId, startedAt: Date.now(),
          provider: receipt.launch?.effective?.agent ?? null, model: receipt.launch?.effective?.model ?? null, outcome: 'failed', nativeState: receipt.state }
        this.store.put('execution', binding!.id, record)
        this.store.put('execution-attempt', binding!.dispatchId!, record)
        this.finish(job)
        this.notice(`supervision:${binding!.id}`, ticket.id, `Orca launch ${receipt.state}; inspect the original Dispatch before explicit retry.`)
      })
      return
    }
    if (receipt.state !== 'ready') throw new Error(`Orca launch ${receipt.state}: inspect saved receipt; do not relaunch`)
    binding.terminal = text(receipt.effects?.find((effect: Json) => effect.kind === 'terminal' && effect.role === 'agent')?.id, 'worker terminal')
    const worktreeId = text(receipt.effects?.find((effect: Json) => effect.kind === 'worktree')?.id, 'worktree ID')
    const worktreePath = worktreeId.slice(worktreeId.indexOf('::') + 2)
    if (!worktreeId.includes('::') || !isAbsolute(worktreePath)) throw new Error('Orca returned invalid worktree path')
    if (!directory || realpathSync(worktreePath) !== realpathSync(directory)) throw new Error('Orca launch changed the ticket workspace')
    this.store.atomic(() => {
      const current = this.store.tickets.get(ticket.id)!
      current.execution = { name: current.execution?.name ?? name, directory: worktreePath, assignment: current.execution?.assignment ?? ticket.mandate.scope }
      this.store.tickets.save(current)
      this.save(binding!)
      const record = { id: binding!.id, ticketId: ticket.id, dispatchId: binding!.dispatchId, taskId: binding!.taskId,
        startedAt: Date.now(), provider: receipt.launch?.effective?.agent ?? null, model: receipt.launch?.effective?.model ?? null, outcome: 'in_progress' }
      this.store.put('execution', binding!.id, record)
      this.store.put('execution-attempt', binding!.dispatchId!, record)
      engine.assignmentStarted(ticket.id, job.assignmentId)
      this.finish(job)
    })
  }

  private async sendInputs(job: Job, ticket: Ticket, engine: Engine): Promise<void> {
    const binding = this.store.get<Binding>('orca-assignment', job.assignmentId)
    if (ticket.ended || ticket.assignments.at(-1)?.id !== job.assignmentId) { this.finish(job); return }
    if (binding?.settled) {
      // Positive settlement and cleanup permit a new attempt; service restarts never do.
      if (!binding.finished) return
      this.store.atomic(() => {
        if (ticket.undelivered.some(id => job.inputIds?.includes(id))) {
          engine.deliveryFailed(ticket.id, job.assignmentId, 'Executor settled before this followup arrived')
          engine.retryTicket(ticket.id)
        }
        this.finish(job)
      })
      return
    }
    if (!binding?.dispatchId) return
    if (binding.finished) throw new Error('Executor retired without a worker report; inputs preserved for explicit route retry')
    const shown = await this.read(['orchestration', 'worker-show', '--dispatch', binding.dispatchId])
    if (shown.dispatch?.id !== binding.dispatchId || shown.dispatch?.taskId !== binding.taskId || shown.dispatch?.runId !== binding.runId) throw new Error('Followup Dispatch identity mismatch')
    if (['completed', 'failed', 'abandoned'].includes(shown.dispatch.status)) {
      await this.reconcileSettlement(binding, shown)
      return
    }
    await this.anchor(binding)
    const rejected = this.store.get<Operation>('orca-operation', job.id)
    if (rejected?.response?.ok === false && rejected.response.error?.code === 'recipient_run_mismatch' && rejected.args.includes('--run')) {
      // Orca rejected this before enqueue; preserve the receipt and retry the exact Dispatch without a stale Run constraint.
      this.store.put('orca-rejected-operation', rejected.requestId, rejected)
      this.store.delete('orca-operation', job.id)
    }
    const body = `Read these ticket input IDs: ${job.inputIds!.join(',')}.\n${this.options.osaCommand} read ${this.command(ticket, job.assignmentId)}\nAfter reading, ack those input IDs with --message set to this original Orca message ID, then ack the Orca delivery.`
    const receipt = await this.mutation(job.id, ['orchestration', 'send', '--to', `dispatch:${binding.dispatchId}`, '--from', binding.anchor!, '--type', 'status', '--subject', 'osa followup', '--body', body,
      '--payload', JSON.stringify({ ticketId: ticket.id, assignmentId: job.assignmentId, inputIds: job.inputIds })])
    const messageId = text(receipt.message?.id, 'followup message ID')
    this.store.atomic(() => {
      this.store.put('orca-delivery', messageId, { messageId, ticketId: ticket.id, assignmentId: job.assignmentId, inputIds: job.inputIds })
      engine.inputsDelivered(ticket.id, job.assignmentId, job.inputIds!)
      this.finish(job)
    })
  }

  private async cancel(job: Job): Promise<void> {
    const binding = this.store.get<Binding>('orca-assignment', job.assignmentId)
    if (!binding?.dispatchId) {
      const start = this.store.get<Job>('orca-job', `start:${job.assignmentId}`)
      const launch = this.store.get<Operation>('orca-operation', `launch:${job.assignmentId}`)
      if (start && !start.done && launch?.attempted && !(launch.response?.ok === false && launch.response.error?.code === 'task_not_startable')) return
      if (binding?.anchor) { binding.closing = true; this.save(binding); await this.closeAnchor(binding) }
      else if (binding) { binding.finished = true; this.save(binding) }
    } else if (!binding.settled) {
      const receipt = await this.mutation(job.id, ['orchestration', 'worker-stop', '--dispatch', binding.dispatchId])
      if (receipt.state !== 'stopped') throw new Error(`Orca stop ${receipt.state}; preserve unresolved assignment`)
      const record = { ...this.store.get<Json>('execution', binding.id), id: binding.id, ticketId: binding.ticketId,
        taskId: binding.taskId, dispatchId: binding.dispatchId, observedAt: Date.now(), outcome: 'stopped', nativeState: 'stopped', stopReceipt: receipt }
      this.store.put('execution', binding.id, record)
      this.store.put('execution-attempt', binding.dispatchId, record)
      // Explicit cancellation closes the worker through worker-stop, never worker-release.
      binding.closing = true
      this.save(binding)
    }
    this.finish(job)
  }

  private async poll(binding: Binding): Promise<void> {
    if ((binding.nextPollAt ?? 0) > Date.now()) return
    binding.nextPollAt = Date.now() + 1_000
    this.save(binding)
    if (binding.closing || (binding.finished && binding.released)) { await this.closeAnchor(binding); return }
    await this.anchor(binding)
    const batch = await this.mutation(`check:${binding.id}:${binding.poll}`, ['orchestration', 'check', '--run', binding.runId!, '--terminal', binding.anchor!])
    if (!Array.isArray(batch.messages)) throw new Error('Orca omitted inbox messages')
    for (const message of batch.messages) {
      const id = text(message.id, 'message ID')
      if (this.store.get('orca-message', id)) continue
      if (message.type === 'status' && message.subject === 'osa domain report') {
        if (!this.options.report) throw new Error('Domain report consumer is unavailable')
        // A refused report must not stay unread forever: that would block every later message, including worker_done.
        let request: Request | undefined
        try { request = JSON.parse(message.body) } catch { /* refused below */ }
        const foreign = !request || message.run_id !== binding.runId || message.from_handle !== binding.terminal || request.command?.[0] !== 'report'
          || request.options?.ticket !== binding.ticketId || request.options?.assignment !== binding.id
        let refusal = foreign ? 'Domain report does not match the current Executor' : ''
        if (!foreign) {
          try { await this.options.report(request!) }
          catch (error) {
            // ponytail: retry count stands in for telling transient from permanent failures; add typed refusals if 3 proves wrong.
            const failures = (this.store.get<number>('report-failure', id) ?? 0) + 1
            if (failures < 3) { this.store.put('report-failure', id, failures); throw error }
            refusal = String(error)
          }
        }
        this.store.atomic(() => {
          this.store.put('orca-message', id, { ...message, accepted: !refusal, ...(refusal ? { refusal } : {}), assignmentId: binding.id })
          if (refusal) this.notice(id, binding.ticketId, `Mailbox report refused: ${refusal}`)
        })
        continue
      }
      let payload: Json = {}
      try { payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload ?? {} } catch { /* Invalid completion stays a notice. */ }
      let valid = message.type === 'worker_done' && payload?.taskId === binding.taskId && payload?.dispatchId === binding.dispatchId
        && ['succeeded', 'failed'].includes(payload?.outcome) && message.from_handle === binding.terminal && message.run_id === binding.runId
      if (valid) {
        const state = await this.read(['orchestration', 'worker-show', '--dispatch', binding.dispatchId!])
        valid = state.dispatch?.id === binding.dispatchId && state.dispatch?.taskId === binding.taskId && state.dispatch?.runId === binding.runId
          && state.dispatch?.status === (payload.outcome === 'succeeded' ? 'completed' : 'failed')
      }
      this.store.atomic(() => {
        this.store.put('orca-message', id, { ...message, accepted: valid, assignmentId: binding.id })
        if (valid) {
          binding.settled = id
          delete binding.nextObservationAt
          this.save(binding)
          const ticket = this.store.tickets.get(binding.ticketId)
          if (!ticket?.assignments.find(item => item.id === binding.id)?.report) this.notice(id, binding.ticketId, 'Orca worker finished without an osa domain report; ticket is not ready.')
        } else if (message.type !== 'heartbeat') this.notice(id, binding.ticketId, `${message.subject ?? message.type}: ${message.body ?? ''}`)
      })
    }
    if (binding.settled && !binding.released) {
      await this.assertChildrenReleased(binding)
      const receipt = await this.mutation(`release:${binding.id}:${binding.dispatchId}`, ['orchestration', 'worker-release', '--dispatch', binding.dispatchId!])
      if (!['released', 'retained'].includes(receipt.state)) throw new Error(`Orca release ${receipt.state}; inspect recovery receipt before acknowledging`)
      binding.releaseState = receipt.state
      binding.released = true
      this.save(binding)
    }
    const next = batch.deliveryId ? await this.mutation(`ack:${binding.id}:${batch.deliveryId}`, ['orchestration', 'check', '--run', binding.runId!, '--terminal', binding.anchor!, '--ack', text(batch.deliveryId, 'delivery ID')]) : batch
    this.store.atomic(() => {
      this.store.delete('orca-operation', `check:${binding.id}:${binding.poll}`)
      if (batch.deliveryId) this.store.delete('orca-operation', `ack:${binding.id}:${batch.deliveryId}`)
      binding.poll++
      // Ack may deliver another FIFO batch; drain it before retiring the anchor.
      binding.closing = binding.released && Array.isArray(next.messages) && next.messages.length === 0
      this.save(binding)
      this.store.delete('notice', `poll:${binding.id}`)
    })
    if (binding.closing) await this.closeAnchor(binding)
  }

  private async closeAnchor(binding: Binding): Promise<void> {
    const id = `close:${binding.id}`
    if (!this.store.get('orca-operation', id)) this.store.put('orca-operation', id, { id, args: ['terminal', 'close', '--terminal', binding.anchor] })
    const shown = await this.cli(['terminal', 'show', '--terminal', binding.anchor!])
    if (shown.ok) {
      if (shown.result?.terminal?.agentIdentity) throw new Error('Coordinator anchor was taken over by an agent; preserving terminal')
      this.result(await this.cli(['terminal', 'close', '--terminal', binding.anchor!]))
    } else if (!['terminal_not_found', 'terminal_handle_stale', 'not_found'].includes(shown.error?.code)) this.result(shown)
    this.store.atomic(() => {
      binding.finished = true
      this.save(binding)
      this.store.put('orca-operation', id, { id, done: true })
      this.store.delete('notice', `poll:${binding.id}`)
      this.store.delete('notice', `supervision:${binding.id}`)
      if (this.store.tickets.get(binding.ticketId)?.ended) this.store.delete('notice', `queue:${binding.ticketId}`)
    })
  }
}
