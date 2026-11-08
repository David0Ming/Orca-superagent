import { execFile } from 'node:child_process'
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { Store } from './store.ts'
import { Projects, type TicketTarget } from './projects.ts'

const execute = promisify(execFile)
type Cleanup = { ticketId: string; directory: string; state: 'removing' | 'unknown' | 'removed' | 'reset'; fingerprint: string; referenceFingerprint?: string; receipt?: unknown; error?: string }

/** Explicit, non-forced removal of unused framework worktrees. */
export class WorkspaceCleanup {
  private readonly active = new Map<string, Promise<unknown>>()
  constructor(private readonly store: Store, private readonly cli: string) {}

  private async native(args: string[], cwd: string): Promise<any> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ORCA_')))
    const { stdout } = await execute(this.cli, [...args, '--json', ...(args[0] === 'orchestration' ? ['--full'] : [])], { cwd, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
    const response = JSON.parse(stdout)
    if (response.ok !== true || !response.result) throw new Error(`Orca cleanup observation unavailable: ${response.error?.code ?? 'invalid response'}`)
    return response.result
  }

  async inspect(ticketId: string) {
    const ticket = this.store.tickets.get(ticketId), target = this.store.get<TicketTarget>('ticket-target', ticketId)
    if (!ticket || !target || target.hostId !== 'local' || target.kind !== 'git') throw new Error('Cleanup requires a registered local Git ticket')
    const unchanged = () => JSON.stringify([this.store.tickets.list(), this.store.list('task-plan'), this.store.list('ticket-target'), this.store.list('orca-assignment'), this.store.list('goal')])
    const revision = unchanged()
    const directory = ticket.execution?.directory
    const reasons: string[] = []
    const projects = new Projects(this.store), owner = projects.workspaceOwner(ticketId)
    const operation = this.store.get<any>('orca-operation', `worktree:${owner}`)
    const owned = operation?.response?.result?.worktree
    if (!directory || !owned?.id || owned.path !== directory || directory === target.repository) reasons.push('Not a ticket-owned isolated worktree')
    if (!ticket.ended) reasons.push('Business ticket is still open')
    const shared = this.store.tickets.list().filter(t => t.id === ticketId || directory && (projects.directory(t.id) === directory || projects.workspaces(t.id).some(workspace => workspace.directory === directory)))
    const bindings = this.store.list<any>('orca-assignment').filter(b => shared.some(t => t.id === b.ticketId))
    if (!bindings.length || bindings.some(b => !b.finished)) reasons.push('Executor resources are unresolved')
    if (bindings.some(b => (b.releaseState ?? this.store.get<any>('orca-operation', `release:${b.id}:${b.dispatchId}`)?.response?.result?.state) === 'retained')) reasons.push('A terminal was explicitly retained or user-owned')
    if (shared.some(t => { const plan = this.store.get<{goalId?: string}>('task-plan', t.id); return plan?.goalId && !this.store.get<{archived?: boolean}>('goal', plan.goalId)?.archived })) reasons.push('Persistent workline retains this directory until explicitly archived')
    if (directory && this.store.tickets.list().some(other => other.id !== ticketId && !other.ended && (projects.directory(other.id) === directory
      || projects.workspaces(other.id).some(workspace => workspace.directory === directory)
      || (projects.context(other.id) as {dependencies: {directory?: string; workspaces: {directory: string}[]}[]}).dependencies.some(d => d.directory === directory || d.workspaces.some(workspace => workspace.directory === directory))))) reasons.push('Another ticket references this workspace or its evidence')
    if (directory && this.store.list<Cleanup>('workspace-cleanup').some(c => c.directory === directory && c.state !== 'reset')) reasons.push('Saved cleanup attempt requires reconciliation or an explicit reset')
    let head: string | undefined, branch: string | undefined, status: string | undefined, terminals: unknown
    if (directory && existsSync(directory)) {
      try {
        const git = async (...args: string[]) => (await execute('git', ['-C', directory, ...args], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
        const common = (await execute('git', ['-C', target.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
        if (realpathSync(directory) === realpathSync(target.repository) || realpathSync(await git('rev-parse', '--path-format=absolute', '--git-common-dir')) !== realpathSync(common)) reasons.push('Workspace Git identity differs from the target')
        head = await git('rev-parse', 'HEAD'); branch = await git('symbolic-ref', '--short', 'HEAD')
        status = await git('status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching')
        if (status) reasons.push('Tracked, untracked or ignored files need preservation')
        const shown = await this.native(['worktree', 'show', '--worktree', `id:${owned?.id}`], target.repository)
        if (shown.worktree?.id !== owned?.id || shown.worktree?.path !== directory) reasons.push('Orca workspace identity changed')
        const listing = await this.native(['terminal', 'list', '--worktree', `id:${owned?.id}`, '--limit', '1000'], target.repository)
        terminals = listing.terminals
        if (!Array.isArray(listing.terminals) || listing.truncated || listing.terminals.length) reasons.push('Workspace terminals remain or cannot be fully enumerated')
      } catch (error) { reasons.push(String(error)) }
    } else reasons.push('Workspace directory is absent; reconcile its saved removal record')
    const referenceFingerprint = createHash('sha256').update(JSON.stringify({ticketId, directory, owned, target, head, branch, status, terminals, bindings})).digest('hex')
    if (unchanged() !== revision) reasons.push('Task or resource state changed during inspection; inspect again')
    const fingerprint = createHash('sha256').update(JSON.stringify({ ticketId, directory, owned, target, head, branch, status, terminals, bindings, reasons })).digest('hex')
    return { ticketId, directory, worktreeId: owned?.id, head, branch, eligible: reasons.length === 0, reasons, fingerprint, referenceFingerprint, observedAt: new Date().toISOString(), cleanup: this.store.get<Cleanup>('workspace-cleanup', ticketId) }
  }

  async references(ticketId: string, fingerprint: string, evidence: string, authorize: () => void): Promise<unknown> {
    authorize()
    const check = await this.inspect(ticketId)
    if (!evidence || check.referenceFingerprint !== fingerprint || !check.directory) throw new Error('Reference assessment requires the current inventory fingerprint and evidence file')
    const bytes = readFileSync(evidence), assessment = JSON.parse(bytes.toString('utf8'))
    if (assessment.directory !== check.directory || !Array.isArray(assessment.references)
      || !Array.isArray(assessment.checks) || !assessment.checks.length || assessment.checks.some((c: unknown) => typeof c !== 'string' || !c.trim())
      || !Number.isFinite(Date.parse(assessment.checkedAt)) || Date.parse(assessment.checkedAt) > Date.now())
      throw new Error('Evidence must name the exact directory, valid checkedAt, performed checks and a references array')
    authorize()
    const record = {ticketId, fingerprint, evidence: realpathSync(evidence), evidenceHash: createHash('sha256').update(bytes).digest('hex'), checkedAt: Date.parse(assessment.checkedAt)}
    this.store.put('workspace-reference-check', ticketId, record)
    return record
  }

  remove(ticketId: string, fingerprint: string, authorize: () => void): Promise<unknown> {
    if (this.active.has(ticketId)) throw new Error('Cleanup is already running')
    const work = this.perform(ticketId, fingerprint, authorize).finally(() => this.active.delete(ticketId))
    this.active.set(ticketId, work)
    return work
  }

  async reset(ticketId: string, fingerprint: string, authorize: () => void) {
    authorize()
    if (this.active.has(ticketId)) throw new Error('Cleanup is already running')
    const record = this.store.get<Cleanup>('workspace-cleanup', ticketId)
    if (!record || !['unknown','removing'].includes(record.state) || record.fingerprint !== fingerprint) throw new Error('Reset requires an unresolved saved cleanup fingerprint')
    const check = await this.inspect(ticketId)
    const target = this.store.get<TicketTarget>('ticket-target', ticketId)!
    const git = (await execute('git', ['-C', target.repository, 'worktree', 'list', '--porcelain'], {timeout:15_000})).stdout
    authorize()
    if (this.active.has(ticketId) || JSON.stringify(this.store.get('workspace-cleanup',ticketId)) !== JSON.stringify(record)
      || !record.referenceFingerprint || record.referenceFingerprint !== check.referenceFingerprint || !existsSync(record.directory)
      || !git.split('\n').filter(line => line.startsWith('worktree ')).some(line => existsSync(line.slice(9)) && realpathSync(line.slice(9)) === realpathSync(record.directory))
      || check.reasons.some(r => r !== 'Saved cleanup attempt requires reconciliation or an explicit reset')) throw new Error('Reset requires unchanged, intact Git and Orca inventory; preserve unresolved resources')
    const result = {...record, state:'reset' as const}
    this.store.put('workspace-cleanup',ticketId,result)
    return result
  }

  private async perform(ticketId: string, fingerprint: string, authorize: () => void) {
    authorize()
    const previous = this.store.get<Cleanup>('workspace-cleanup', ticketId)
    if (previous && previous.state !== 'reset') {
      if (previous.fingerprint !== fingerprint) throw new Error('Use the saved cleanup fingerprint to reconcile an attempted removal')
      return this.reconcile(previous)
    }
    const check = await this.inspect(ticketId)
    authorize()
    if (!check.eligible || check.fingerprint !== fingerprint || !check.directory) throw new Error('Cleanup blocked or inventory changed: ' + check.reasons.join('; '))
    const record: Cleanup = { ticketId, directory: check.directory, state: 'removing', fingerprint, referenceFingerprint: check.referenceFingerprint }
    this.store.put('workspace-cleanup', ticketId, record)
    try {
      const target = this.store.get<TicketTarget>('ticket-target', ticketId)!
      record.receipt = await this.native(['worktree', 'rm', '--worktree', `id:${check.worktreeId}`], target.repository)
      this.store.put('workspace-cleanup', ticketId, record)
      return await this.reconcile(record)
    } catch (error) {
      this.store.put('workspace-cleanup', ticketId, { ...record, state: 'unknown', error: String(error) })
      throw error
    }
  }

  private async reconcile(record: Cleanup) {
    const target = this.store.get<TicketTarget>('ticket-target', record.ticketId)!
    const native = await this.native(['worktree', 'list', '--repo', `path:${target.repository}`, '--limit', '1000'], target.repository)
    const git = (await execute('git', ['-C', target.repository, 'worktree', 'list', '--porcelain'], { timeout: 15_000 })).stdout
    if (!Array.isArray(native.worktrees) || native.truncated || existsSync(record.directory)
      || native.worktrees.some((w: any) => w.path === record.directory) || git.split('\n').includes(`worktree ${record.directory}`)) {
      this.store.put('workspace-cleanup', record.ticketId, { ...record, state: 'unknown' })
      throw new Error('Removal is unresolved; inspect before any further deletion')
    }
    const result = { ...record, state: 'removed' as const, error: undefined }
    this.store.put('workspace-cleanup', record.ticketId, result)
    return result
  }
}
