import { readFileSync } from 'node:fs'
import { queueWatchdog } from '../src/watchdog.ts'

const [directory, target, identity] = process.argv.slice(2)
if (!directory || !target || !identity) throw new Error('Usage: osa-watchdog.ts EVENTS_DIRECTORY TARGET EVENT_ID; message on stdin')
const event = queueWatchdog(directory, target, identity, readFileSync(0, 'utf8'))
console.log(JSON.stringify({queued: true, id: event.id}))
