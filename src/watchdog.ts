import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './store.ts'

type Event = { id: string; source: 'watchdog'; target: string; text: string; observedAt: string }

export function queueWatchdog(directory: string, target: string, identity: string, text: string): Event {
  if (!target.trim() || !identity.trim() || !text.trim() || text.length > 20_000) throw new Error('Invalid watchdog event')
  const id = createHash('sha256').update(JSON.stringify([target, identity])).digest('hex')
  const event: Event = { id, source: 'watchdog', target, text, observedAt: new Date().toISOString() }
  mkdirSync(directory, {recursive: true, mode: 0o700})
  const temporary = join(directory, randomUUID() + '.tmp')
  writeFileSync(temporary, JSON.stringify(event), {mode: 0o600})
  renameSync(temporary, join(directory, id + '.json'))
  return event
}

export function collectWatchdog(store: Store, directory: string): void {
  let files: string[]
  try { files = readdirSync(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  for (const file of files.filter(f => /^[0-9a-f]{64}\.json$/.test(f)).sort()) {
    const path = join(directory, file)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > 100_000) throw new Error('Invalid event file')
      const event = JSON.parse(readFileSync(path, 'utf8')) as Event
      if (event.id + '.json' !== file || event.source !== 'watchdog' || typeof event.target !== 'string' || !event.target || typeof event.text !== 'string' || !event.text || event.text.length > 20_000 || !Number.isFinite(Date.parse(event.observedAt))) throw new Error('Invalid event content')
      store.atomic(() => {
        if (store.get('watchdog-event', event.id)) return
        store.put('watchdog-event', event.id, event)
        store.put('notice', 'watchdog:' + event.id, {...event, id: 'watchdog:' + event.id, kind: 'watchdog'})
      })
      unlinkSync(path)
      store.delete('notice', 'watchdog-invalid:' + file)
      store.delete('watchdog-invalid',file)
    } catch {
      const stat = lstatSync(path), version = `${stat.mtimeMs}:${stat.size}`
      if (store.get('watchdog-invalid',file) !== version) store.atomic(() => {
        store.put('notice', 'watchdog-invalid:' + file, {id: 'watchdog-invalid:' + file, kind: 'watchdog', text: 'Watchdog event could not be imported; retained for inspection: ' + file})
        store.put('watchdog-invalid',file,version)
      })
    }
  }
}
