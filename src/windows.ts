import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Projects, type TicketTarget } from './projects.ts'
import { sessionRpc } from './orca-session.ts'
import type { Store } from './store.ts'

const execute = promisify(execFile)
type Options = { project?: string; ticket?: string; session?: string; terminal?: string }
type Window = { sessionId?: string; terminal?: string; worktreeId?: string; title?: string; workspace: string; state?: unknown }
type Link = { ticketId: string; sessionId?: string; terminal?: string; worktreeId?: string; title?: string; linkedAt: string }
type Json = Record<string, any>

export class Windows {
  constructor(private readonly store: Store, private readonly cli: string,
    private readonly rpc: typeof sessionRpc = sessionRpc,
    private readonly run: (args: string[]) => Promise<Json> = async args => {
      const response = JSON.parse((await execute(cli, [...args, '--json'], { timeout: 15_000, maxBuffer: 8_000_000 })).stdout)
      if (!response.ok) throw new Error(response.error?.message ?? 'Orca command failed')
      return response.result
    }) {}

  private scope(options: Options): { roots: string[]; workspaces: string[] } {
    const ticket = options.ticket && this.store.tickets.get(options.ticket)
    if (options.ticket && !ticket) throw new Error('Unknown ticket')
    const target = ticket && this.store.get<TicketTarget>('ticket-target', ticket.id)
    if (ticket && !target) throw new Error('Ticket has no registered project')
    const projects = this.store.list<{id: string; name: string}>('project')
    const matches = options.project ? projects.filter(project => project.id === options.project || project.name === options.project) : projects
    if (options.project && matches.length !== 1) throw new Error('Select an unambiguous registered project')
    if (target && options.project && matches[0].id !== target.projectId) throw new Error('Ticket does not belong to project')
    const ids = new Set(target ? [target.projectId] : matches.map(project => project.id))
    const components = this.store.list<{id: string; projectId: string}>('component').filter(component => ids.has(component.projectId))
    const componentIds = new Set(components.map(component => component.id))
    const paths = this.store.list<{componentId: string; repository?: string; hostId?: string}>('location')
      .filter(location => componentIds.has(location.componentId) && location.hostId === 'local' && location.repository).map(location => `path:${location.repository}`)
    const roots = [...new Set(paths)]
    const selected = ticket ? [ticket] : this.store.tickets.list().filter(item => ids.has(this.store.get<TicketTarget>('ticket-target', item.id)?.projectId ?? ''))
    for (const item of selected) for (const workspace of new Projects(this.store).workspaces(item.id))
      paths.push(workspace.worktreeId ? `id:${workspace.worktreeId}` : `path:${workspace.directory}`)
    const unique = [...new Set(paths)]
    if (unique.length > 100) throw new Error('Too many project workspaces; select a project or ticket')
    return { roots, workspaces: unique }
  }

