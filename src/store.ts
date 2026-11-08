import { DatabaseSync } from 'node:sqlite'
import { key, latestAssignment, type Repositories, type Thread, type Ticket, type Decision } from '../vendor/dsh-core/src/index.ts'

export class Store implements Repositories {
  readonly db: DatabaseSync
  private depth = 0

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS records (
          sequence INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          value TEXT NOT NULL,
          UNIQUE (kind, id)
        );
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void { this.db.close() }

  atomic<T>(work: () => T): T {
    const savepoint = `store_${this.depth}`
    const nested = this.depth > 0
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = work()
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
      return result
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }

  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind = ? AND id = ?').get(kind, id)
    return row ? JSON.parse(row.value as string) : undefined
  }

  put(kind: string, id: string, value: unknown): void {
    const json = JSON.stringify(value)
    if (json === undefined) throw new TypeError('Record must be JSON serializable')
    this.db.prepare(`INSERT INTO records (kind, id, value) VALUES (?, ?, ?)
      ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value`).run(kind, id, json)
  }

  list<T>(kind: string): T[] {
    // shortcut: personal-scale aggregates scan one kind; add indexed columns when history makes scans costly.
    return this.db.prepare('SELECT value FROM records WHERE kind = ? ORDER BY sequence').all(kind)
      .map(row => JSON.parse(row.value as string))
  }

  delete(kind: string, id: string): void {
    this.db.prepare('DELETE FROM records WHERE kind = ? AND id = ?').run(kind, id)
  }

  routerNotices(): unknown[] {
    return [...this.list<{archivedAt?:string}>('notice').filter(item => !item.archivedAt), ...this.tickets.list().flatMap(ticket => {
      const assignment = latestAssignment(ticket)
      const held = assignment && this.get<{inputIds?:string[]}>('execution-hold', assignment.id)
      if (held) {
        const fresh = ticket.inputs.filter(input => !(held.inputIds ?? []).includes(input.id))
        return fresh.length ? [{id:`held-inputs:${ticket.id}:${fresh.map(input=>input.id).join(',')}`,ticketId:ticket.id,kind:'inputs',text:'旧执行已隔离；收到新输入，请核对最新要求与现状，不能自动重放旧动作。',inputIds:fresh.map(input=>input.id)}] : []
      }
      const binding = assignment && this.get<{settled?: string; finished?: boolean}>('orca-assignment', assignment.id)
      const pending = ticket.inputs.filter(input => input.kind === 'trigger' && input.human && !input.context && !input.readAt)
      return [
        ...(!ticket.ended && pending.length && (binding?.settled || binding?.finished) && Date.now() - Date.parse(pending[0].at) >= 120_000
          ? [{ id: `inputs:${ticket.id}:${pending.map(i => i.id).join(',')}`, ticketId: ticket.id, kind: 'inputs', text: 'Execution ended with unread inputs.', inputIds: pending.map(i => i.id) }] : []),
        ...(!ticket.ended && ticket.attention && !this.get('outbox', key('attention-reply', ticket.attention.id))
          ? [{ id: ticket.attention.id, ticketId: ticket.id, kind: 'attention', text: ticket.attention.question }] : []),
        ...(ticket.answers ?? []).map(triggerId => ({ id: `answer:${ticket.id}:${triggerId}`, ticketId: ticket.id, triggerId, kind: 'answer', text: this.get<{summary: string}>('answer', key('answer', ticket.id, triggerId))?.summary })),
    ] })]
  }

  readonly triggers: Repositories['triggers'] = {
    get: id => this.get('core.trigger', id),
    save: trigger => { this.put('core.trigger', trigger.id, trigger) },
    disposition: id => this.get('core.disposition', id),
    saveDisposition: (id, value) => { this.put('core.disposition', id, value) },
  }

  // shortcut: repository filters scan each kind; add indexed projections if personal data volume outgrows this.
  readonly threads: Repositories['threads'] = {
    get: key => this.get('core.thread', key),
    save: thread => { this.put('core.thread', thread.key, thread) },
    list: () => this.list<Thread>('core.thread'),
    active: () => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
  }

  readonly tickets: Repositories['tickets'] = {
    get: id => this.get('core.ticket', id),
    save: ticket => { this.put('core.ticket', ticket.id, ticket) },
    list: () => this.list<Ticket>('core.ticket').reverse(),
    open: () => this.tickets.list().filter(ticket => !ticket.ended),
    active: () => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
  }

  readonly decisions: Repositories['decisions'] = {
    get: id => this.get('core.decision', id),
    save: decision => { this.put('core.decision', decision.id, decision) },
    byThread: key => this.list<Decision>('core.decision').filter(decision => decision.threadKey === key),
  }
}
