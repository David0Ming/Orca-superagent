import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { key, type Engine, type OutboundMessage, type ReplyStatus } from '../vendor/dsh-core/src/index.ts'
import type { Store } from './store.ts'

type Options = { repository: string; owner: { id: string; login: string }; cli?: string }
type Json = Record<string, unknown>
type Cursor = { started: string; since: string }
type Mail = OutboundMessage & { status: ReplyStatus; error?: string }
const exec = promisify(execFile)
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub JSON object')
  return value as Json
}
const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Invalid GitHub string')
  return value
}
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid GitHub ID')
  return value
}
const time = (value: unknown): string => {
  const text = string(value)
  if (!Number.isFinite(Date.parse(text))) throw new Error('Invalid GitHub timestamp')
  return new Date(text).toISOString()
}
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Invalid GitHub JSON array')
  return value
}
async function api(cli: string, path: string, args: string[] = []): Promise<unknown> {
  const { stdout } = await exec(cli, ['api', '--hostname', 'github.com', path, ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/** GitHub adapter, following the upstream MIT source's cursor, PR binding, and marker protocols. */
export class GitHub {
  private readonly cli: string
  private readonly stateId: string
  private ticking?: Promise<void>

  constructor(private readonly store: Store, readonly options: Options) {
    if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(options.repository) || ['.', '..'].includes(options.repository.split('/')[1])) throw new Error('Invalid GitHub repository')
    if (!/^[1-9]\d*$/.test(options.owner.id) || !/^[a-zA-Z0-9-]+$/.test(options.owner.login)) throw new Error('Invalid GitHub owner')
    this.cli = options.cli ?? 'gh'
    this.stateId = `${options.repository}:${options.owner.id}`
    if (!store.get('github.cursor', this.stateId)) {
      // GitHub timestamps have second precision; include this activation second on the first poll.
      const started = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()
      store.put('github.cursor', this.stateId, { started, since: started })
    }
  }

  static async discover(cli = 'gh'): Promise<Options['owner']> {
    const user = object(await api(cli, 'user'))
    if (user.type !== 'User') throw new Error('GitHub owner must be a human account')
    const login = string(user.login)
    if (!/^[a-zA-Z0-9-]+$/.test(login)) throw new Error('Invalid GitHub login')
    return { id: String(integer(user.id)), login }
  }

  tick(engine: Engine): Promise<void> {
    return this.ticking ??= this.run(engine).finally(() => { this.ticking = undefined })
  }

  private async run(engine: Engine): Promise<void> {
    const errors: unknown[] = []
    try { await this.poll(engine) } catch (error) { errors.push(error) }
    try { await this.send() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '))
  }

  private request(path: string, args: string[] = []): Promise<unknown> {
    return api(this.cli, `repos/${this.options.repository}/${path}`, args)
  }

  private async pages(path: string, field?: string): Promise<Json[]> {
    const pages = array(await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100`, ['--paginate', '--slurp']))
    return pages.flatMap(page => array(field ? object(page)[field] : page).map(object))
  }

  private owner(user: unknown): boolean {
    if (user === null) return false
    const value = object(user)
    return value.type === 'User' && String(integer(value.id)) === this.options.owner.id && !string(value.login).endsWith('[bot]')
  }

  private ref(number: number) { return { source: 'github', id: `${this.options.repository}:${number}` } }
  private channel(number: number) {
    return { source: 'github', thread: this.ref(number).id, address: { repository: this.options.repository, number: String(number) } }
  }

  private number(url: unknown, kind: 'issues' | 'pulls'): number {
    const parsed = new URL(string(url))
    const prefix = `/repos/${this.options.repository}/${kind}/`
    if (parsed.origin !== 'https://api.github.com' || !parsed.pathname.toLowerCase().startsWith(prefix.toLowerCase()) || parsed.search || parsed.hash) throw new Error('GitHub event outside selected repository')
    const suffix = parsed.pathname.slice(prefix.length)
    if (!/^[1-9]\d*$/.test(suffix)) throw new Error('Invalid GitHub thread URL')
    return integer(Number(suffix))
  }

  private ownMarker(body: string, number: number): boolean {
    return [...body.matchAll(/<!-- osa:([^\s<>]+) -->/g)].some(match => {
      const mail = this.store.get<Mail>('outbox', match[1])
      return mail?.channel.source === 'github' && mail.channel.thread === this.ref(number).id
    })
  }

  private ingest(engine: Engine, item: Json, number: number, kind: string, since: string, isPr: boolean): void {
    if (!this.owner(item.user)) return
    const id = integer(item.id), at = time(item.updated_at ?? item.submitted_at ?? item.created_at)
    if (at < since) return
    const body = item.body == null ? '' : string(item.body)
    if (this.ownMarker(body, number)) return
    const text = [kind === 'issue' ? string(item.title) : '',
      kind === 'review' ? string(item.state) : '',
      kind === 'review-comment' && item.path ? `${string(item.path)}${item.line == null ? '' : `:${integer(item.line)}`}` : '', body].filter(Boolean).join('\n\n')
    if (!text.trim()) return
    // Issue updated_at also changes for timeline activity, including our own replies.
    engine.receive({ id: key('github', this.options.repository, kind, String(id), kind === 'issue' ? '' : at, text), source: 'github',
      actor: { source: 'github', id: this.options.owner.id }, human: true, addressed: 'direct', at, text,
      threads: [this.ref(number)], channel: this.channel(number),
      url: `https://github.com/${this.options.repository}/${isPr ? 'pull' : 'issues'}/${number}`,
      meta: { repository: this.options.repository, number, isPr, kind, nativeId: id } })
    const thread = this.store.threads.get(`github:${this.ref(number).id}`)
    if (thread) this.store.threads.save({ ...thread, meta: { ...thread.meta, repository: this.options.repository, number, isPr } })
  }

  private ownedPull(pr: Json): boolean {
    if (!this.owner(pr.user)) return false
    const head = object(pr.head)
    return head.repo !== null && string(object(head.repo).full_name).toLowerCase() === this.options.repository.toLowerCase()
  }

  private targetMatches(ticketId: string): boolean {
    const target = this.store.get<{ ticketId: string; github?: { repository: string; owner: Options['owner'] } }>('ticket-target', ticketId)
    if (!target) return !this.store.list('project').length && !this.store.list('ticket-target').length && this.store.list('github.cursor').length === 1
    return target.ticketId === ticketId && target.github?.repository === this.options.repository
      && target.github.owner.id === this.options.owner.id && target.github.owner.login === this.options.owner.login
  }

  private bind(engine: Engine, pr: Json): void {
    if (!this.ownedPull(pr)) return
    const number = integer(pr.number), ref = this.ref(number), branch = string(object(pr.head).ref)
    const candidates = this.store.tickets.open().filter(ticket => ticket.execution?.name === branch && this.targetMatches(ticket.id))
    if (candidates.length !== 1) return
    const ticket = candidates[0], followed = ticket.follows?.find(follow => follow.thread === `github:${ref.id}`)
    if (this.store.tickets.open().some(other => other.id !== ticket.id && other.follows?.some(follow => follow.thread === `github:${ref.id}` && follow.own))) return
    if (!followed || !followed.own || (followed.closed && pr.state === 'open')) engine.bindThread(ticket.id, ref, true)
    const thread = this.store.threads.get(`github:${ref.id}`)
    if (thread) this.store.threads.save({ ...thread, meta: { ...thread.meta, repository: this.options.repository, number, isPr: true } })
  }

  private async poll(engine: Engine): Promise<void> {
    const cursor = this.store.get<Cursor>('github.cursor', this.stateId)!
    const started = Date.now(), since = encodeURIComponent(cursor.since)
    const errors: unknown[] = []
    const attempt = async (label: string, work: () => void | Promise<void>) => {
      const id = `github-poll:${this.stateId}:${label}`
      try { await work(); this.store.delete('notice', id); return true }
      catch (error) { errors.push(error); this.store.put('notice', id, { id, text: String(error) }); return false }
    }
    const issues = await this.pages(`issues?state=all&sort=updated&direction=asc&since=${since}`)
    const pulls = new Map<number, Json>()
    // shortcut: scan open PRs for reviews; use webhook delivery if repository activity makes polling costly.
    for (const pr of await this.pages('pulls?state=open')) pulls.set(integer(pr.number), pr)
    for (const issue of issues) if (issue.pull_request) pulls.set(integer(issue.number), issue)
    for (const ticket of this.store.tickets.open().filter(ticket => this.targetMatches(ticket.id))) for (const follow of ticket.follows ?? []) {
      const prefix = `github:${this.options.repository}:`
      if (follow.thread.startsWith(prefix)) {
        const number = Number(follow.thread.slice(prefix.length))
        if (follow.own || this.store.threads.get(follow.thread)?.meta.isPr === true) pulls.set(integer(number), pulls.get(number) ?? {})
      }
    }
    // Bind each readable PR before its comments, without letting another PR block intake.
    const unavailable = new Set<number>()
    for (const number of pulls.keys()) {
      if (!await attempt(`pull:${number}`, async () => {
        const pr = object(await this.request(`pulls/${number}`))
        if (integer(pr.number) !== number || !['open', 'closed'].includes(string(pr.state))) throw new Error('Invalid GitHub PR')
        pulls.set(number, pr)
        this.store.atomic(() => this.bind(engine, pr))
      })) unavailable.add(number)
    }
    for (const issue of issues) await attempt(`issue:${issue.number}`, () => {
      if (!issue.pull_request && time(issue.created_at) >= cursor.started)
        this.store.atomic(() => this.ingest(engine, issue, integer(issue.number), 'issue', cursor.since, false))
    })
    await attempt('issue-comments', async () => {
      for (const comment of await this.pages(`issues/comments?sort=updated&direction=asc&since=${since}`)) {
        await attempt(`comment:${comment.id}`, () => {
          const number = this.number(comment.issue_url, 'issues')
          if (!unavailable.has(number)) this.store.atomic(() => this.ingest(engine, comment, number, 'comment', cursor.since, pulls.has(number)))
        })
      }
    })
    await attempt('review-comments', async () => {
      for (const comment of await this.pages(`pulls/comments?sort=updated&direction=asc&since=${since}`)) {
        await attempt(`review-comment:${comment.id}`, () => {
          const number = this.number(comment.pull_request_url, 'pulls')
          if (!unavailable.has(number)) this.store.atomic(() => this.ingest(engine, comment, number, 'review-comment', cursor.since, true))
        })
      }
    })
    for (const [number, pr] of pulls) {
      if (unavailable.has(number)) continue
      await attempt(`reviews:${number}`, async () => {
        for (const review of await this.pages(`pulls/${number}/reviews`)) {
          await attempt(`review:${review.id}`, () => {
            if (review.state !== 'PENDING') this.store.atomic(() => this.ingest(engine, review, number, 'review', cursor.started, true))
          })
        }
      })
      await attempt(`state:${number}`, async () => {
        if (!this.ownedPull(pr) || !this.store.tickets.open().some(ticket => this.targetMatches(ticket.id) && ticket.follows?.some(follow => follow.own && follow.thread === `github:${this.ref(number).id}`))) return
        if (pr.state === 'closed') this.store.atomic(() => engine.threadClosed(this.ref(number), pr.merged_at ? 'merged' : 'closed', time(pr.merged_at ?? pr.closed_at)))
        else await this.ci(engine, pr)
      })
    }
    // shortcut: retain the shared cursor on any failed item; valid items deduplicate on retry. Add per-stream cursors if backlog scanning becomes costly.
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '))
    // Overlap the request boundary for second-precision/eventual API timestamps; trigger IDs absorb repeats.
    this.store.put('github.cursor', this.stateId, { ...cursor, since: new Date(Math.max(Date.parse(cursor.since), started - 5000)).toISOString() })
  }

  private async ci(engine: Engine, pr: Json): Promise<void> {
    const number = integer(pr.number), sha = string(object(pr.head).sha)
    if (!/^[a-fA-F0-9]{40,64}$/.test(sha)) throw new Error('Invalid GitHub commit SHA')
    const checks = await this.pages(`commits/${sha}/check-runs`, 'check_runs')
    const statuses = await this.pages(`commits/${sha}/statuses`)
    const contexts = new Set<string>()
    const summary = [...checks.map(check => `${integer(check.id)} ${string(check.name)}: ${string(check.conclusion ?? check.status)}`),
      ...statuses.flatMap(status => {
        const context = string(status.context)
        if (contexts.has(context)) return []
        contexts.add(context)
        return [`${context}: ${string(status.state)}`]
      })].sort().join('\n')
    const id = this.ref(number).id, fingerprint = key(sha, summary)
    const previous = this.store.get<{ fingerprint: string; revision: number }>('github.ci', id)
    if (previous?.fingerprint === fingerprint) return
    const revision = (previous?.revision ?? 0) + 1
    this.store.atomic(() => {
      if (previous && summary) engine.receive({ id: key('github', this.options.repository, 'ci', String(number), String(revision)), source: 'github',
        actor: { source: 'github', id: 'ci' }, human: false, at: new Date().toISOString(),
        text: `CI for PR #${number} (${sha}):\n${summary || 'No checks'}`, threads: [this.ref(number)],
        meta: { repository: this.options.repository, number, isPr: true, ci: true, sha } })
      const thread = this.store.threads.get(`github:${id}`)
      if (thread) this.store.threads.save({ ...thread, meta: { ...thread.meta, ci: summary, sha } })
      this.store.put('github.ci', id, { fingerprint, revision })
    })
  }

  private async send(): Promise<void> {
    const blocked = new Set<string>(), errors: unknown[] = []
    const messages = this.store.list<Mail>('outbox').filter(mail => mail.channel.source === 'github' && mail.channel.address.repository === this.options.repository)
    if (messages.some(mail => mail.status === 'pending' && mail.channel.source === 'github')) {
      if ((await GitHub.discover(this.cli)).id !== this.options.owner.id) throw new Error('GitHub account changed; replies remain pending')
    }
    for (const mail of messages) {
      if (mail.status !== 'pending' || mail.channel.source !== 'github' || blocked.has(mail.channel.thread)) continue
      try {
        const { repository, number } = mail.channel.address
        if (repository !== this.options.repository || !/^[1-9]\d*$/.test(number) || mail.channel.thread !== this.ref(integer(Number(number))).id || !/^[\w:-]+$/.test(mail.id)) throw new Error('Invalid GitHub outbox address or ID')
        const marker = `<!-- osa:${mail.id} -->`, path = `issues/${number}/comments`
        const comments = await this.pages(path)
        if (!comments.some(comment => this.owner(comment.user) && string(comment.body ?? '').includes(marker))) {
          integer(object(await this.request(path, ['--method', 'POST', '--raw-field', `body=${mail.text}\n\n${marker}`])).id)
        }
        this.store.put('outbox', mail.id, { ...mail, status: 'sent', error: undefined })
      } catch (error) {
        blocked.add(mail.channel.thread)
        this.store.put('outbox', mail.id, { ...mail, error: String(error) })
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'GitHub outbox delivery failed; messages remain pending')
  }
}
