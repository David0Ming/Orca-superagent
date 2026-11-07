import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Store } from './store.ts'
import { sessionRpc } from './orca-session.ts'

const execute = promisify(execFile)
type Json = Record<string, any>
type Binding = { id: string; terminal: string; ptyId: string; incarnationId: string; worktreeId: string; executionHostId: string; runtimeId: string; boundAt: string; sessionId?: string; sessionTabId?: string }
type Wake = { id: string; bindingId: string; requestId: string; args: string[]; attempted?: boolean; receipt?: Json; error?: string; nextAttemptAt?: number }

/** Persist attention through the native inbox; Orca controls how its wake hint is presented. */
export class RouterWake {
  private ticking?: Promise<void>
  private nextHealthAt = 0
  constructor(private readonly store: Store, private readonly options: { cli: string; repository: string; osaCommand: string; sessionRpc?: typeof sessionRpc }) {}

  private async cli(args: string[]): Promise<Json> {
    // The service uses its own sender anchor, not the agent session that launched it.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ORCA_')))
    let stdout: string
    try { ({ stdout } = await execute(this.options.cli, [...args, '--json', ...(args[0] === 'orchestration' ? ['--full'] : [])], { cwd: this.options.repository, env, timeout: 15_000, maxBuffer: 2_000_000 })) }
    catch (error) { stdout = (error as {stdout?: string}).stdout ?? ''; if (!stdout.trim()) throw error }
    const response = JSON.parse(stdout)
    if (response?.ok !== true || !response.result) throw new Error(`Orca ${response?.error?.code ?? 'invalid response'}: ${response?.error?.message ?? 'missing result'}`)
    return response
  }

  private async identity(terminal: string, sessionId?: string): Promise<Omit<Binding, 'id' | 'boundAt'>> {
    const response = await this.cli(['terminal', 'show', '--terminal', terminal])
    const t = response.result.terminal
    if (!t || t.handle !== terminal || !t.connected || t.orphaned || t.executionHostId !== 'local'
      || (!sessionId && !t.agentIdentity) || !t.worktreePath || realpathSync(t.worktreePath) !== realpathSync(this.options.repository)) throw new Error('Router requires an exact live local agent terminal in this repository')
    for (const key of ['ptyId', 'incarnationId', 'worktreeId']) if (typeof t[key] !== 'string' || !t[key]) throw new Error(`Orca omitted terminal ${key}`)
    if (!response._meta?.runtimeId) throw new Error('Orca omitted runtime identity')
    let sessionTabId: string | undefined
    if (sessionId) {
      const rpc = this.options.sessionRpc ?? sessionRpc
      const tabs = await rpc('session.tabs.list', { worktree: `path:${this.options.repository}` })
      const tab = tabs.result?.tabs?.find((tab: Json) => tab.type === 'agent-session' && tab.sessionId === sessionId)
      if (!tab || tabs.result.worktree !== t.worktreeId || tabs._meta?.runtimeId !== response._meta.runtimeId) throw new Error('Router structured session does not belong to this live workspace')
      const history = await rpc('agentSession.history', { sessionId, direction: 'tail', limit: 1 })
      if (!history.result?.ok || history.result.page?.sessionId !== sessionId || history._meta?.runtimeId !== response._meta.runtimeId) throw new Error('Router structured session is unavailable')
      sessionTabId = tab.id
    }
    return { terminal, ptyId: t.ptyId, incarnationId: t.incarnationId, worktreeId: t.worktreeId, executionHostId: t.executionHostId, runtimeId: response._meta.runtimeId, ...(sessionId ? {sessionId, sessionTabId} : {}) }
  }

  async bind(terminal: string, authorize: () => void = () => {}, sessionId?: string): Promise<Binding> {
    if (!terminal) throw new Error('Explicit Router terminal is required')
    const identity = await this.identity(terminal, sessionId)
    authorize()
    const previous = this.store.get<Binding>('router', 'terminal')
    if (previous && previous.sessionId === sessionId && Object.entries(identity).every(([key, value]) => previous[key as keyof Binding] === value)) return previous
    const binding = { ...identity, id: randomUUID(), boundAt: new Date().toISOString() }
    this.store.put('router', 'terminal', binding)
    return binding
  }

  unbind(): void { this.store.delete('router', 'terminal') }
  status(): unknown {
    const binding = this.store.get<Binding>('router', 'terminal')
    return { binding: binding ?? null, health: this.store.get('router', 'health') ?? null, attention: this.store.get('router', 'attention') ?? null }
  }

  tick(): Promise<void> { return this.ticking ??= this.runTick().finally(() => { this.ticking = undefined }) }

