import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRepositories, type Decision, type Thread, type Ticket, type Trigger } from '../vendor/dsh-core/src/index.ts'
import { Store } from '../src/store.ts'

const at = '2026-11-02T00:00:00.000Z'
const actor = { source: 'router', id: 'owner' }
const mandate: Ticket['mandate'] = { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor, scope: 'test' }
const trigger: Trigger = { id: 'trigger', source: 'router', threads: [actor], actor, human: true, at, text: 'test', meta: {} }
const disposition = { fanout: ['ticket'], at }
function thread(key: string, overrides: Partial<Thread> = {}): Thread {
  return { key, ref: { source: 'router', id: key }, createdAt: at, subscriptions: [], correlated: [], pending: [], meta: {}, ...overrides }
}
function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return { id, title: id, decisionId: 'decision', mandate, channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: at, updatedAt: at, origin: { triggerId: trigger.id, triggerIds: [trigger.id] }, ...overrides }
}
function decision(id: string, threadKey = 'thread'): Decision {
  return { id, threadKey, evalId: 'eval', triggerIds: [trigger.id], policyVersion: 'v1', at, kind: 'ignore', reason: [], strength: 'explicit' }
}

describe('Store', () => {
  let directory: string
  let path: string
  let store: Store
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'osa-store-'))
    path = join(directory, 'state.sqlite')
    store = new Store(path)
  })
  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('persists all repositories and adapter records across reopen', () => {
    store.atomic(() => {
      store.triggers.save(trigger)
      store.triggers.saveDisposition(trigger.id, disposition)
      store.threads.save(thread('thread'))
      store.tickets.save(ticket('ticket'))
      store.decisions.save(decision('decision'))
      store.put('outbox', 'reply', { text: 'ready', sent: false })
    })
    store.close()
    store = new Store(path)
    expect(store.triggers.get(trigger.id)).toEqual(trigger)
    expect(store.triggers.disposition(trigger.id)).toEqual(disposition)
    expect(store.threads.get('thread')).toEqual(thread('thread'))
    expect(store.tickets.get('ticket')).toEqual(ticket('ticket'))
    expect(store.decisions.get('decision')).toEqual(decision('decision'))
    expect(store.get('outbox', 'reply')).toEqual({ text: 'ready', sent: false })
    expect(store.triggers.get('missing')).toBeUndefined()
    expect(store.triggers.disposition('missing')).toBeUndefined()
    expect(store.threads.get('missing')).toBeUndefined()
    expect(store.tickets.get('missing')).toBeUndefined()
    expect(store.decisions.get('missing')).toBeUndefined()
  })

  it('matches MemoryRepositories ordering and filters, including updates', () => {
    const memory = new MemoryRepositories()
    for (const repo of [memory, store]) {
      repo.threads.save(thread('idle'))
      repo.threads.save(thread('queued', { pending: ['trigger'] }))
      repo.threads.save(thread('evaluating', { evaluating: { id: 'eval', threadKey: 'evaluating', triggerIds: [],
        strength: 'explicit', actor, basis: mandate.basis, policyVersion: 'v1', startedAt: at, deadline: at } }))
      repo.threads.save(thread('idle', { meta: { updated: true } }))
      repo.tickets.save(ticket('idle'))
      repo.tickets.save(ticket('pending', { assignments: [{ id: 'a', state: 'pending', createdAt: at }] }))
      repo.tickets.save(ticket('running', { assignments: [{ id: 'a', state: 'running', createdAt: at }] }))
      repo.tickets.save(ticket('ended', { assignments: [{ id: 'a', state: 'running', createdAt: at }, { id: 'b', state: 'ended', createdAt: at }],
        ended: { at, by: 'human', outcome: 'stopped' } }))
      repo.tickets.save(ticket('undelivered', { undelivered: ['input'], ended: { at, by: 'executor', outcome: 'completed' } }))
      repo.tickets.save(ticket('idle', { title: 'updated', createdAt: '2099-01-01T00:00:00Z' }))
      repo.decisions.save(decision('first'))
      repo.decisions.save(decision('other', 'other-thread'))
      repo.decisions.save(decision('last'))
      repo.decisions.save({ ...decision('first'), dismissed: true })
    }
    store.close()
    store = new Store(path)
    expect(store.threads.list()).toEqual(memory.threads.list())
    expect(store.threads.active()).toEqual(memory.threads.active())
    expect(store.tickets.list()).toEqual(memory.tickets.list())
    expect(store.tickets.open()).toEqual(memory.tickets.open())
    expect(store.tickets.active()).toEqual(memory.tickets.active())
    expect(store.decisions.byThread('thread')).toEqual(memory.decisions.byThread('thread'))
    expect(store.decisions.byThread('missing')).toEqual([])
  })

  it('rolls back domain and adapter inserts, updates and deletes together', () => {
    store.triggers.save(trigger)
    store.put('outbox', 'existing', { text: 'keep' })
    const failure = new Error('abort')
    expect(() => store.atomic(() => {
      store.triggers.save({ ...trigger, text: 'changed' })
      store.triggers.saveDisposition(trigger.id, disposition)
      store.threads.save(thread('thread'))
      store.tickets.save(ticket('ticket'))
      store.decisions.save(decision('decision'))
      store.delete('outbox', 'existing')
      store.put('outbox', 'new', { text: 'discard' })
      throw failure
    })).toThrow(failure)
    expect(store.triggers.get(trigger.id)).toEqual(trigger)
    expect(store.triggers.disposition(trigger.id)).toBeUndefined()
    expect(store.threads.list()).toEqual([])
    expect(store.tickets.list()).toEqual([])
    expect(store.decisions.byThread('thread')).toEqual([])
    expect(store.list('outbox')).toEqual([{ text: 'keep' }])
    expect(store.atomic(() => 'still usable')).toBe('still usable')
  })

  it('can catch a nested rollback and commit the outer transaction', () => {
    expect(store.atomic(() => {
      store.put('outbox', 'outer', { text: 'outer' })
      expect(() => store.atomic(() => {
        store.delete('outbox', 'outer')
        store.tickets.save(ticket('discard'))
        throw new Error('inner')
      })).toThrow('inner')
      store.atomic(() => store.tickets.save(ticket('keep')))
      return 42
    })).toBe(42)
    store.close()
    store = new Store(path)
    expect(store.list('outbox')).toEqual([{ text: 'outer' }])
    expect(store.tickets.list().map(row => row.id)).toEqual(['keep'])
  })

  it('rolls back released nested savepoints when the outer transaction fails', () => {
    expect(() => store.atomic(() => {
      store.atomic(() => {
        store.triggers.save(trigger)
        store.atomic(() => store.put('outbox', 'reply', { text: 'discard' }))
      })
      throw new Error('outer')
    })).toThrow('outer')
    expect(store.triggers.get(trigger.id)).toBeUndefined()
    expect(store.list('outbox')).toEqual([])
    store.atomic(() => store.put('outbox', 'next', 'ok'))
    expect(store.get('outbox', 'next')).toBe('ok')
  })

  it('isolates kinds, binds keys safely and preserves insertion order on upsert', () => {
    const kind = "outbox'); DROP TABLE records; --"
    store.put(kind, 'same', { value: 1 })
    store.put(kind, 'second', null)
    store.put('other', 'same', false)
    store.put(kind, 'same', { value: 2 })
    expect(store.list(kind)).toEqual([{ value: 2 }, null])
    store.delete(kind, 'same')
    store.delete(kind, 'missing')
    store.put(kind, 'same', { value: 3 })
    expect(store.list(kind)).toEqual([null, { value: 3 }])
    expect(store.get('other', 'same')).toBe(false)
    expect(store.get(kind, 'missing')).toBeUndefined()
    expect(() => store.put(kind, 'same', undefined)).toThrow(TypeError)
    expect(() => store.put(kind, 'same', 1n)).toThrow(TypeError)
    expect(store.get(kind, 'same')).toEqual({ value: 3 })
  })

  it('does not retain mutable references to stored or returned records', () => {
    const value = { nested: { count: 1 } }
    store.put('adapter', 'id', value)
    value.nested.count = 2
    store.get<typeof value>('adapter', 'id')!.nested.count = 3
    store.list<typeof value>('adapter')[0]!.nested.count = 4
    expect(store.get('adapter', 'id')).toEqual({ nested: { count: 1 } })
    const row = thread('thread')
    store.threads.save(row)
    row.pending.push('unsaved')
    store.threads.get(row.key)!.pending.push('also unsaved')
    expect(store.threads.list()[0]!.pending).toEqual([])
  })

  it('keeps routine progress quiet and flags unread inputs only after execution settled', () => {
    const row = ticket('work', { assignments: [{id:'worker',state:'running',createdAt:at,report:{state:'progress',summary:'Reading files',at}}],
      inputs:[{id:'followup',kind:'trigger',triggerId:'question',human:true,at}], undelivered:['followup'] })
    store.tickets.save(row)
    expect(store.routerNotices()).toEqual([])
    row.assignments[0].report = {state:'waiting',summary:'Waiting for child work',at}
    store.tickets.save(row)
    expect(store.routerNotices()).toEqual([])
    store.put('orca-assignment', 'worker', {settled:'done'})
    expect(store.routerNotices()).toEqual([expect.objectContaining({kind:'inputs',inputIds:['followup']})])
    store.put('input-resolution', 'followup', {summary:'Handled'})
    expect(store.routerNotices()).toEqual([])
  })
})
