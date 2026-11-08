import { createHash, randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { Engine, key, latestAssignment, type ActorRef, type Candidate, type Executor, type OutboundMessage, type Policy, type ReplyStatus, type Ticket, type Trigger } from '../vendor/dsh-core/src/index.ts'
import type { Store } from './store.ts'
import type { FeishuConfig } from './feishu.ts'
import { Projects, type TicketTarget } from './projects.ts'
import { Attachments } from './attachments.ts'

export interface Request { command: string[]; options: Record<string, string>; id: string }
type Mail = OutboundMessage & { status: ReplyStatus; triggerId?: string }
type Lease = { token: string; expires: number }
export type GitHubConfig = { repository: string; owner: { id: string; login: string } }
const required = (options: Record<string, string>, key: string) => {
  if (!options[key]?.trim()) throw new Error(`Missing --${key}`)
  return options[key]
}

export class App {
  readonly engine: Engine
  readonly attachments: Attachments
  private routing?: Record<string, string>
  constructor(readonly store: Store, executor: Executor, readonly owner = String(userInfo().uid), readonly github?: GitHubConfig, readonly feishu?: FeishuConfig,
    readonly projects = new Projects(store), readonly githubSources: GitHubConfig[] = github ? [github] : []) {
    this.attachments = new Attachments(store)
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
        send: message => { if (!store.get('outbox', message.id)) store.put('outbox', message.id, { ...message, createdAt: new Date().toISOString(), status: message.channel.source === 'panel' ? 'sent' : 'pending' }) },
        status: id => store.get<Mail>('outbox', id)?.status,
        withdraw: id => { const mail = store.get<Mail>('outbox', id); if (mail?.status === 'pending') store.put('outbox', id, { ...mail, status: 'dropped' }) },
      },
    })
  }

  private isOwner(actor: ActorRef, meta?: Record<string, unknown>): boolean {
    return ['router', 'panel'].includes(actor.source) ? actor.id === this.owner : actor.source === 'github' ? this.githubSources.some(source => actor.id === source.owner.id && (!meta || meta.repository === source.repository))
      : actor.source === 'feishu' && actor.id === this.feishu?.ownerId
  }

  private inScope(source: string, meta: Record<string, unknown>): boolean {
    const topic = source === 'panel' && typeof meta.topicTriggerId === 'string' ? this.store.triggers.get(meta.topicTriggerId) : undefined
    return source === 'router' || (source === 'panel' && ((typeof meta.projectId === 'string' && !!this.store.get('project', meta.projectId)) || (meta.projectId === undefined && topic?.source === 'router' && topic.human && this.isOwner(topic.actor)))) || (source === 'github' && this.githubSources.some(source => meta.repository === source.repository))
      || (source === 'feishu' && !!this.feishu && meta.chatId === this.feishu.chatId)
  }

  executorTicket(o: Record<string, string>): Ticket {
    const ticket = this.store.tickets.get(required(o, 'ticket')), assignment = required(o, 'assignment')
    if (!ticket || latestAssignment(ticket)?.id !== assignment || this.store.get<{ token: string }>('capability', assignment)?.token !== required(o, 'token')) throw new Error('Invalid executor capability')
    return ticket
  }

  handle(request: Request): unknown {
    if (!request || !Array.isArray(request.command) || !request.command.every(x => typeof x === 'string') || !request.options || typeof request.options !== 'object' || Array.isArray(request.options) ||
      Object.values(request.options).some(x => typeof x !== 'string') || typeof request.id !== 'string' || !request.id) throw new Error('Invalid request')
    try { return this.store.atomic(() => this.execute(request)) }
    catch (error) {
      if (request.command[0] === 'owner' && ['request', 'comment'].includes(request.command[1])) this.store.put('owner-rejection', request.options.id ?? request.id, { id: request.options.id ?? request.id, action: request.command[1], ...request.options, actor: { source: 'panel', id: this.owner }, error: String(error), at: new Date().toISOString() })
      throw error
    }
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
        return { processingProtocol: 'ticket.mandate.scope is the immutable original mandate; inputs and triggers preserve subsequent owner words and their sources. Interpret owner corrections without Router-authored plans. After ack, report --inputs with how each owner followup was handled. Read again before ready. Never bind the parent service Run as your child coordinator Run.', inputResolutions: ticket.inputs.map(input => store.get('input-resolution', input.id)).filter(Boolean), scopeRevisions: store.list<{ticketId: string}>('scope-revision').filter(r => r.ticketId === id), ticket, context: this.projects.context(id), contextFile: this.projects.brief(id), triggers: [...new Set([...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])].map(id => store.triggers.get(id)) }
      }
      if (command === 'memo') {
        if (action !== 'list' && (ticket.ended || latestAssignment(ticket)?.state !== 'running')) throw new Error('Memo writes require the current running assignment')
        return this.projects.memo(id, assignment, action, o)
      }
      if (command === 'acknowledge') return engine.reply({ purpose: 'acknowledgement', ticketId: id, triggerId: required(o, 'trigger'), text: required(o, 'text') })
      if (command === 'report') {
        if (!['ready', 'blocked', 'dropped', 'failed', 'progress', 'waiting'].includes(action)) throw new Error('Invalid report state')
        const summary = required(o, 'summary')
        if (ticket.ended && latestAssignment(ticket)?.report?.state === action && latestAssignment(ticket)?.report?.summary === summary) return ticket
        const read = store.get<{scope: string; inputs: string[]}>('executor-read', assignment)
        if (action === 'ready' && (!read || read.scope !== ticket.mandate.scope || JSON.stringify(read.inputs) !== JSON.stringify(ticket.inputs.map(i => i.id)))) throw new Error('Read the current ticket scope and inputs before reporting ready')
        const processed = o.inputs?.split(',') ?? []
        if (processed.some(inputId => !ticket.inputs.some(input => input.id === inputId && (input.kind !== 'trigger' || input.readAt)))) throw new Error('Report inputs must belong to the ticket and be read first')
        const unresolved = ticket.inputs.filter(input => input.kind === 'trigger' && input.human && !input.context && this.isOwner(store.triggers.get(input.triggerId)?.actor ?? {source: '', id: ''}) && !processed.includes(input.id) && !store.get('input-resolution', input.id))
        if (action === 'ready' && unresolved.length) throw new Error('Unprocessed owner inputs remain; read, ack and report --inputs with their disposition before ready')
        for (const inputId of processed) store.put('input-resolution', inputId, { inputId, ticketId: id, assignmentId: assignment, state: action, summary })
        const result = engine.report(id, { state: action as 'ready', summary, ...(o.question !== undefined ? { question: o.question.trim() || null } : {}), ...(o['asked-by'] ? { askedBy: o['asked-by'] } : {}), ...(o.answers ? { answers: o.answers } : {}) })
        if (result.attention && ticket.channels.some(channel => channel.source === 'panel')) engine.reply({purpose: 'attention', ticketId: id, question: result.attention.question, text: result.attention.question})
        if (o.answers && store.triggers.get(o.answers)?.source === 'panel') {
          const reply = engine.reply({purpose: 'answer', ticketId: id, triggerId: o.answers, text: summary}), mail = store.get<Mail>('outbox', reply.id)
          if (mail) store.put('outbox', reply.id, {...mail, triggerId: o.answers})
        }
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
    if (command === 'status' || (command === 'owner' && action === 'status')) {
      const overview = this.projects.overview(o) as { projects: {id: string}[] }
      const tickets = store.tickets.list().filter(ticket => (!o.project || overview.projects.some(project => project.id === store.get<TicketTarget>('ticket-target', ticket.id)?.projectId)) && (!o.search || `${ticket.title}\n${ticket.mandate.scope}\n${ticket.id}`.toLowerCase().includes(o.search.toLowerCase())))
      const ids = new Set(tickets.map(ticket => ticket.id))
      const projectIds = new Set(overview.projects.map(project => project.id))
      const triggers = store.list<Trigger>('core.trigger').filter(trigger => !o.project || projectIds.has(String(trigger.meta.projectId)) || tickets.some(ticket => ticket.origin.triggerIds.includes(trigger.id) || ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id)))
      const triggerIds = new Set(triggers.map(trigger => trigger.id))
      const publicationRecords = store.list<{ticketId?: string; repository?: string; locationId?: string; sha: string; title: string; body: string; pr?: number; url?: string}>('publication')
      const publications = publicationRecords.filter(publication => publication.ticketId && ids.has(publication.ticketId))
      const legacyShas = new Set(publicationRecords.filter(publication => !publication.ticketId).map(publication => publication.sha))
      for (const ticket of tickets) for (const sha of legacyShas) {
        const targets = this.projects.targets(ticket.id), authorization = store.get<GitHubConfig>('publish-authorization', ticket.id)
        const keys = [{id: `${ticket.id}:${sha}`, repository: targets[0]?.github?.repository ?? authorization?.repository},
          ...targets.flatMap(target => [
            {id: `${ticket.id}:${target.locationId}:${sha}`, repository: target.github?.repository, locationId: target.locationId},
            ...(target.github ? [{id: `${ticket.id}:${target.github.repository}:${sha}`, repository: target.github.repository, locationId: target.locationId}] : []),
          ])]
        for (const known of keys) {
          const publication = store.get<(typeof publicationRecords)[number]>('publication', known.id)
          if (publication && !publication.ticketId) publications.push({...publication, ticketId: ticket.id, repository: known.repository, ...('locationId' in known ? {locationId: known.locationId} : {})})
        }
      }
      return { tickets, projects: overview, publications,
        executionHolds: store.list<{ticketId:string}>('execution-hold').filter(hold => ids.has(hold.ticketId)),
        configuration: {executor: store.get('config', 'executor'), runtime: store.get('config', 'runtime'), githubSources: this.githubSources, feishu: this.feishu, repository: store.get('config', 'repository')},
        inputResolutions: store.list<{ticketId: string}>('input-resolution').filter(input => ids.has(input.ticketId)),
        triggerDispositions: triggers.map(trigger => ({triggerId: trigger.id, ...store.triggers.disposition(trigger.id)})),
        candidates: store.list<Candidate>('candidate').filter(candidate => candidate.triggers.some(trigger => triggerIds.has(trigger.id))), triggers,
        outbox: store.list<Mail>('outbox').filter(mail => !o.project || ids.has(mail.ticketId ?? '') || projectIds.has(mail.channel.address.projectId)),
        routingHistory: store.list<{ticketId?: string; triggerIds: string[]}>('core.decision').filter(decision => !o.project || ids.has(decision.ticketId ?? '') || decision.triggerIds.some(id => triggerIds.has(id))),
        routingAttachments: store.list<{ticketId:string}>('routing-attachment').filter(item=>ids.has(item.ticketId)),
        ownerActions: store.list<{ticketId?: string}>('owner-action').filter(action => !o.project || ids.has(action.ticketId ?? '')),
        rejectedSubmissions: store.list<{project?: string; ticket?: string}>('owner-rejection').filter(item => !o.project || projectIds.has(item.project ?? '') || ids.has(item.ticket ?? '')),
        routerHealth: { binding: store.get('router', 'terminal'), health: store.get('router', 'health'), attention: store.get('router', 'attention'), leaseExpires: store.get<Lease>('router', 'lease')?.expires },
        windowLinks: store.list<{ticketId: string}>('linked-window').filter(link => ids.has(link.ticketId)),
        reportReceipts: store.list<{ ticketId: string }>('report-receipt').filter(item => ids.has(item.ticketId)),
        taskProgress: tickets.map(ticket => {
          const assignment = latestAssignment(ticket), execution = assignment && store.get<{nativeState?: string}>('execution', assignment.id)
          return { ticketId: ticket.id, businessState: ticket.ended?.outcome ?? assignment?.report?.state ?? 'pending', report: assignment?.report,
            executionState: execution?.nativeState ?? 'unknown', handoff: store.get('handoff', ticket.id),
            pendingInputIds: ticket.inputs.filter(i => i.kind === 'trigger' && i.human && !i.context && !store.get('input-resolution', i.id)).map(i => i.id),
            queue: store.get('notice', `queue:${ticket.id}`) }
        }), notices: store.list<{ ticketId?: string; archivedAt?: string }>('notice').filter(item => !item.archivedAt && (!o.project || !item.ticketId || ids.has(item.ticketId))),
        historicalNotices: store.list<{archivedAt?:string}>('notice').filter(item => item.archivedAt),
        executionBindings: store.list<{ id: string; ticketId: string; finished?: boolean }>('orca-assignment').filter(item => ids.has(item.ticketId)).map(item => ({ ...item, holdsExecutorSlot: !item.finished && this.store.get<{capacityReleased?:boolean}>('execution-hold',item.id)?.capacityReleased !== true })),
        executions: store.list<{ ticketId: string }>('execution').filter(item => ids.has(item.ticketId)), attempts: store.list<{ ticketId: string }>('execution-attempt').filter(item => ids.has(item.ticketId)) }
    }
    if (command === 'owner') {
      if (action === 'attachment-write') return this.attachments.write(o)
      if (action === 'attachment-read') return this.attachments.read(o)
      if (action === 'reevaluate') {
        const triggerId = required(o, 'trigger'), trigger = store.triggers.get(triggerId)
        if (!trigger?.human || !this.isOwner(trigger.actor, trigger.meta) || !this.inScope(trigger.source, trigger.meta)) throw new Error('Only in-scope owner requests may be reevaluated')
        if (trigger.source === 'panel' && typeof trigger.meta.projectId === 'string') {
          const project = this.projects.handle(['project', 'show'], {id: String(trigger.meta.projectId)}) as {id: string; archived?: boolean; paused?: boolean}
          if (project.archived || project.paused || (o.project && (this.projects.handle(['project', 'show'], {id: o.project}) as {id: string}).id !== project.id)) throw new Error('Request project is unavailable or does not match')
        }
        const requeued = engine.reevaluate(triggerId)
        engine.evaluateDue()
        return {triggerId, requeued}
      }
      if (action === 'project-add') return this.projects.handle(['project', 'add'], { id: required(o, 'id'), name: required(o, 'name') })
      if (action === 'repository-add') {
        const id = required(o, 'id'), name = required(o, 'name'), project = required(o, 'project')
        this.projects.handle(['component', 'add'], { id: `repo-${id}`, name, project })
        return this.projects.handle(['location', 'add'], { ...o, id, name, component: `repo-${id}`, repository: required(o, 'repository') })
      }
      if (action === 'request' || action === 'comment') {
        const id = `panel:${required(o, 'id')}`, attachments = this.attachments.resolve(o.attachments), text = o.text ?? ''
        if (!text.trim() && !attachments.length) throw new Error('Input text or a ready attachment is required')
        if (action === 'comment' && (!!o.ticket === !!o.trigger)) throw new Error('Comments require exactly one --ticket or --trigger')
        const existing = store.triggers.get(id)
        const topic = action === 'comment' && o.trigger ? store.triggers.get(o.trigger) : undefined
        if (action === 'comment' && o.trigger && (!topic || !['panel', 'router'].includes(topic.source) || topic.meta.topicTriggerId || topic.meta.ticketId || !topic.human || !this.isOwner(topic.actor, topic.meta) || !this.inScope(topic.source, topic.meta))) throw new Error('Comments require an original in-scope owner panel or Router request')
        const topicIds = topic && new Set([topic.id, ...store.list<Trigger>('core.trigger').filter(input => input.meta.topicTriggerId === topic.id).map(input => input.id)])
        const matches = topicIds ? store.tickets.list().filter(ticket => ticket.origin.triggerIds.some(id => topicIds.has(id)) || ticket.inputs.some(input => input.kind === 'trigger' && topicIds.has(input.triggerId))) : []
        if (matches.length > 1) throw new Error('Request belongs to multiple tasks; select the task explicitly')
        if (existing && topic && existing.meta.topicTriggerId === topic.id) {
          const locations = o.locations?.split(',').map(id => id.trim()).filter(Boolean)
          if (existing.text !== text || JSON.stringify(existing.meta.attachments ?? []) !== JSON.stringify(attachments) || (o.project && (this.projects.handle(['project', 'show'], {id:o.project}) as {id:string}).id !== existing.meta.projectId) || (locations && JSON.stringify(locations) !== JSON.stringify(existing.meta.locationIds))) throw new Error('Input id already used with different content')
          return {id, result: engine.receive(existing)}
        }
        const ticket = action === 'comment' ? o.ticket ? store.tickets.get(o.ticket) : matches[0] : undefined
        if (action === 'comment' && ((o.ticket && !ticket) || ticket?.ended?.by === 'human')) throw new Error('Comments require an existing task that has not been stopped')
        const target = ticket && store.get<TicketTarget>('ticket-target', ticket.id)
        const projectId = target?.projectId ?? (typeof topic?.meta.projectId === 'string' ? topic.meta.projectId : action === 'request' ? required(o, 'project') : o.project)
        const project = projectId ? this.projects.handle(['project', 'show'], {id:projectId}) as {id: string; archived?: boolean; paused?: boolean} : undefined
        if (project?.archived || project?.paused) throw new Error('Project is paused or archived')
        if (o.project && project?.id !== (this.projects.handle(['project', 'show'], {id: o.project}) as {id: string}).id) throw new Error('Comment project does not match task or original request')
        const selected = o.locations?.split(',').map(id => id.trim()).filter(Boolean)
        const inherited = !ticket && Array.isArray(topic?.meta.locationIds) ? topic.meta.locationIds as string[] : undefined
        const locationIds = selected ?? inherited
        if (locationIds?.length) this.projects.resolve({...(project ? {project: project.id} : {}), locations: locationIds.join(',')})
        const thread = topic?.threads[0]?.id ?? (ticket ? `task:${ticket.id}` : `request:${id}`)
        const meta = { ...(project ? {projectId: project.id} : {}), ...(topic ? {topicTriggerId: topic.id, ...(typeof topic.meta.projectId === 'string' ? {entryProjectId: topic.meta.projectId} : {})} : ticket ? {ticketId: ticket.id} : {}), ...(locationIds ? {locationIds} : {}), ...(attachments.length ? {attachments} : {}) }
        const origin = ticket && store.triggers.get(ticket.origin.triggerId)
        const channel = topic?.channel ?? (origin && ['panel', 'router'].includes(origin.source) ? origin.channel : undefined) ?? { source: 'panel', thread, address: { ...(project ? {projectId: project.id} : {}), ...(!topic && ticket ? {ticketId: ticket.id} : {}) } }
        if (existing && (existing.text !== text || JSON.stringify(existing.meta) !== JSON.stringify(meta) || JSON.stringify(existing.channel) !== JSON.stringify(channel))) throw new Error('Input id already used with different content')
        const result = engine.receive({ id, source: 'panel', actor: {source: 'panel', id: this.owner}, human: true, addressed: 'direct', at: existing?.at ?? new Date().toISOString(), text, threads: [topic?.threads[0] ?? {source: 'panel', id: thread}], channel, meta })
        if (ticket && !existing && !store.triggers.disposition(id)?.fanout.includes(ticket.id)) engine.attach(ticket.id, id)
        engine.evaluateDue()
        store.delete('owner-rejection', o.id)
        return { id, result }
      }
      if (action === 'stop' || action === 'retry') {
        const ticketId = required(o, 'ticket'), ticket = store.tickets.get(ticketId)
        if (!ticket || (action === 'retry' && ticket.ended)) throw new Error('Action requires an open ticket')
        const result = action === 'stop' ? engine.stopTicket(ticketId, required(o, 'reason')) : {ticketId}
        store.put('owner-action', randomUUID(), {ticketId, action, reason: o.reason, actor: {source: 'panel', id: this.owner}, at: new Date().toISOString()})
        return result
      }
      throw new Error('Unknown owner action')
    }
    this.authorizeRouter(o)
    if (['project', 'component', 'location', 'knowledge', 'goal', 'task'].includes(command)) return this.projects.handle([command, action, ...args], o)
    if (command === 'router' && action === 'wait') {
      engine.evaluateDue()
      const candidates = store.list<Candidate>('candidate')
      for (const candidate of candidates) engine.candidateDelivered(candidate.evalId)
      const threads = new Set(candidates.map(candidate => candidate.thread.key))
      const topicInputs = store.list<Trigger>('core.trigger').filter(trigger => trigger.threads.some(thread => threads.has(`${thread.source}:${thread.id}`)))
      const topicTriggerIds = new Set(topicInputs.map(trigger => trigger.id))
      const topicReplies = store.list<Mail>('outbox').filter(message => message.triggerId ? topicTriggerIds.has(message.triggerId) : message.channel.source !== 'router' && threads.has(`${message.channel.source}:${message.channel.thread}`))
      return { candidates, topicInputs, topicReplies, messages: store.list<Mail>('outbox').filter(item => item.status === 'pending' && item.channel.source === 'router'), notices: store.routerNotices() }
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
    if (command === 'route') {
      if (action === 'attach') {
        const trigger = store.triggers.get(required(o, 'trigger'))
        if (!trigger || !this.isOwner(trigger.actor, trigger.meta) || !trigger.human || !this.inScope(trigger.source, trigger.meta)) throw new Error('Only owner inputs may be attached')
        const ticketId = required(o, 'ticket')
        const ticket = store.tickets.get(ticketId)
        if (!ticket) throw new Error('Unknown ticket')
        if (o.project || o.component || o.location || o.locations) this.projects.bind(ticket, o)
        const target = store.get<TicketTarget>('ticket-target', ticketId)
        const crossProject = trigger.source === 'panel' && typeof trigger.meta.projectId === 'string' && target && target.projectId !== trigger.meta.projectId
        if (crossProject) required(o, 'reason')
        if (trigger.source === 'github' && target && !this.projects.targets(ticketId).some(target => target.github?.repository === trigger.meta.repository)) throw new Error('GitHub input belongs to another component')
        const belongs = ticket.origin.triggerIds.includes(trigger.id) || ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id)
        if (belongs && !store.triggers.disposition(trigger.id)?.requeued) return ticket
        const attached = engine.attach(ticketId, trigger.id)
        if (o.reason) store.put('routing-attachment', key('attachment', ticketId, trigger.id), {ticketId, triggerId: trigger.id, reason:o.reason, at:new Date().toISOString()})
        return attached
      }
      if (action === 'stop') return engine.stopTicket(required(o, 'ticket'), o.reason)
      if (action === 'retry') {
        const ticket = store.tickets.get(required(o, 'ticket'))
        if (!ticket || ticket.ended) throw new Error('Retry requires an open ticket')
        return { ticketId: ticket.id }
      }
      let trigger = required(o, 'trigger')
      if (action === 'accept') {
        if (o.name && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.name)) throw new Error('Name must contain lowercase letters, digits and hyphens')
        const requestedTriggerId = trigger, requested = store.triggers.get(trigger)
        const original = typeof requested?.meta.topicTriggerId === 'string' ? store.triggers.get(requested.meta.topicTriggerId) : undefined
        if (original?.human && this.isOwner(original.actor, original.meta) && original.threads.some(thread => requested?.threads.some(ref => ref.source === thread.source && ref.id === thread.id))) {
          const disposition = store.triggers.disposition(original.id), decision = disposition?.decisionId && store.decisions.get(disposition.decisionId)
          const thread = store.threads.get(`${original.threads[0].source}:${original.threads[0].id}`)
          const requestedDisposition = store.triggers.disposition(requestedTriggerId)
          const replay = decision && decision.kind === 'accept' && decision.audit?.requestedTriggerId === requestedTriggerId && !requestedDisposition?.requeued && !requestedDisposition?.handbacks?.length
          if (replay || ((!decision || decision.kind === 'unavailable') && !disposition?.fanout.length && (engine.candidate(original.id) || thread?.pending.includes(original.id)))) trigger = original.id
        }
        // A replay keeps its original target even after registry defaults change.
        const existing = store.tickets.list().find(ticket => ticket.origin.triggerIds.includes(trigger))
        const source = store.triggers.get(trigger)
        const routing = { ...o, ...(source?.source === 'panel' && typeof source.meta.projectId === 'string' && !o.project ? { project: String(source.meta.projectId) } : {}), ...(source?.source === 'panel' && !o.locations && !o.location && (!o.project || o.project === source.meta.projectId) && Array.isArray(source.meta.locationIds) ? {locations:source.meta.locationIds.join(',')} : {}) }
        if (source?.source === 'panel' && typeof source.meta.projectId === 'string' && o.project && (this.projects.handle(['project', 'show'], {id:o.project}) as {id:string}).id !== source.meta.projectId) required(o, 'reason')
        if (existing && (o.project || o.component || o.location || o.locations)) this.projects.bind(existing, o)
        const target = existing ? store.get<TicketTarget>('ticket-target', existing.id)
          : store.list('project').length ? this.projects.resolve(routing, source?.source === 'github' ? String(source.meta.repository) : undefined) : undefined
        if (o.name && store.tickets.list().some(ticket => ticket.execution?.name === o.name && ticket.origin.triggerId !== trigger
          && store.get<{ repository: string }>('ticket-target', ticket.id)?.repository === target?.repository)) throw new Error('Ticket name already in use in this repository')
        const publishingTargets = target ? (target.repositories ?? [target]).flatMap(target => target.github ? [target.github] : []) : this.github ? [this.github] : []
        const publishing = publishingTargets[0]
        if (o.publish && (o['continue-from'] || (existing && store.get<{continueFrom?: string}>('task-plan', existing.id)?.continueFrom))) throw new Error('Publishing cannot continue another task workspace; use an isolated workspace')
        if (o.publish && (o.workspace === 'inspect' || (existing && store.get<{workspace?: string}>('task-plan', existing.id)?.workspace === 'inspect'))) throw new Error('Inspection tasks cannot publish')
        if (o.publish && (o.publish !== 'true' || !publishing || !publishingTargets.every(target => this.githubSources.some(config => config.repository === target.repository && config.owner.id === target.owner.id && config.owner.login === target.owner.login)))) throw new Error('Publishing requires --publish true and a configured GitHub repository')
        this.routing = routing
        try {
          const files = Array.isArray(source?.meta.attachments) ? source.meta.attachments : []
          if (!source || (!source.text.trim() && !files.length)) throw new Error('Owner request text or attachments are missing')
          const scope = source.text.trim() ? source.text : `[无文字的附件请求：${files.map(file => file.name).join('、')}]`
          const decision = engine.decide(trigger, { kind: 'accept', title: required(o, 'title'), scope, reason: o.reason ?? 'Owner request', ...(requestedTriggerId !== trigger ? {audit:{requestedTriggerId,topicTriggerId:trigger}} : {}), ...(o.name ? { name: o.name } : {}) })
          if (o.publish && decision.ticketId) store.put('publish-authorization', decision.ticketId, { ...publishing, ...(publishingTargets.length > 1 ? {repositories: publishingTargets} : {}) })
          if (decision.ticketId && !existing && ['panel', 'router'].includes(source.source) && !source.meta.topicTriggerId) {
            const pending = new Set(store.threads.get(`${source.threads[0].source}:${source.threads[0].id}`)?.pending ?? [])
            const related = store.list<Trigger>('core.trigger').filter(input => input.meta.topicTriggerId === source.id && pending.has(input.id) && !store.triggers.disposition(input.id)?.fanout.length)
            for (const input of related) {
              const ticket = store.tickets.get(decision.ticketId)!
              if (!ticket.origin.triggerIds.includes(input.id) && !ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === input.id)) engine.attach(decision.ticketId, input.id)
            }
          }
          return decision
        } finally { this.routing = undefined }
      }
      if (action === 'ignore') return engine.decide(trigger, { kind: 'ignore', reason: required(o, 'reason') })
    }
    if (command === 'reply') {
      if (o.trigger) {
        const trigger = store.triggers.get(o.trigger)
        if (!trigger?.human || !this.isOwner(trigger.actor, trigger.meta) || !this.inScope(trigger.source, trigger.meta)) throw new Error('Only owner questions may be answered')
        const reply = engine.reply({ purpose: 'answer', triggerId: trigger.id, text: required(o, 'text') }), mail = store.get<Mail>('outbox', reply.id)
        if (mail) store.put('outbox', reply.id, {...mail, triggerId: trigger.id})
        return reply
      }
      if (o.purpose && !['result', 'attention'].includes(o.purpose)) throw new Error('Invalid reply purpose')
      return engine.reply({ purpose: o.purpose === 'attention' ? 'attention' : 'result', ticketId: required(o, 'ticket'), ...(o.purpose === 'attention' ? { question: required(o, 'question') } : {}), text: required(o, 'text') })
    }
    throw new Error('Unknown command')
  }
}