  private async runTick(): Promise<void> {
    const binding = this.store.get<Binding>('router', 'terminal')
    if (!binding) return
    if (!binding.sessionId) {
      this.store.put('router', 'health', {bindingId: binding.id, state: 'migration-required', observedAt: Date.now()})
      this.store.put('notice', 'router-wake', {id: 'router-wake', text: 'Background delivery requires a structured Router session. Pending work is retained; terminal input will not be used.'})
      return
    }
    const pending = {
      candidates: this.store.list<Json>('candidate'),
      messages: this.store.list<Json>('outbox').filter(m => m.status === 'pending' && m.channel?.source === 'router'),
      notices: (this.store.routerNotices() as Json[]).filter(n => n.id !== 'router-wake'),
    }
    if (!Object.values(pending).some(items => items.length)) {
      const attention = this.store.get<{ wakeId: string }>('router', 'attention')
      if (!attention || this.store.get<Wake>('router-wake', attention.wakeId)?.receipt) this.store.delete('router', 'attention')
      return
    }
    const keys = Object.entries(pending).flatMap(([kind, items]) => items.map(item => createHash('sha256').update(JSON.stringify([kind, Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'observedAt'))])).digest('hex')))
    const fingerprint = createHash('sha256').update(JSON.stringify(keys)).digest('hex')
    const active = this.store.get<{ fingerprint: string; bindingId: string; wakeId: string; keys?: string[]; createdAt?: number }>('router', 'attention')
    let wake = active?.bindingId === binding.id ? this.store.get<Wake>('router-wake', active.wakeId) : undefined
    // Finish uncertain attention before considering newer work; never replace its request ID.
    const added = active?.keys ? keys.some(key => !active.keys!.includes(key)) : active?.fingerprint !== fingerprint
    const elapsed = Date.now() - (active?.createdAt ?? 0)
    if (!wake || (wake.receipt && ((added && elapsed >= 15_000) || elapsed >= 5 * 60_000))) {
      wake = { id: randomUUID(), bindingId: binding.id, requestId: randomUUID(), args: [
        'orchestration', 'send', '--from', binding.terminal, '--to', `orca_session_id:${binding.sessionId}`, '--type', 'status',
        '--subject', 'OSA pending Router work', '--body', `Pending OSA work is available. At your next safe checkpoint run ${this.options.osaCommand} router wait --timeout 0 with your current lease. After service updates, read the current skills/super-agent-router/SKILL.md before routing. Only if you have no lease, run router attach first. Preserve the single Router lease; if another owner holds it, leave work pending. Process the current work, then yield for native events. This attention is not a routing decision.`,
      ] }
      this.store.atomic(() => {
        this.store.put('router-wake', wake!.id, wake)
        this.store.put('router', 'attention', { bindingId: binding.id, fingerprint, keys, createdAt: Date.now(), wakeId: wake!.id })
      })
    }
    if ((wake.receipt && this.nextHealthAt > Date.now()) || (!wake.receipt && (wake.nextAttemptAt ?? 0) > Date.now())) return
    this.nextHealthAt = Date.now() + 15_000
    try {
      const identity = await this.identity(binding.terminal, binding.sessionId)
      if (!Object.entries(identity).every(([key, value]) => binding[key as keyof Binding] === value)) throw new Error('Router terminal identity changed; explicitly rebind')
      if (this.store.get<Binding>('router', 'terminal')?.id !== binding.id) return
      this.store.put('router', 'health', { bindingId: binding.id, observedAt: Date.now(), state: 'connected' })
      this.store.delete('notice', 'router-wake')
      if (wake.receipt) return
      if (wake.attempted) {
        const request = (await this.cli(['orchestration', 'request-show', '--request', wake.requestId])).result
        if (request.state === 'completed' && request.receipt) wake.receipt = request.receipt
        // Same runtime/terminal identity was checked above. Reuse the request ID for this harmless wake hint.
        else if (!['pending', 'absent'].includes(request.state)) throw new Error('Router attention receipt is uncertain; inspect before rebinding or retrying')
      }
      if (!wake.receipt) {
        if (this.store.get<Binding>('router', 'terminal')?.id !== binding.id) return
        wake.attempted = true
        this.store.put('router-wake', wake.id, wake)
        wake.receipt = (await this.cli([...wake.args, '--retry-request', wake.requestId])).result
      }
      if (typeof wake.receipt?.message?.id !== 'string' || !wake.receipt.message.id) {
        delete wake.receipt
        throw new Error('Orca omitted durable Router message receipt; inspect request before retrying')
      }
      delete wake.error
      delete wake.nextAttemptAt
      this.store.delete('notice', 'router-wake')
    } catch (error) {
      this.store.put('router', 'health', { bindingId: binding.id, observedAt: Date.now(), state: 'unavailable', error: String(error) })
      wake.error = String(error)
      wake.nextAttemptAt = Date.now() + 15_000
      this.store.put('notice', 'router-wake', { id: 'router-wake', text: wake.error })
    }
    this.store.put('router-wake', wake.id, wake)
  }
}
