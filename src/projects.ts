import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Ticket } from '../vendor/dsh-core/src/index.ts'
import type { GitHubConfig } from './app.ts'
import type { Store } from './store.ts'

export type RepositoryTarget = { projectId: string; componentId: string; locationId: string; hostId: string; repository: string; kind: 'git' | 'folder'; repoId?: string; baseBranch?: string; github?: GitHubConfig }
export type TicketTarget = RepositoryTarget & { ticketId: string; boundAt: string; repositories?: RepositoryTarget[] }
export type TicketWorkspace = { ticketId: string; locationId: string; repository: string; directory: string; name: string; worktreeId?: string }
export type TaskPlan = { ticketId: string; priority: number; dependsOn: string[]; goalId?: string; resources: string[]; createdAt: string; workspace?: 'isolated' | 'inspect'; continueFrom?: string }
type Row = { id: string; name: string; updatedAt: string; archived?: boolean; paused?: boolean; projectId?: string; componentId?: string; hostId?: string; repository?: string; kind?: 'git' | 'folder'; repoId?: string; baseBranch?: string; github?: GitHubConfig; projectIds?: string[]; acceptanceTicketId?: string; source?: string; version?: string; text?: string; supersededBy?: string; goalId?: string; locationId?: string; purpose?: string; closedAt?: string; category?: 'engineering' | 'decision'; ticketId?: string; assignmentId?: string }
type Options = Record<string, string>
const now = () => new Date().toISOString()
const required = (o: Options, key: string) => { if (!o[key]?.trim()) throw new Error(`Missing --${key}`); return o[key] }
const list = (value?: string) => [...new Set((value ?? '').split(',').map(x => x.trim()).filter(Boolean))]

export class Projects {
  constructor(private readonly store: Store) {}

  private rows(kind: string): Row[] { return this.store.list<Row>(kind) }
  private select(kind: string, selector: string | undefined, candidates = this.rows(kind), includeArchived = false): Row {
    const matches = candidates.filter(row => (includeArchived || !row.archived) && (!selector || row.id === selector || row.name === selector))
    if (matches.length !== 1) throw new Error(`Select an unambiguous --${kind}: ${matches.map(row => row.id).join(', ') || 'none'}`)
    return matches[0]
  }

  ensureLegacy(repository: string, github?: GitHubConfig): void {
    this.store.atomic(() => {
      const root = realpathSync(repository), previous = this.store.get<{ repository: string }>('config', 'legacy-target')
      const oldRoot = this.store.get<string>('config', 'repository')
      if (oldRoot && realpathSync(oldRoot) !== root) throw new Error('Legacy repository mismatch; migration requires explicit owner inspection')
      if (previous && previous.repository !== root) throw new Error('Legacy repository mismatch; migration requires explicit owner inspection')
      if (!previous) {
        if (['project', 'component', 'location'].some(kind => this.store.get(kind, 'legacy'))) throw new Error('Legacy ID collision; preserve existing registry records')
        this.store.put('config', 'legacy-target', { repository: root })
        this.store.put('project', 'legacy', { id: 'legacy', name: 'Legacy', updatedAt: now() })
        this.store.put('component', 'legacy', { id: 'legacy', name: 'Legacy', projectId: 'legacy', github, updatedAt: now() })
        this.store.put('location', 'legacy', { id: 'legacy', name: 'Legacy', componentId: 'legacy', hostId: 'local', repository: root, kind: 'git', updatedAt: now() })
      }
      const legacyComponent = this.store.get<Row>('component', 'legacy')
      if (github && legacyComponent && !legacyComponent.github) this.store.put('component', 'legacy', { ...legacyComponent, github, updatedAt: now() })
      for (const ticket of this.store.tickets.list()) {
        if (!previous && !this.store.get('ticket-target', ticket.id)) this.bind(ticket, { project: 'legacy', component: 'legacy', location: 'legacy' })
      }
    })
  }

