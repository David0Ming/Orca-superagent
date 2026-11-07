import { createHash, randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { Engine, key, latestAssignment, type ActorRef, type Candidate, type Executor, type OutboundMessage, type Policy, type ReplyStatus, type Ticket } from '../vendor/dsh-core/src/index.ts'
import type { Store } from './store.ts'
import type { FeishuConfig } from './feishu.ts'
import { Projects, type TicketTarget } from './projects.ts'

export interface Request { command: string[]; options: Record<string, string>; id: string }
type Mail = OutboundMessage & { status: ReplyStatus }
type Lease = { token: string; expires: number }
export type GitHubConfig = { repository: string; owner: { id: string; login: string } }
const required = (options: Record<string, string>, key: string) => {
  if (!options[key]?.trim()) throw new Error(`Missing --${key}`)
  return options[key]
}

export class App {
  readonly engine: Engine
  private routing?: Record<string, string>
  constructor(readonly store: Store, executor: Executor, readonly owner = String(userInfo().uid), readonly github?: GitHubConfig, readonly feishu?: FeishuConfig,
    readonly projects = new Projects(store), readonly githubSources: GitHubConfig[] = github ? [github] : []) {
    const policy: Policy = {
      version: 'owner-only-v1', paused: false, evalTimeoutMs: 300_000,
      gate: trigger => this.isOwner(trigger.actor, trigger.meta) && trigger.human && this.inScope(trigger.source, trigger.meta)
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', sender: trigger.actor.id, source: trigger.source } }
        : { admissible: false, reason: 'ownerOnly' },
      revalidate: mandate => this.isOwner(mandate.actor),
      admitsInferred: () => false,
    }
    this.engine = new Engine({ repo: store, policy: () => policy,
      scope: { scope: input => this.inScope(input.source, input.meta)
        ? { listened: true, observed: false } : { listened: false, reason: 'unsupportedSource' } },
      assessor: { request: candidate => store.put('candidate', candidate.evalId, candidate), release: id => store.delete('candidate', id) },
      executor,
      prepareTicket: (ticket, outcome) => {
        const trigger = store.triggers.get(ticket.origin.triggerId)
        this.projects.bind(ticket, this.routing ?? {}, trigger?.source === 'github' ? String(trigger.meta.repository) : undefined)
        return { ...ticket, execution: { name: outcome.name ?? ticket.id, directory: '', assignment: ticket.mandate.scope } }
      },
      outbox: {
        send: message => { if (!store.get('outbox', message.id)) store.put('outbox', message.id, { ...message, status: 'pending' }) },
        status: id => store.get<Mail>('outbox', id)?.status,
        withdraw: id => { const mail = store.get<Mail>('outbox', id); if (mail?.status === 'pending') store.put('outbox', id, { ...mail, status: 'dropped' }) },
      },
    })
  }

  private isOwner(actor: ActorRef, meta?: Record<string, unknown>): boolean {
    return actor.source === 'router' ? actor.id === this.owner : actor.source === 'github' ? this.githubSources.some(source => actor.id === source.owner.id && (!meta || meta.repository === source.repository))
      : actor.source === 'feishu' && actor.id === this.feishu?.ownerId
  }

  private inScope(source: string, meta: Record<string, unknown>): boolean {
    return source === 'router' || (source === 'github' && this.githubSources.some(source => meta.repository === source.repository))
      || (source === 'feishu' && !!this.feishu && meta.chatId === this.feishu.chatId)
  }

  executorTicket(o: Record<string, string>): Ticket {
    const ticket = this.store.tickets.get(required(o, 'ticket')), assignment = required(o, 'assignment')
    if (!ticket || latestAssignment(ticket)?.id !== assignment || this.store.get<{ token: string }>('capability', assignment)?.token !== required(o, 'token')) throw new Error('Invalid executor capability')
    return ticket
  }

  handle(request: Request): unknown {
    if (!request || !Array.isArray(request.command) || !request.command.every(x => typeof x === 'string') || !request.options ||
      Object.values(request.options).some(x => typeof x !== 'string') || typeof request.id !== 'string' || !request.id) throw new Error('Invalid request')
    return this.store.atomic(() => this.execute(request))
  }

  acceptReport(request: Request): unknown {
    if (request.command?.[0] !== 'report') throw new Error('Expected a domain report')
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    return this.store.atomic(() => {
      const prior = this.store.get<{ hash: string; result: unknown }>('report-receipt', request.id)
      if (prior) {
        if (prior.hash !== hash) throw new Error('Report ID reused with different content')
        return prior.result
      }
      const result = this.handle(request)
      this.store.put('report-receipt', request.id, { id: request.id, hash, ticketId: request.options.ticket, assignmentId: request.options.assignment, result })
      return result
    })
  }

  authorizeRouter(o: Record<string, string>): void {
    const lease = this.store.get<Lease>('router', 'lease')
    // Expiry permits takeover; the current token can resume until a successor actually replaces it.
    if (!lease || lease.token !== required(o, 'lease')) throw new Error('Router lease invalid or replaced; do not retry with another owner token')
    this.store.put('router', 'lease', { ...lease, expires: Date.now() + 60_000 })
  }

  private execute({ command: [command, action, ...args], options: o }: Request): unknown {
    const { store, engine } = this
    if (command === 'router' && action === 'attach') {
      const lease = store.get<Lease>('router', 'lease')
      if (lease && lease.expires > Date.now() && o.lease !== lease.token) throw new Error('Router lease is held; wait for expiry')
      const next = { token: lease && lease.token === o.lease ? lease.token : randomUUID(), expires: Date.now() + 60_000 }
      store.put('router', 'lease', next)
      return next
    }
    if (['read', 'ack', 'acknowledge', 'report', 'thread', 'handback', 'memo'].includes(command)) {
      const id = required(o, 'ticket'), assignment = required(o, 'assignment')
      const ticket = this.executorTicket(o)
      if (command === 'read') {
        store.put('executor-read', assignment, { scope: ticket.mandate.scope, inputs: ticket.inputs.map(i => i.id) })
        return { processingProtocol: 'ticket.mandate.scope preserves owner words in order; scopeRevisions and triggers retain their sources. Interpret owner corrections without Router-authored plans. After ack, report --inputs with how each owner followup was handled. Read again before ready. Never bind the parent service Run as your child coordinator Run.', inputResolutions: ticket.inputs.map(input => store.get('input-resolution', input.id)).filter(Boolean), scopeRevisions: store.list<{ticketId: string}>('scope-revision').filter(r => r.ticketId === id), ticket, context: this.projects.context(id), contextFile: this.projects.brief(id), triggers: [...new Set([...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])].map(id => store.triggers.get(id)) }
      }
      if (command === 'memo') {
        if (action !== 'list' && (ticket.ended || latestAssignment(ticket)?.state !== 'running')) throw new Error('Memo writes require the current running assignment')
        return this.projects.memo(id, assignment, action, o)
      }
      if (command === 'acknowledge') return engine.reply({ purpose: 'acknowledgement', ticketId: id, triggerId: required(o, 'trigger'), text: required(o, 'text') })
      if (command === 'report') {
        if (!['ready', 'blocked', 'dropped', 'failed', 'progress', 'waiting'].includes(action)) throw new Error('Invalid report state')
        if (action === 'ready' && store.get('config', 'two-layer') === true) {
          const review = store.get<{ verdict: string; blocked: boolean; assignmentId: string }>('review', assignment)
          if (!review || review.verdict !== 'approve' || review.blocked || review.assignmentId !== assignment) throw new Error('Independent review approval is required')
        }
        const summary = required(o, 'summary')
        if (ticket.ended && latestAssignment(ticket)?.report?.state === action && latestAssignment(ticket)?.report?.summary === summary) return ticket
        const read = store.get<{scope: string; inputs: string[]}>('executor-read', assignment)
        if (action === 'ready' && (!read || read.scope !== ticket.mandate.scope || JSON.stringify(read.inputs) !== JSON.stringify(ticket.inputs.map(i => i.id)))) throw new Error('Read the current ticket scope and inputs before reporting ready')
        const processed = o.inputs?.split(',') ?? []
        if (processed.some(inputId => !ticket.inputs.some(input => input.id === inputId && (input.kind !== 'trigger' || input.readAt)))) throw new Error('Report inputs must belong to the ticket and be read first')
        const unresolved = ticket.inputs.filter(input => input.kind === 'trigger' && input.human && !input.context && !processed.includes(input.id) && !store.get('input-resolution', input.id))
        if (action === 'ready' && unresolved.length) throw new Error('Unprocessed owner inputs remain; read, ack and report --inputs with their disposition before ready')
        for (const inputId of processed) store.put('input-resolution', inputId, { inputId, ticketId: id, assignmentId: assignment, state: action, summary })
        const result = engine.report(id, { state: action as 'ready', summary, ...(o.question !== undefined ? { question: o.question.trim() || null } : {}), ...(o['asked-by'] ? { askedBy: o['asked-by'] } : {}), ...(o.answers ? { answers: o.answers } : {}) })
        this.projects.recordHandoff(id, assignment, { ...o, reportState: action })
        if (o.answers) store.put('answer', key('answer', id, o.answers), { summary })
        if (action === 'ready' || action === 'dropped') engine.reply({ purpose: 'result', ticketId: id, text: summary })
        else if (action === 'blocked' || action === 'failed') store.put('notice', assignment + ':' + action, { id: assignment + ':' + action, ticketId: id, text: summary })
        return result
      }
      if (ticket.ended || latestAssignment(ticket)?.state !== 'running') throw new Error('Assignment is not running')
      if (command === 'ack') {
        const ids = required(o, 'inputs').split(',')
        if (ids.some(inputId => !ticket.inputs.some(input => input.id === inputId))) throw new Error('Input does not belong to ticket')
        if (o.message) {
          const delivery = store.get<{ ticketId: string; assignmentId: string; inputIds: string[] }>('orca-delivery', o.message)
          if (!delivery || delivery.ticketId !== id || delivery.assignmentId !== assignment || ids.some(inputId => !delivery.inputIds.includes(inputId))) throw new Error('Message does not match delivered inputs')
        }
        engine.inputsDelivered(id, assignment, ids)
        engine.inputsRead(id, ids)
        return { acknowledged: ids }
      }
      if (command === 'handback') return engine.handback(id, required(o, 'trigger'), required(o, 'reason'))
      if (action === 'unrelated') return engine.markUnrelated(id, required(o, 'thread'), required(o, 'reason'))
      if (action === 'follow') return engine.followForContext(id, { source: 'router', id: required(o, 'thread') })
      throw new Error('Unknown executor command')
    }
    this.authorizeRouter(o)
    if (['project', 'component', 'location', 'knowledge', 'goal', 'task'].includes(command)) return this.projects.handle([command, action, ...args], o)
    if (command === 'router' && action === 'wait') {
      engine.evaluateDue()
      return { candidates: store.list<Candidate>('candidate'), messages: store.list<Mail>('outbox').filter(item => item.status === 'pending' && item.channel.source === 'router'), notices: store.routerNotices() }
    }
    if (command === 'router' && action === 'ack') {
      const id = required(o, 'message'), mail = store.get<Mail>('outbox', id)
      if (mail?.status === 'pending' && mail.channel.source === 'router') store.put('outbox', id, { ...mail, status: 'sent' })
      store.delete('notice', id)
      store.put('router-notice-ack', id, { at: Date.now() })
      return { acknowledged: id }
    }
    if (command === 'intake') {
      const id = required(o, 'id'), text = o.text ?? [action, ...args].filter(Boolean).join(' ')
      if (!text.trim()) throw new Error('Input text is empty')
      const existing = store.triggers.get(id)
      const replyThread = o.thread ?? existing?.channel?.thread ?? `request:${id}`
      const thread = existing?.threads[0]?.id ?? `request:${id}`
      if (existing && (existing.text !== text || (existing.channel?.thread ?? thread) !== replyThread)) throw new Error('Input id already used with different content')
      const result = engine.receive({ id, source: 'router', actor: { source: 'router', id: this.owner }, human: true, addressed: 'direct',
        threads: [{ source: 'router', id: thread }], channel: { source: 'router', thread: replyThread, address: {} }, text, meta: {}, at: new Date().toISOString() })
      engine.evaluateDue()
      return { id, result }
    }
    if (command === 'status') {
      const overview = this.projects.overview(o) as { projects: {id: string}[] }
      const tickets = store.tickets.list().filter(ticket => !o.project || overview.projects.some(project => project.id === store.get<TicketTarget>('ticket-target', ticket.id)?.projectId))
      const ids = new Set(tickets.map(ticket => ticket.id))
      return { tickets, projects: overview,
        reportReceipts: store.list<{ ticketId: string }>('report-receipt').filter(item => ids.has(item.ticketId)),
        taskProgress: tickets.map(ticket => {
          const assignment = latestAssignment(ticket), execution = assignment && store.get<{nativeState?: string}>('execution', assignment.id)
          return { ticketId: ticket.id, businessState: ticket.ended?.outcome ?? assignment?.report?.state ?? 'pending', report: assignment?.report,
            executionState: execution?.nativeState ?? 'unknown', handoff: store.get('handoff', ticket.id),
            pendingInputIds: ticket.inputs.filter(i => i.kind === 'trigger' && i.human && !i.context && !store.get('input-resolution', i.id)).map(i => i.id),
            queue: store.get('notice', `queue:${ticket.id}`) }
        }), notices: store.list<{ ticketId?: string }>('notice').filter(item => !o.project || !item.ticketId || ids.has(item.ticketId)),
        executionBindings: store.list<{ id: string; ticketId: string; finished?: boolean }>('orca-assignment').filter(item => ids.has(item.ticketId)).map(item => ({ ...item, holdsExecutorSlot: !item.finished })),
        executions: store.list<{ ticketId: string }>('execution').filter(item => ids.has(item.ticketId)), attempts: store.list<{ ticketId: string }>('execution-attempt').filter(item => ids.has(item.ticketId)) }
    }
    if (command === 'route') {
      if (action === 'attach') {
        const trigger = store.triggers.get(required(o, 'trigger'))
        if (!trigger || !this.isOwner(trigger.actor, trigger.meta) || !trigger.human || !this.inScope(trigger.source, trigger.meta)) throw new Error('Only owner inputs may be attached')
        const ticketId = required(o, 'ticket')
        const ticket = store.tickets.get(ticketId)
        if (!ticket) throw new Error('Unknown ticket')
        if (o.project || o.component || o.location) this.projects.bind(ticket, o)
        const target = store.get<TicketTarget>('ticket-target', ticketId)
        if (trigger.source === 'github' && target && target.github?.repository !== trigger.meta.repository) throw new Error('GitHub input belongs to another component')
        const origins = store.tickets.list().filter(ticket => ticket.origin.triggerIds.includes(trigger.id) || ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id))
        if (origins.some(ticket => ticket.id !== ticketId)) throw new Error('Input already belongs to another ticket')
        if (!origins.length) {
          const scope = `${ticket.mandate.scope}\n\nOwner followup (${trigger.id}):\n${trigger.text}`
          const revisionId = key('scope-revision', ticketId, trigger.id)
          const previous = store.get<{scope: string}>('scope-revision', revisionId)
          if (!previous) {
            store.put('scope-revision', revisionId, { ticketId, triggerId: trigger.id, previousScope: ticket.mandate.scope, scope, at: new Date().toISOString() })
            ticket.mandate.scope = scope
            if (ticket.execution) ticket.execution.assignment = scope
            store.tickets.save(ticket)
          }
        }
        if (origins.length && !store.triggers.disposition(trigger.id)?.requeued) return ticket
        return engine.attach(ticketId, trigger.id)
      }
      if (action === 'stop') return engine.stopTicket(required(o, 'ticket'), o.reason)
      if (action === 'retry') {
        const ticket = store.tickets.get(required(o, 'ticket'))
        if (!ticket || ticket.ended) throw new Error('Retry requires an open ticket')
        return { ticketId: ticket.id }
      }
      const trigger = required(o, 'trigger')
      if (action === 'accept') {
        if (o.name && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.name)) throw new Error('Name must contain lowercase letters, digits and hyphens')
        // A replay keeps its original target even after registry defaults change.
        const existing = store.tickets.list().find(ticket => ticket.origin.triggerIds.includes(trigger))
        const source = store.triggers.get(trigger)
        if (existing && (o.project || o.component || o.location)) this.projects.bind(existing, o)
        const target = existing ? store.get<{ repository: string; github?: GitHubConfig }>('ticket-target', existing.id)
          : store.list('project').length ? this.projects.resolve(o, source?.source === 'github' ? String(source.meta.repository) : undefined) : undefined
        if (o.name && store.tickets.list().some(ticket => ticket.execution?.name === o.name && ticket.origin.triggerId !== trigger
          && store.get<{ repository: string }>('ticket-target', ticket.id)?.repository === target?.repository)) throw new Error('Ticket name already in use in this repository')
        const publishing = target?.github ?? (!target ? this.github : undefined)
        if (o.publish && (o.workspace === 'inspect' || (existing && store.get<{workspace?: string}>('task-plan', existing.id)?.workspace === 'inspect'))) throw new Error('Inspection tasks cannot publish')
        if (o.publish && (o.publish !== 'true' || !publishing || !this.githubSources.some(config => config.repository === publishing.repository && config.owner.id === publishing.owner.id))) throw new Error('Publishing requires --publish true and a configured GitHub repository')
        this.routing = o
        try {
          if (!source?.text?.trim()) throw new Error('Owner request text is missing')
          const decision = engine.decide(trigger, { kind: 'accept', title: required(o, 'title'), scope: source.text, reason: o.reason ?? 'Owner request', ...(o.name ? { name: o.name } : {}) })
          if (o.publish && decision.ticketId) store.put('publish-authorization', decision.ticketId, publishing)
          return decision
        } finally { this.routing = undefined }
      }
      if (action === 'ignore') return engine.decide(trigger, { kind: 'ignore', reason: required(o, 'reason') })
    }
    if (command === 'reply') {
      if (o.trigger) {
        const trigger = store.triggers.get(o.trigger)
        if (!trigger?.human || !this.isOwner(trigger.actor, trigger.meta) || !this.inScope(trigger.source, trigger.meta)) throw new Error('Only owner questions may be answered')
        return engine.reply({ purpose: 'answer', triggerId: trigger.id, text: required(o, 'text') })
      }
      if (o.purpose && !['result', 'attention'].includes(o.purpose)) throw new Error('Invalid reply purpose')
      return engine.reply({ purpose: o.purpose === 'attention' ? 'attention' : 'result', ticketId: required(o, 'ticket'), ...(o.purpose === 'attention' ? { question: required(o, 'question') } : {}), text: required(o, 'text') })
    }
    throw new Error('Unknown command')
  }
}
