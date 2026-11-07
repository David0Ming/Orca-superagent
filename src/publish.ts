import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { latestAssignment, type Engine } from '../vendor/dsh-core/src/index.ts'
import type { GitHubConfig } from './app.ts'
import type { Store } from './store.ts'

const execute = promisify(execFile)
type Pull = { number: number; html_url: string; state: string; user: { id: number }; head: { ref: string; sha: string; repo: { full_name: string } } }

export class Publisher {
  private active = new Map<string, Promise<unknown>>()
  constructor(private store: Store, private config: GitHubConfig, private reviews: { assertReady(ticket: string, assignment: string): Promise<void> }, private cli = 'gh') {}

  publish(engine: Engine, ticketId: string, assignment: string, title: string, body: string): Promise<unknown> {
    const running = this.active.get(ticketId)
    if (running) return running
    const promise = this.perform(engine, ticketId, assignment, title, body).finally(() => this.active.delete(ticketId))
    this.active.set(ticketId, promise)
    return promise
  }

  private async api(path: string, fields?: Record<string, string>): Promise<any> {
    const args = ['api', '--hostname', 'github.com', path]
    if (fields) { args.push('--method', 'POST'); for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`) }
    return JSON.parse((await execute(this.cli, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout)
  }

  private async perform(engine: Engine, ticketId: string, assignment: string, title: string, body: string): Promise<unknown> {
    const { repository, owner } = this.config
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || ticket.ended || latestAssignment(ticket)?.id !== assignment || latestAssignment(ticket)?.state !== 'running') throw new Error('Publishing requires the current running assignment')
    const target = this.store.get<{ ticketId: string; repository: string; kind: string; hostId: string; github?: GitHubConfig }>('ticket-target', ticketId)
    const targetBinding = JSON.stringify(target)
    const assertTarget = () => {
      const current = this.store.get<typeof target>('ticket-target', ticketId)
      if (JSON.stringify(current) !== targetBinding) throw new Error('Ticket target changed during publishing')
      if (!current && (this.store.list('project').length || this.store.list('ticket-target').length || this.store.list('github.cursor').length > 1)) throw new Error('Ticket target is unknown')
      if (current && (current.ticketId !== ticketId || current.kind !== 'git' || current.hostId !== 'local'
        || !isAbsolute(current.repository) || current.github?.repository !== repository
        || current.github.owner.id !== owner.id || current.github.owner.login !== owner.login)) throw new Error('Publisher does not match ticket target')
      const authorization = this.store.get<{ repository: string; owner?: GitHubConfig['owner'] }>('publish-authorization', ticketId)
      if (authorization?.repository !== repository || (current && (authorization.owner?.id !== owner.id || authorization.owner.login !== owner.login)))
        throw new Error('Router has not authorized publishing this ticket target')
    }
    assertTarget()
    const plan = this.store.get<{workspace?: string; continueFrom?: string}>('task-plan', ticketId)
    if (plan?.workspace === 'inspect' || plan?.continueFrom) throw new Error('Publishing requires a ticket-owned isolated branch')
    if (!title.trim() || !body.trim()) throw new Error('PR title and body are required')
    const directory = ticket.execution?.directory, branch = ticket.execution?.name
    if (!directory || !branch || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(branch)) throw new Error('Invalid ticket workspace')
    const git = async (...args: string[]) => (await execute('git', ['-C', directory, ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
    if (target) {
      const root = await realpath(target.repository)
      const targetGit = async (...args: string[]) => (await execute('git', ['-C', root, ...args])).stdout.trim()
      if (await realpath(await targetGit('rev-parse', '--show-toplevel')) !== root
        || await realpath(await git('rev-parse', '--path-format=absolute', '--git-common-dir')) !== await realpath(await targetGit('rev-parse', '--path-format=absolute', '--git-common-dir'))
        || await realpath(await git('rev-parse', '--show-toplevel')) !== await realpath(directory)) throw new Error('Publish workspace does not belong to ticket target')
    }
    if (await git('status', '--porcelain')) throw new Error('Commit authorized changes before review and publishing')
    if (await git('branch', '--show-current') !== branch) throw new Error('Worktree is not on the ticket branch')
    const sha = await git('rev-parse', 'HEAD')
    const id = `${ticketId}:${sha}`
    await this.reviews.assertReady(ticketId, assignment)
    const account = await this.api('user')
    if (String(account.id) !== owner.id) throw new Error('GitHub account changed; refusing publication')
    const metadata = await this.api(`repos/${repository}`)
    if (typeof metadata.default_branch !== 'string' || metadata.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error('GitHub repository mismatch')
    if (branch === metadata.default_branch) throw new Error('Cannot publish a ticket to the default branch')
    // Persist the publication intent; retry uses the first title/body and the same immutable commit.
    let intent = this.store.get<{ title: string; body: string; sha: string; pr?: number }>('publication', id)
    if (!intent) { intent = { title, body, sha }; this.store.put('publication', id, intent) }
    const assertCurrent = async () => {
      const revision = JSON.stringify(this.store.tickets.get(ticketId))
      assertTarget()
      const current = this.store.tickets.get(ticketId)
      if (!current || current.ended || latestAssignment(current)?.id !== assignment || latestAssignment(current)?.state !== 'running') throw new Error('Assignment changed during publishing')
      if (await git('rev-parse', 'HEAD') !== sha || await git('status', '--porcelain')) throw new Error('Workspace changed during publishing')
      await this.reviews.assertReady(ticketId, assignment)
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
    if (!pull || pull.state !== 'open' || !Number.isSafeInteger(pull.number) || String(pull.user?.id) !== owner.id || pull.head?.ref !== branch || pull.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error('PR does not belong to this ticket')
    this.store.atomic(() => {
      assertTarget()
      const current = this.store.tickets.get(ticketId)
      if (!current || current.ended || latestAssignment(current)?.id !== assignment) throw new Error('Assignment changed after publication; inspect persisted intent')
      engine.bindThread(ticketId, { source: 'github', id: `${repository}:${pull!.number}` }, true)
      this.store.put('publication', id, { ...intent, pr: pull!.number, url: pull!.html_url })
    })
    return { number: pull.number, url: pull.html_url, sha }
  }
}