  resolve(o: Options, sourceRepository?: string): Omit<TicketTarget, 'ticketId' | 'boundAt'> {
    if (o.locations) {
      if (o.location || o.component) throw new Error('Choose --locations or --location/--component')
      const locations = list(o.locations).map(id => this.select('location', id))
      if (!locations.length) throw new Error('Choose at least one repository location')
      const components = locations.map(location => this.select('component', location.componentId))
      const project = this.select('project', o.project ?? components[0].projectId)
      if (components.some(component => component.projectId !== project.id)) throw new Error('Selected repositories must belong to the chosen project')
      const repositories: RepositoryTarget[] = locations.map((location, i) => ({ projectId: project.id, componentId: components[i].id, locationId: location.id,
        hostId: location.hostId!, repository: location.repository!, kind: location.kind!,
        ...(location.repoId ? { repoId: location.repoId } : {}), ...(location.baseBranch ? { baseBranch: location.baseBranch } : {}), ...(components[i].github ? { github: components[i].github } : {}) }))
      if (new Set(repositories.map(target => `${target.hostId}:${target.repository}`)).size !== repositories.length) throw new Error('Select each repository only once')
      if (sourceRepository && !repositories.some(target => target.github?.repository === sourceRepository)) throw new Error('Source repository is outside the selected task targets')
      return { ...repositories[0], ...(repositories.length > 1 ? { repositories } : {}) }
    }
    let components = this.rows('component').filter(row => !row.archived)
    const selectedLocation = o.location ? this.select('location', o.location) : undefined
    if (selectedLocation) components = components.filter(row => row.id === selectedLocation.componentId)
    if (sourceRepository) components = components.filter(row => row.github?.repository === sourceRepository)
    if (o.component) components = components.filter(row => row.id === o.component || row.name === o.component)
    const project = this.select('project', o.project, this.rows('project').filter(row => !sourceRepository && !o.component && !o.location || components.some(c => c.projectId === row.id)))
    const component = this.select('component', o.component, components.filter(row => row.projectId === project.id))
    const location = this.select('location', o.location, this.rows('location').filter(row => row.componentId === component.id))
    return { projectId: project.id, componentId: component.id, locationId: location.id, hostId: location.hostId!, repository: location.repository!, kind: location.kind!,
      ...(location.repoId ? { repoId: location.repoId } : {}), ...(location.baseBranch ? { baseBranch: location.baseBranch } : {}), ...(component.github ? { github: component.github } : {}) }
  }