  async list(options: Options = {}) {
    const windows: Window[] = [], errors: {workspace: string; source: string; error: string}[] = []
    let truncated = false
    const scope = this.scope(options), workspaces = new Set(scope.workspaces)
    for (const root of scope.roots) {
      try {
        const result = await this.run(['worktree', 'list', '--repo', root, '--limit', '100'])
        if (!Array.isArray(result.worktrees)) throw new Error('Orca omitted worktrees')
        truncated ||= !!result.truncated || result.worktrees.length > 100
        for (const worktree of result.worktrees.slice(0, 100)) {
          if (typeof worktree.id !== 'string' || typeof worktree.path !== 'string') throw new Error('Orca omitted worktree identity or path')
          workspaces.delete(`path:${worktree.path}`)
          workspaces.add(`id:${worktree.id}`)
        }
      } catch (error) { errors.push({ workspace: root, source: 'Orca worktree list', error: String(error) }) }
    }
    if (workspaces.size > 100) truncated = true
    for (const workspace of [...workspaces].slice(0, 100)) {
      try {
        const result = await this.run(['terminal', 'list', '--worktree', workspace, '--limit', '100'])
        if (!Array.isArray(result.terminals)) throw new Error('Orca omitted terminals')
        truncated ||= !!result.truncated
        for (const terminal of result.terminals.slice(0, 100)) if (typeof terminal.handle === 'string') windows.push({ terminal: terminal.handle, worktreeId: terminal.worktreeId, title: terminal.title, workspace, state: terminal.status })
      } catch (error) { errors.push({ workspace, source: 'Orca terminal list', error: String(error) }) }
      try {
        const response = await this.rpc('session.tabs.list', { worktree: workspace })
        const result = response.result
        if (!Array.isArray(result?.tabs)) throw new Error('Orca omitted session tabs')
        const tabs = result.tabs.filter((tab: Json) => tab.type === 'agent-session' && typeof tab.sessionId === 'string')
        truncated ||= tabs.length > 100
        for (const tab of tabs.slice(0, 100)) windows.push({ sessionId: tab.sessionId, worktreeId: result.worktree, title: tab.title, workspace, state: tab.chatStatus })
      } catch (error) { errors.push({ workspace, source: 'Orca session tabs', error: String(error) }) }
    }
    return { windows, errors, truncated, source: 'Orca workspace observations; not task or business status' }
  }

  private identity(options: Options): string {
    if (!options.ticket || !this.store.tickets.get(options.ticket)) throw new Error('A valid ticket is required')
    if (!!options.session === !!options.terminal) throw new Error('Select exactly one session or terminal')
    return options.session ?? options.terminal!
  }

  async link(options: Options) {
    const identity = this.identity(options), listing = await this.list({ ticket: options.ticket })
    const matches = listing.windows.filter(window => options.session ? window.sessionId === identity : window.terminal === identity)
    const distinct = [...new Map(matches.map(window => [window.worktreeId ?? window.workspace, window])).values()]
    if (distinct.length !== 1) throw new Error('Window is not uniquely visible in the ticket project or workspaces; inspect listing errors')
    const window = distinct[0], id = `${options.ticket}:${identity}`
    const previous = this.store.get<Link>('linked-window', id)
    const link: Link = { ticketId: options.ticket!, ...(options.session ? { sessionId: identity } : { terminal: identity }),
      ...(window.worktreeId ? { worktreeId: window.worktreeId } : {}), ...(window.title ? { title: window.title } : {}), linkedAt: previous?.linkedAt ?? new Date().toISOString() }
    this.store.put('linked-window', id, link)
    return link
  }

  private async linked(options: Options): Promise<Link> {
    const identity = this.identity(options), link = this.store.get<Link>('linked-window', `${options.ticket}:${identity}`)
    if (!link || link.sessionId !== options.session || link.terminal !== options.terminal) throw new Error('Window is not linked to this ticket')
    const listing = await this.list({ ticket: options.ticket })
    if (!listing.windows.some(window => (options.session ? window.sessionId === identity : window.terminal === identity) && (!link.worktreeId || window.worktreeId === link.worktreeId)))
      throw new Error('Linked window is no longer visible in its registered workspace; inspect listing errors')
    return link
  }

  async observe(options: Options) {
    const link = await this.linked(options)
    if (link.sessionId) {
      const response = await this.rpc('agentSession.history', { sessionId: link.sessionId, direction: 'tail', limit: 20 })
      if (!response.result?.ok || response.result.page?.sessionId !== link.sessionId) throw new Error('Orca session history unavailable')
      return { link, source: 'Orca structured session history; not task or business status', observation: response.result.page }
    }
    const observation = await this.run(['terminal', 'read', '--terminal', link.terminal!, '--screen', '--limit', '1000'])
    return { link, source: 'Orca terminal screen; not task or business status', observation }
  }

  async open(options: Options) {
    const link = await this.linked(options)
    if (link.sessionId) return { link, navigated: false, reason: 'The current public Orca interface does not provide structured session navigation.' }
    const result = await this.run(['terminal', 'switch', '--terminal', link.terminal!])
    return { link, ...result }
  }
}
