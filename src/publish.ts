import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { latestAssignment, type Engine } from '../vendor/dsh-core/src/index.ts'
import type { GitHubConfig } from './app.ts'
import type { Store } from './store.ts'
import { Projects, type TicketTarget } from './projects.ts'

const execute = promisify(execFile)
type Pull = { number: number; html_url: string; state: string; user: { id: number }; head: { ref: string; sha: string; repo: { full_name: string } } }

export class Publisher {
  private active = new Map<string, Promise<unknown>>()
  constructor(private store: Store, private config: GitHubConfig, private cli = 'gh') {}

  publish(engine: Engine, ticketId: string, assignment: string, title: string, body: string, location?: string): Promise<unknown> {
    const activeId = `${ticketId}:${location ?? ''}`
    const running = this.active.get(activeId)
    if (running) return running
    const promise = this.perform(engine, ticketId, assignment, title, body, location).finally(() => this.active.delete(activeId))
    this.active.set(activeId, promise)
    return promise
  }

  async assertPublished(ticketId: string, assignment: string, location?: string): Promise<void> {
    const ticket = this.store.tickets.get(ticketId), projects = new Projects(this.store), targets = projects.targets(ticketId)
    if (!ticket || latestAssignment(ticket)?.id !== assignment) throw new Error('Publication does not belong to the current assignment')
    if (targets.length > 1 && !location) throw new Error('Select --location for a multi-repository publication')
    const target = location ? targets.find(target => target.locationId === location) : targets[0]
    if ((location && !target) || (target && target.github?.repository !== this.config.repository)) throw new Error('Publisher does not match ticket target')
    const workspace = target && projects.workspaces(ticketId).find(workspace => workspace.locationId === target.locationId)
    const directory = workspace?.directory ?? (targets.length < 2 ? ticket.execution?.directory : undefined)
    if (!directory) throw new Error('Publication workspace is unavailable')
    const git = async (...args: string[]) => (await execute('git', ['-C', directory, ...args], {timeout: 60_000, maxBuffer: 8 * 1024 * 1024})).stdout.trim()
    if (await git('status', '--porcelain')) throw new Error('Commit and publish current changes before reporting ready')
    const sha = await git('rev-parse', 'HEAD'), id = targets.length > 1 ? `${ticketId}:${target!.locationId}:${sha}` : `${ticketId}:${sha}`
    const publication = this.store.get<{ticketId?: string; repository?: string; sha: string; pr?: number}>('publication', id)
    if (!publication?.pr || publication.sha !== sha || (publication.ticketId && publication.ticketId !== ticketId) || (publication.repository && publication.repository !== this.config.repository)
      || !ticket.follows?.some(follow => follow.own && follow.thread === `github:${this.config.repository}:${publication.pr}`)) throw new Error(`Publish the current commit for ${this.config.repository} before reporting ready`)
  }