  bind(ticket: Ticket, o: Options, sourceRepository?: string): void {
    this.store.atomic(() => {
      const existing = this.store.get<TicketTarget>('ticket-target', ticket.id)
      if (existing) {
        if (['project', 'component', 'location', 'locations'].some(key => o[key])) {
          const target = this.resolve(o, sourceRepository)
          if (Object.entries(target).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(existing[key as keyof TicketTarget]))) throw new Error('Ticket target is immutable')
        } else if (sourceRepository && !this.targets(ticket.id).some(target => target.github?.repository === sourceRepository)) throw new Error('Ticket target is immutable')
        return
      }
      if (!this.rows('project').length) return
      const target = this.resolve(o, sourceRepository)
      this.store.put('ticket-target', ticket.id, { ...target, ticketId: ticket.id, boundAt: now() })
      this.plan(ticket.id, o, ticket)
    })
  }

  targets(ticketId: string): RepositoryTarget[] {
    const target = this.store.get<TicketTarget>('ticket-target', ticketId)
    if (!target) return []
    const { ticketId: _ticket, boundAt: _bound, repositories, ...primary } = target
    return repositories ?? [primary]
  }

  workspaces(ticketId: string): TicketWorkspace[] {
    const saved = this.store.list<TicketWorkspace>('ticket-workspace').filter(workspace => workspace.ticketId === ticketId)
    const ticket = this.store.tickets.get(ticketId), target = this.store.get<TicketTarget>('ticket-target', ticketId)
    if (ticket?.execution?.directory && target && !saved.some(workspace => workspace.locationId === target.locationId))
      saved.unshift({ ticketId, locationId: target.locationId, repository: target.repository, directory: ticket.execution.directory, name: ticket.execution.name })
    return saved
  }

  private plan(ticketId: string, o: Options, prepared?: Ticket, adoptGoal = false): TaskPlan {
    const ticket = prepared ?? this.store.tickets.get(ticketId)
    if (!ticket) throw new Error('Unknown ticket')
    const old = this.store.get<TaskPlan>('task-plan', ticketId)
    const plan: TaskPlan = { ticketId, priority: o.priority === undefined ? old?.priority ?? 0 : Number(o.priority),
      dependsOn: o['depends-on'] === undefined ? old?.dependsOn ?? [] : list(o['depends-on']),
      resources: o.resources === undefined ? old?.resources ?? [] : list(o.resources),
      goalId: o.goal === undefined ? old?.goalId : o.goal || undefined, workspace: (o.workspace ?? old?.workspace ?? 'isolated') as TaskPlan['workspace'], continueFrom: o['continue-from'] ?? old?.continueFrom, createdAt: old?.createdAt ?? now() }
    if (!['isolated', 'inspect'].includes(plan.workspace!)) throw new Error('Workspace must be isolated or inspect')
    if (plan.continueFrom && plan.workspace === 'inspect') throw new Error('Choose inspect or continue-from, not both')
    if (!Number.isSafeInteger(plan.priority)) throw new Error('Priority must be a safe integer')
    if ((this.store.get('orca-assignment', ticket.assignments.at(-1)?.id ?? '') || ticket.assignments.some(a => a.state === 'running')) &&
      (JSON.stringify(plan.dependsOn) !== JSON.stringify(old?.dependsOn ?? []) || JSON.stringify(plan.resources) !== JSON.stringify(old?.resources ?? []) || (plan.goalId !== old?.goalId && !(adoptGoal && !old?.goalId)) || plan.workspace !== (old?.workspace ?? 'isolated') || plan.continueFrom !== old?.continueFrom)) throw new Error('Execution dependencies, resources and goal are frozen')
    const target = this.store.get<TicketTarget>('ticket-target', ticketId)
    const goal = plan.goalId ? this.store.get<Row>('goal', plan.goalId) : undefined
    if (plan.goalId && (!goal || goal.archived || goal.closedAt || !target || !goal.projectIds?.includes(target.projectId))) throw new Error('Goal does not authorize this project or is closed')
    if (adoptGoal && (old?.goalId && old.goalId !== plan.goalId || goal?.acceptanceTicketId)) throw new Error('Adoption cannot move worklines or alter a joint acceptance goal')
    // Reuse only an explicit workline and exact target, never a similarly named task.
    if (!adoptGoal && !old && goal && target && !o.workspace && !o.publish && !plan.continueFrom && this.targets(ticketId).length === 1) {
      const peers = this.store.list<TaskPlan>('task-plan').filter(p => p.ticketId !== ticketId && p.goalId === goal.id && p.workspace !== 'inspect')
        .map(p => this.store.tickets.get(p.ticketId)!).filter(t => t && this.store.get<TicketTarget>('ticket-target', t.id)?.locationId === target.locationId)
      if (peers.some(t => !t.ended)) throw new Error('Workline already has open work at this location; attach the request or explicitly choose an isolated parallel task')
      const completed = peers.filter(t => t.execution?.directory && ['completed', 'merged'].includes(t.ended?.outcome ?? ''))
      if (new Set(completed.map(t => t.execution!.directory)).size > 1) throw new Error('Workline has multiple directories; explicitly choose continue-from or an isolated task')
      const previous = completed.sort((a, b) => b.ended!.at.localeCompare(a.ended!.at))[0]
      if (previous) plan.continueFrom = previous.id
    }
    if (plan.continueFrom) {
      const previous = this.store.tickets.get(plan.continueFrom), previousTarget = this.store.get<TicketTarget>('ticket-target', plan.continueFrom)
      if (plan.continueFrom === ticketId || !previous?.ended || !previous.execution?.directory || !target || !previousTarget
        || target.repository !== previousTarget.repository || target.componentId !== previousTarget.componentId || target.hostId !== previousTarget.hostId || target.locationId !== previousTarget.locationId)
        throw new Error('Continuation requires an ended ticket in the same component and repository')
      const identity = (id: string) => this.targets(id).map(t => [t.locationId, t.repository, t.hostId]).sort((a, b) => a[0].localeCompare(b[0]))
      if (JSON.stringify(identity(ticketId)) !== JSON.stringify(identity(plan.continueFrom))) throw new Error('Continuation must preserve all repository targets')
    }
    if (this.rows('goal').some(g => g.acceptanceTicketId === ticketId && g.id !== plan.goalId)) throw new Error('Acceptance task cannot leave its goal')
    for (const goalId of new Set([old?.goalId, plan.goalId])) {
      const acceptanceId = goalId && this.store.get<Row>('goal', goalId)?.acceptanceTicketId
      const acceptance = acceptanceId && this.store.tickets.get(acceptanceId)
      if (old?.goalId !== plan.goalId && acceptance && (acceptance.assignments.some(a => a.state === 'running') || this.store.get('orca-assignment', acceptance.assignments.at(-1)?.id ?? '')))
        throw new Error('Goal membership is frozen after joint acceptance starts')
    }
    const jointChildren = goal?.acceptanceTicketId === ticketId ? this.store.list<TaskPlan>('task-plan').filter(p => p.goalId === goal.id && p.ticketId !== ticketId).map(p => p.ticketId) : []
    for (const id of new Set([...plan.dependsOn, ...jointChildren])) {
      if (!this.store.tickets.get(id)) throw new Error('Unknown dependency ticket')
      const other = this.store.get<TicketTarget>('ticket-target', id)
      if (!target || !other || (target.projectId !== other.projectId && !goal?.projectIds?.includes(other.projectId))) throw new Error('Cross-project dependency requires an explicit shared goal')
      const seen = new Set<string>()
      const visit = (next: string): void => { if (next === ticketId || (next === goal?.acceptanceTicketId && ticketId !== next)) throw new Error('Dependency cycle'); if (seen.has(next)) return; seen.add(next); for (const dep of this.store.get<TaskPlan>('task-plan', next)?.dependsOn ?? []) visit(dep) }
      visit(id)
    }
    this.store.put('task-plan', ticketId, plan)
    return plan
  }

  blocked(ticketId: string): string | undefined {
    const target = this.store.get<TicketTarget>('ticket-target', ticketId)
    if (target) {
      for (const selected of this.targets(ticketId)) {
        const project = this.store.get<Row>('project', selected.projectId), component = this.store.get<Row>('component', selected.componentId), location = this.store.get<Row>('location', selected.locationId)
        if (!project || project.archived || project.paused || !component || component.archived || !location || location.archived) return 'Project or target paused/archived/unavailable'
        if (selected.hostId !== 'local' || selected.kind !== 'git') return 'Direct execution requires a local Git target'
      }
    } else if (this.rows('project').length) return 'Ticket has no explicit execution target'
    const plan = this.store.get<TaskPlan>('task-plan', ticketId)
    const goal = plan?.goalId && this.store.get<Row>('goal', plan.goalId)
    const children = goal && goal.acceptanceTicketId === ticketId ? this.store.list<TaskPlan>('task-plan').filter(p => p.goalId === goal.id && p.ticketId !== ticketId).map(p => p.ticketId) : []
    if (plan?.continueFrom) {
      const bindings = this.store.list<{ticketId: string; finished?: boolean; releaseState?: string}>('orca-assignment').filter(b => b.ticketId === plan.continueFrom)
      if (!bindings.length || bindings.some(b => !b.finished || b.releaseState === 'retained')) return 'Previous workspace resources remain unresolved or retained'
    }
    const directories = this.targets(ticketId).map(target => this.directory(ticketId, target.locationId)).filter(Boolean)
    if (this.store.list<{directory: string; state: string}>('workspace-cleanup').some(c => directories.includes(c.directory) && ['removing', 'unknown', 'removed'].includes(c.state))) return 'Workspace cleanup holds or removed this directory'
    for (const id of new Set([...(plan?.dependsOn ?? []), ...children])) {
      if (!this.successful(id)) return `Dependency ${id} lacks current successful settlement`
    }
    return undefined
  }

  private successful(ticketId: string): boolean {
    const ticket = this.store.tickets.get(ticketId), assignment = ticket?.assignments.at(-1)
    const execution = assignment && this.store.get<{ dispatchId?: string; outcome?: string }>('execution', assignment.id)
    const binding = assignment && this.store.get<{ dispatchId?: string; settled?: string }>('orca-assignment', assignment.id)
    return !!(ticket?.ended && ['completed', 'merged'].includes(ticket.ended.outcome) && assignment?.report?.state === 'ready' && binding?.settled && binding.dispatchId && execution?.dispatchId === binding.dispatchId && execution.outcome === 'succeeded')
  }

  private goalOverview(goal: Row): unknown {
    const children = this.store.list<TaskPlan>('task-plan').filter(plan => plan.goalId === goal.id && plan.ticketId !== goal.acceptanceTicketId)
      .map(plan => ({ ticketId: plan.ticketId, target: this.store.get('ticket-target', plan.ticketId), directory: this.directory(plan.ticketId), handoff: this.store.get('handoff', plan.ticketId), ticket: this.store.tickets.get(plan.ticketId), successful: this.successful(plan.ticketId) }))
    const acceptance = goal.acceptanceTicketId ? { ticketId: goal.acceptanceTicketId, ticket: this.store.tickets.get(goal.acceptanceTicketId), successful: this.successful(goal.acceptanceTicketId) } : undefined
    return { ...goal, children, acceptance, status: goal.closedAt ? 'closed' : acceptance?.successful && children.every(child => child.successful) ? 'accepted' : 'pending', observedAt: now() }
  }

  workspaceOwner(ticketId: string): string {
    const seen = new Set<string>()
    while (this.store.get<TaskPlan>('task-plan', ticketId)?.continueFrom) {
      if (seen.has(ticketId)) throw new Error('Workspace continuation cycle')
      seen.add(ticketId)
      ticketId = this.store.get<TaskPlan>('task-plan', ticketId)!.continueFrom!
    }
    return ticketId
  }

  directory(ticketId: string, locationId?: string): string | undefined {
    const ticket = this.store.tickets.get(ticketId), plan = this.store.get<TaskPlan>('task-plan', ticketId)
    const targets = this.targets(ticketId), selected = locationId ? targets.find(target => target.locationId === locationId) : targets[0]
    return this.workspaces(ticketId).find(workspace => workspace.locationId === selected?.locationId)?.directory
      || (!locationId || locationId === targets[0]?.locationId ? ticket?.execution?.directory : undefined)
      || (plan?.workspace === 'inspect' ? selected?.repository
        : plan?.continueFrom ? this.workspaces(plan.continueFrom).find(workspace => workspace.locationId === selected?.locationId)?.directory : undefined)
  }

  context(ticketId: string): unknown {
    const target = this.store.get<TicketTarget>('ticket-target', ticketId), plan = this.store.get<TaskPlan>('task-plan', ticketId)
    const targets = this.targets(ticketId)
    return { target, targets, workspaces: this.workspaces(ticketId), plan, dependencies: [...new Set([...(plan?.dependsOn ?? []), ...(plan?.continueFrom ? [plan.continueFrom] : [])])].map(id => {
      const ticket = this.store.tickets.get(id), assignment = ticket?.assignments.at(-1)
      return { ticketId: id, target: this.store.get('ticket-target', id), directory: ticket?.execution?.directory, workspaces: this.workspaces(id), report: assignment?.report, handoff: this.store.get('handoff', id),
        execution: assignment && this.store.get('execution', assignment.id), review: assignment && this.store.get('review', assignment.id), successful: this.successful(id) }
    }), goal: plan?.goalId && this.store.get<Row>('goal', plan.goalId) ? this.goalOverview(this.store.get<Row>('goal', plan.goalId)!) : undefined,
      knowledge: this.rows('knowledge').filter(row => !row.archived && !row.supersededBy && (row.projectIds?.includes('*') || (!!target && row.projectIds?.includes(target.projectId))) && (!row.componentId || targets.some(target => row.componentId === target.componentId))
        && (!row.locationId || targets.some(target => row.locationId === target.locationId)) && (!row.goalId || row.goalId === plan?.goalId)),
      handoff: this.store.get('handoff', ticketId), observedAt: now() }
  }

  recordHandoff(ticketId: string, assignmentId: string, o: Options): void {
    const old = this.store.get<{ nextStep?: string; evidence?: string }>('handoff', ticketId)
    this.store.put('handoff', ticketId, { ticketId, assignmentId, summary: o.summary, state: o.reportState,
      question: this.store.tickets.get(ticketId)?.attention?.question,
      nextStep: o['next-step'] ?? old?.nextStep, evidence: o.evidence ?? old?.evidence, updatedAt: now() })
  }

  brief(ticketId: string): string | undefined {
    if (this.store.path === ':memory:') return undefined
    const target = this.store.get<TicketTarget>('ticket-target', ticketId), plan = this.store.get<TaskPlan>('task-plan', ticketId)
    const context = this.context(ticketId) as {knowledge: Row[]}
    const goal = plan?.goalId && this.store.get<Row>('goal', plan.goalId)
    const tasks = goal ? this.store.list<TaskPlan>('task-plan').filter(p => p.goalId === goal.id && this.store.get<TicketTarget>('ticket-target', p.ticketId)?.locationId === target?.locationId).map(p => p.ticketId) : [ticketId]
    const id = createHash('sha256').update(JSON.stringify([plan?.goalId ?? ticketId, target?.locationId])).digest('hex')
    const directory = join(dirname(resolve(this.store.path)), 'worklines', id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, 'WORK.md'), temporary = join(directory, randomUUID() + '.tmp')
    const body = { goal: goal || undefined, target, targets: this.targets(ticketId), workspaces: this.workspaces(ticketId), knowledge: context.knowledge,
      tasks: tasks.map(id => { const t = this.store.tickets.get(id)!; return { id, title: t.title, scope: t.mandate.scope, directory: this.directory(id), ended: t.ended,
        workspaces: this.workspaces(id), report: t.assignments.at(-1)?.report, handoff: this.store.get('handoff', id) } }), observedAt: now() }
    writeFileSync(temporary, '# Engineering brief\n\nGenerated from OSA records. Do not edit this projection; use memo/report commands. Recheck live environment and credentials before acting.\n\n```json\n' + JSON.stringify(body, null, 2) + '\n```\n', { mode: 0o600 })
    renameSync(temporary, file)
    return file
  }

  memo(ticketId: string, assignmentId: string, action: string, o: Options): unknown {
    const targets = this.targets(ticketId), target = o.location ? targets.find(target => target.locationId === o.location) : targets[0], plan = this.store.get<TaskPlan>('task-plan', ticketId)
    if (!target) throw new Error('Memo requires a bound execution target')
    if (action === 'list') return (this.context(ticketId) as {knowledge: Row[]}).knowledge
    if (!['add', 'supersede'].includes(action)) throw new Error('Use memo list|add|supersede')
    const scope = o.scope ?? 'location'
    if (!['component', 'location', 'goal'].includes(scope)) throw new Error('Memo scope must be component, location or goal')
    if (scope === 'goal' && !plan?.goalId) throw new Error('Memo requires a bound goal')
    if (required(o, 'text').length > 4000 || required(o, 'source').length > 2000) throw new Error('Keep the memo brief and reference evidence instead')
    const previous = action === 'supersede' ? this.store.get<Row>('knowledge', required(o, 'id')) : undefined
    if (action === 'supersede' && (!previous || previous.category !== 'engineering' || previous.projectIds?.length !== 1 || previous.projectIds[0] !== target.projectId
      || previous.componentId !== target.componentId || previous.locationId !== (scope === 'component' ? undefined : target.locationId) || previous.goalId !== (scope === 'goal' ? plan?.goalId : undefined)))
      throw new Error('Executor may only supersede engineering facts in its exact scope; owner decisions are protected')
    const name = o.name ?? previous?.name ?? required(o, 'name')
    if (previous && name !== previous.name) throw new Error('Supersede preserves the engineering fact name')
    const id = createHash('sha256').update(JSON.stringify([target.projectId,target.componentId,scope,scope === 'component' ? null : target.locationId,scope === 'goal' ? plan?.goalId : null,name,o.source,o.version,o.text])).digest('hex')
    const replay = action === 'add' ? this.store.get<Row>('knowledge',id) : previous?.supersededBy ? this.store.get<Row>('knowledge',previous.supersededBy) : undefined
    if (replay && replay.name === name && replay.text === o.text && replay.source === o.source && replay.version === o.version) return replay
    if (action === 'add' && (this.context(ticketId) as {knowledge: Row[]}).knowledge.some(k => k.name === name)) throw new Error('Memo name already exists in this context; reconcile the fact and use supersede for engineering knowledge')
    const row = this.handle(['knowledge', action], { id: action === 'supersede' ? previous!.id : id, name,
      project: target.projectId, component: target.componentId, source: required(o, 'source'), version: required(o, 'version'), text: o.text }) as Row
    const result: Row = { ...row, category: 'engineering', ticketId, assignmentId,
      locationId: scope === 'component' ? undefined : target.locationId, goalId: scope === 'goal' ? plan?.goalId : undefined }
    this.store.put('knowledge', row.id, result)
    return result
  }

  overview(o: Options = {}): unknown {
    const projectId = o.project ? this.select('project', o.project, this.rows('project'), true).id : undefined
    return { goals: this.rows('goal').filter(g => !projectId || g.projectIds?.includes(projectId)).map(g => this.goalOverview(g)), projects: this.rows('project').filter(p => !projectId || p.id === projectId), components: this.rows('component').filter(c => !projectId || c.projectId === projectId), locations: this.rows('location').filter(l => !projectId || this.store.get<Row>('component', l.componentId!)?.projectId === projectId),
      tasks: this.store.tickets.list().filter(t => !projectId || this.store.get<TicketTarget>('ticket-target', t.id)?.projectId === projectId).map(ticket => ({ ticket, context: this.context(ticket.id), blocked: this.blocked(ticket.id), execution: this.store.get('execution', ticket.assignments.at(-1)?.id ?? ''), review: this.store.get('review', ticket.assignments.at(-1)?.id ?? '') })), observedAt: now() }
  }

  importOrca(repos: unknown[], projects: unknown[] = [], workspaces: unknown = {}): unknown {
    const snapshot = { repos, projects, workspaces, observedAt: now(), authorizesExecution: false }
    this.store.put('discovery', 'orca', snapshot)
    return snapshot
  }

  handle([kind, action = 'list']: string[], o: Options): unknown {
    return this.store.atomic(() => {
      if (kind === 'project' && action === 'discovery') return this.store.get('discovery', 'orca') ?? null
      if (kind === 'overview') return this.overview(o)
      if (kind === 'task') {
        const id = required(o, 'ticket')
        if (!this.store.tickets.get(id)) throw new Error('Unknown ticket')
        if (action === 'show') return this.context(id)
        if (action !== 'plan') throw new Error('Unknown task action')
        return this.plan(id, o)
      }
      if (!['project', 'component', 'location', 'knowledge', 'goal'].includes(kind)) throw new Error('Unknown project command')
      if (action === 'list') return this.rows(kind).filter(row => (!o.project || row.projectId === o.project || row.projectIds?.includes(o.project) || (kind === 'knowledge' && row.projectIds?.includes('*')) || row.id === o.project) && (!o.component || row.componentId === o.component))
      if (action === 'show') {
        const row = this.select(kind, required(o, 'id'), this.rows(kind), true)
        return kind === 'goal' ? this.goalOverview(row) : row
      }
      const old = action === 'add' ? undefined : this.select(kind, required(o, 'id'))
      if (kind === 'goal' && action === 'adopt') return this.plan(required(o, 'ticket'), {goal: old!.id}, undefined, true)
      if (kind === 'goal' && ['close', 'reopen', 'archive'].includes(action)) {
        const tasks = this.store.list<TaskPlan>('task-plan').filter(p => p.goalId === old!.id)
        if (action !== 'reopen' && tasks.some(p => !this.store.tickets.get(p.ticketId)?.ended)) throw new Error('Goal has open work; waiting is not cancellation')
        if (action !== 'archive') {
          const row = { ...old!, closedAt: action === 'close' ? now() : undefined, updatedAt: now() }
          this.store.put(kind, row.id, row); return this.goalOverview(row)
        }
      }
      if (['archive', 'pause', 'resume'].includes(action)) {
        if (action !== 'archive' && kind !== 'project') throw new Error('Only projects can pause/resume')
        const row = { ...old!, updatedAt: now(), ...(action === 'archive' ? { archived: true } : { paused: action === 'pause' }) }
        this.store.put(kind, row.id, row); return row
      }
      if (!['add', 'update', 'supersede'].includes(action) || (action === 'supersede' && kind !== 'knowledge')) throw new Error('Unknown registry action')
      if (kind === 'knowledge' && action === 'update') throw new Error('Knowledge is versioned; use supersede')
      const id = action === 'supersede' ? randomUUID() : old?.id ?? o.id ?? randomUUID()
      if (!old && this.store.get(kind, id)) throw new Error('ID already exists')
      const row: Row = { ...old, id, name: o.name ?? old?.name ?? required(o, 'name'), updatedAt: now() }
      if (kind === 'goal') row.purpose = o.purpose ?? old?.purpose
      if (kind === 'component') {
        row.projectId = this.select('project', o.project ?? old?.projectId).id
        if (old && old.projectId !== row.projectId && this.store.list<TicketTarget>('ticket-target').some(t => t.componentId === id)) throw new Error('Bound component cannot move projects')
        if (o['github-repository']) row.github = { repository: required(o, 'github-repository'), owner: { id: required(o, 'github-owner-id'), login: required(o, 'github-owner-login') } }
      }
      if (kind === 'location') {
        row.componentId = this.select('component', o.component ?? old?.componentId).id
        if (old && old.componentId !== row.componentId && this.store.list<TicketTarget>('ticket-target').some(t => t.locationId === id)) throw new Error('Bound location cannot move components')
        row.hostId = o.host ?? old?.hostId ?? 'local'
        const root = o.repository ?? old?.repository ?? required(o, 'repository')
        if (!isAbsolute(root)) throw new Error('Repository must be absolute')
        const targetKind = o.kind ?? old?.kind ?? 'git'
        if (!['git', 'folder'].includes(targetKind)) throw new Error('Invalid location kind')
        row.kind = targetKind as 'git' | 'folder'
        row.repository = row.hostId === 'local' ? realpathSync(root) : root
        if (row.hostId === 'local' && row.kind === 'git' && realpathSync(execFileSync('git', ['-C', row.repository, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()) !== row.repository) throw new Error('Location must be the Git root')
        row.repoId = o['repo-id'] ?? old?.repoId; row.baseBranch = o['base-branch'] ?? old?.baseBranch
      }
      if (kind === 'goal' || kind === 'knowledge') {
        row.projectIds = o.projects ? list(o.projects) : o.project ? [o.project] : old?.projectIds
        if (!row.projectIds?.length) throw new Error('Explicit project scope required')
        row.projectIds = row.projectIds.map(p => p === '*' && kind === 'knowledge' ? p : this.select('project', p).id)
        if (kind === 'goal' && this.store.list<TaskPlan>('task-plan').some(plan => plan.goalId === id && !row.projectIds!.includes(this.store.get<TicketTarget>('ticket-target', plan.ticketId)?.projectId ?? ''))) throw new Error('Goal scope excludes an existing task')
      }
      if (kind === 'knowledge') {
        row.source = required(o, 'source'); row.version = required(o, 'version'); row.text = required(o, 'text')
        row.componentId = o.component ? this.select('component', o.component).id : old?.componentId
        if (row.componentId && !row.projectIds!.includes(this.store.get<Row>('component', row.componentId)!.projectId!)) throw new Error('Knowledge component outside scope')
        if (old?.supersededBy) throw new Error('Knowledge already superseded')
        if (action === 'supersede') this.store.put('knowledge', old!.id, { ...old, supersededBy: id })
      }
      if (kind === 'goal' && o['acceptance-ticket']) {
        const ticketId = o['acceptance-ticket'], target = this.store.get<TicketTarget>('ticket-target', ticketId)
        if (!this.store.tickets.get(ticketId) || !target || !row.projectIds!.includes(target.projectId)) throw new Error('Acceptance ticket must exist in the goal scope')
        if (old?.acceptanceTicketId && old.acceptanceTicketId !== ticketId) throw new Error('Goal acceptance ticket is already bound')
        row.acceptanceTicketId = ticketId
      }
      this.store.put(kind, id, row)
      if (kind === 'goal' && row.acceptanceTicketId) this.plan(row.acceptanceTicketId, { goal: id })
      return kind === 'goal' ? this.goalOverview(row) : row
    })
  }
}
