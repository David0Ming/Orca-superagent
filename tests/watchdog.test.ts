import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Store } from '../src/store.ts'
import { queueWatchdog, collectWatchdog } from '../src/watchdog.ts'

test('watchdog queues offline and replay cannot recreate an acknowledged notice or an owner request', () => {
  const dir = mkdtempSync(join(tmpdir(),'osa-watchdog-')), store = new Store(':memory:')
  try {
    const event = queueWatchdog(dir,'old-terminal','batch-1','Mailbox needs inspection')
    collectWatchdog(store,dir)
    expect(store.list('notice')).toMatchObject([{kind:'watchdog',source:'watchdog',target:'old-terminal'}])
    expect(store.list('core.trigger')).toEqual([])
    store.delete('notice','watchdog:'+event.id)
    writeFileSync(join(dir,event.id+'.json'),JSON.stringify(event))
    collectWatchdog(store,dir)
    expect(store.list('notice')).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    writeFileSync(join(dir,'a'.repeat(64)+'.json'),'{invalid')
    queueWatchdog(dir,'new-session','batch-2','Another independent observation')
    collectWatchdog(store,dir)
    expect(store.list('notice')).toHaveLength(2)
    expect(store.list('watchdog-event')).toHaveLength(2)
    store.delete('notice','watchdog-invalid:'+'a'.repeat(64)+'.json')
    collectWatchdog(store,dir)
    expect(store.list('notice')).toHaveLength(1)
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}) }
})

test('installer replaces terminal injection and queues even with no live terminal', () => {
  const dir = mkdtempSync(join(tmpdir(),'osa-watchdog-install-')), script = join(dir,'watchdog.sh')
  try {
    writeFileSync(script, `#!/bin/bash
nudge(){
  orca terminal send --terminal "$handle" --text "$msg" --enter
}

q ':'
while false; do
    if [ "\${terminals_ok:-0}" != 1 ]; then
      exit 0
    fi
done
`)
    execFileSync(process.execPath,['scripts/install-watchdog-queue.mjs',script])
    const installed = readFileSync(script,'utf8')
    expect(installed).not.toContain('terminal send')
    const functionText = installed.slice(installed.indexOf('nudge(){'),installed.indexOf('\nq '))
    const runner = join(dir,'exercise.sh')
    writeFileSync(runner, `#!/bin/bash\nset -eu\nDIR=${JSON.stringify(dir)}\nSTATE="$DIR/nudged"\nSTUCK_STATE="$DIR/stuck"\nhandle=gone\ncount=1\norphans=''\nstuck=''\nstuck_ids=''\nruns=run_test\ndispatches=''\nnow=9000\nDRY_RUN=0\ndetails='test observation'\nlog(){ :; }\nthrottled(){ return 1; }\n${functionText}\nnudge\n`)
    execFileSync('/bin/bash',[runner])
    writeFileSync(runner,readFileSync(runner,'utf8').replace('now=9000','now=18000'))
    execFileSync('/bin/bash',[runner])
    expect(readdirSync(join(dir,'events')).filter(f => f.endsWith('.json'))).toHaveLength(1)
    expect(readFileSync(join(dir,'nudged'),'utf8')).toContain('gone')
    execFileSync(process.execPath,['scripts/install-watchdog-queue.mjs',script])
    expect(readdirSync(dir).filter(f => f.includes('.before-osa-'))).toHaveLength(1)
    writeFileSync(script,readFileSync(script,'utf8').replace('queue v2','queue v1').replace('$runs|$dispatches|$stuck_ids', '$runs|$dispatches|$stuck_ids|$((now / 900))'))
    execFileSync(process.execPath,['scripts/install-watchdog-queue.mjs',script])
    expect(readFileSync(script,'utf8')).toContain('queue v2')
    expect(readFileSync(script,'utf8')).not.toContain('$((now / 900))')
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