  private async api(path: string, fields?: Record<string, string>): Promise<any> {
    const args = ['api', '--hostname', 'github.com', path]
    if (fields) { args.push('--method', 'POST'); for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`) }
    return JSON.parse((await execute(this.cli, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout)
  }

  private async perform(engine: Engine, ticketId: string, assignment: string, title: string, body: string, location?: string): Promise<unknown> {
    const { repository, owner } = this.config
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || ticket.ended || latestAssignment(ticket)?.id !== assignment || latestAssignment(ticket)?.state !== 'running') throw new Error('Publishing requires the current running assignment')
    const projects = new Projects(this.store), targets = projects.targets(ticketId)
    if (targets.length > 1 && !location) throw new Error('Select --location for publishing a multi-repository task')
    const target = location ? targets.find(target => target.locationId === location) : targets[0]
    if (location && !target) throw new Error('Location does not belong to ticket target')
    const targetBinding = JSON.stringify(this.store.get('ticket-target', ticketId))
    const assertTarget = () => {
      const current = this.store.get<TicketTarget>('ticket-target', ticketId)
      if (JSON.stringify(current) !== targetBinding) throw new Error('Ticket target changed during publishing')
      if (!current && (this.store.list('project').length || this.store.list('ticket-target').length || this.store.list('github.cursor').length > 1)) throw new Error('Ticket target is unknown')
      if (target && (current?.ticketId !== ticketId || target.kind !== 'git' || target.hostId !== 'local'
        || !isAbsolute(target.repository) || target.github?.repository !== repository
        || target.github.owner.id !== owner.id || target.github.owner.login !== owner.login)) throw new Error('Publisher does not match ticket target')
      const authorization = this.store.get<GitHubConfig & {repositories?: GitHubConfig[]}>('publish-authorization', ticketId)
      const authorized = authorization?.repositories ?? (authorization ? [authorization] : [])
      if (!authorized.some(item => item.repository === repository && (!current || (item.owner?.id === owner.id && item.owner.login === owner.login))))
        throw new Error('Owner has not authorized publishing this ticket target')
    }
    assertTarget()
    const plan = this.store.get<{workspace?: string; continueFrom?: string}>('task-plan', ticketId)
    if (plan?.workspace === 'inspect' || plan?.continueFrom) throw new Error('Publishing requires a ticket-owned isolated branch')
    if (!title.trim() || !body.trim()) throw new Error('PR title and body are required')
    const workspace = target && projects.workspaces(ticketId).find(workspace => workspace.locationId === target.locationId)
    const directory = workspace?.directory ?? (!target || targets.length === 1 ? ticket.execution?.directory : undefined), branch = workspace?.name ?? (!target || targets.length === 1 ? ticket.execution?.name : undefined)
    if (!directory || !branch || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(branch)) throw new Error('Invalid ticket workspace')
    const git = async (...args: string[]) => (await execute('git', ['-C', directory, ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
    if (target) {
      const root = await realpath(target.repository)
      const targetGit = async (...args: string[]) => (await execute('git', ['-C', root, ...args])).stdout.trim()
      if (await realpath(await targetGit('rev-parse', '--show-toplevel')) !== root
        || await realpath(await git('rev-parse', '--path-format=absolute', '--git-common-dir')) !== await realpath(await targetGit('rev-parse', '--path-format=absolute', '--git-common-dir'))
        || await realpath(await git('rev-parse', '--show-toplevel')) !== await realpath(directory)) throw new Error('Publish workspace does not belong to ticket target')
    }
    if (await git('status', '--porcelain')) throw new Error('Commit authorized changes before publishing')
    if (await git('branch', '--show-current') !== branch) throw new Error('Worktree is not on the ticket branch')
    const sha = await git('rev-parse', 'HEAD')
    const id = targets.length > 1 ? `${ticketId}:${target!.locationId}:${sha}` : `${ticketId}:${sha}`
    const account = await this.api('user')
    if (String(account.id) !== owner.id) throw new Error('GitHub account changed; refusing publication')
    const metadata = await this.api(`repos/${repository}`)
    if (typeof metadata.default_branch !== 'string' || metadata.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error('GitHub repository mismatch')
    if (branch === metadata.default_branch) throw new Error('Cannot publish a ticket to the default branch')
    // Persist the publication intent; retry uses the first title/body and the same immutable commit.
    let intent = this.store.get<{ title: string; body: string; sha: string; pr?: number }>('publication', id)
    if (!intent) { intent = { title, body, sha }; this.store.put('publication', id, { ...intent, ticketId, repository, ...(target ? {locationId: target.locationId} : {}) }) }
    const assertCurrent = async () => {
      const revision = JSON.stringify(this.store.tickets.get(ticketId))
      assertTarget()
      const current = this.store.tickets.get(ticketId)
      if (!current || current.ended || latestAssignment(current)?.id !== assignment || latestAssignment(current)?.state !== 'running') throw new Error('Assignment changed during publishing')
      if (await git('rev-parse', 'HEAD') !== sha || await git('status', '--porcelain')) throw new Error('Workspace changed during publishing')
      assertTarget()
      if (JSON.stringify(this.store.tickets.get(ticketId)) !== revision) throw new Error('Assignment changed during publishing')
    }
    await assertCurrent()
    await git('push', `https://github.com/${repository}.git`, `${sha}:refs/heads/${branch}`)
    const candidates = await this.api(`repos/${repository}/pulls?state=open&head=${encodeURIComponent(repository.split('/')[0] + ':' + branch)}&per_page=100`)
    if (!Array.isArray(candidates) || candidates.length > 1) throw new Error('Ambiguous PR identity')
    let pull: Pull | undefined = candidates[0]
    await assertCurrent()
    if (!pull) pull = await this.api(`repos/${repository}/pulls`, { title: intent.title, body: intent.body + `\n\n<!-- osa-ticket:${ticketId} -->`, head: branch, base: metadata.default_branch })
    if (!pull || pull.state !== 'open' || !Number.isSafeInteger(pull.number) || String(pull.user?.id) !== owner.id || pull.head?.ref !== branch || pull.head.sha !== sha || pull.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error('PR does not belong to this ticket')
    this.store.atomic(() => {
      assertTarget()
      const current = this.store.tickets.get(ticketId)
      if (!current || current.ended || latestAssignment(current)?.id !== assignment) throw new Error('Assignment changed after publication; inspect persisted intent')
      engine.bindThread(ticketId, { source: 'github', id: `${repository}:${pull!.number}` }, true)
      this.store.put('publication', id, { ...intent, ticketId, repository, ...(target ? {locationId: target.locationId} : {}), pr: pull!.number, url: pull!.html_url })
    })
    return { number: pull.number, url: pull.html_url, sha }
  }
}
