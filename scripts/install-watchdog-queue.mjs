import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

// Install only the known nudge implementation, preserving the watchdog's detection logic.
const target = resolve(process.argv[2] ?? join(homedir(), '.orca/watchdog/orca-mailbox-watchdog.sh'))
const original = readFileSync(target, 'utf8')
if (original.includes('# OSA background event queue v2')) { console.log('Already installed'); process.exit(0) }
const start = original.indexOf('nudge(){\n'), end = original.indexOf('\n}\n\nq ', start)
if (start < 0 || end < 0 || !original.slice(start,end).includes('terminal send --terminal "$handle" --text "$msg" --enter') && !original.slice(start,end).includes('# OSA background event queue v1')) throw new Error('Unknown watchdog nudge; inspect before modifying')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const helper = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/osa-watchdog.ts')
const body = `nudge(){
  # OSA background event queue v2: never write into a terminal or submit a human draft.
  [ -n "$handle" ] || return 0
  { [ "$count" -gt 0 ] || [ -n "$orphans" ] || [ -n "$stuck" ]; } || return 0
  throttled "$handle" && return 0
  local msg identity err
  msg="[orca 看门狗] 系统观察；不是人工授权。目标：$handle"
  [ "$count" -eq 0 ] || msg="$msg
未读报告：$details"
  [ -z "$orphans" ] || msg="$msg
疑似完成未上报：$orphans"
  [ -z "$stuck" ] || msg="$msg
未确认批次：$stuck"
  identity="$runs|$dispatches|$stuck_ids"
  if [ "$DRY_RUN" = 1 ]; then
    log "WOULD_QUEUE pane=$handle runs=$runs dispatches=$dispatches"
    printf '  → %s\\n' "$msg"
  elif err=$(printf '%s' "$msg" | ${quote(process.execPath)} --experimental-transform-types ${quote(helper)} "$DIR/events" "$handle" "$identity" 2>&1); then
    log "QUEUED pane=$handle runs=$runs dispatches=$dispatches"
    [ -z "$stuck_ids" ] || printf '%s\\n' "$stuck_ids" >> "$STUCK_STATE"
    printf '%s\\t%s\\n' "$handle" "$now" >> "$STATE"
  else
    log "QUEUE_FAILED pane=$handle — event retained by detector; will retry"
  fi
}`
let updated = original.slice(0,start) + body + original.slice(end+2)
// A missing terminal snapshot cannot suppress durable backlog/stuck observations.
const marker = '    if [ "${terminals_ok:-0}" != 1 ]; then'
if (!updated.includes(marker) && !updated.includes('if [ "${terminals_ok:-0}" != 1 ] && [ "$kind" = orphan ]; then')) throw new Error('Unknown terminal observation guard')
if (updated.includes(marker)) {
  const guardStart = updated.indexOf(marker), guardEnd = updated.indexOf('\n    fi', guardStart)
  if (guardEnd < 0 || updated.slice(guardStart + marker.length,guardEnd).split('\n').filter(line => !line.trim().startsWith('#')).some(line => /\b(if|fi|then)\b/.test(line))) throw new Error('Unknown nested terminal observation guard; inspect before modifying')
  updated = updated.slice(0,guardStart) + '    if [ "${terminals_ok:-0}" != 1 ] && [ "$kind" = orphan ]; then\n      continue\n    fi' + updated.slice(guardEnd+7)
}
const temporary = target + '.osa-new'
writeFileSync(temporary,updated,{mode:0o700})
execFileSync('/bin/bash',['-n',temporary])
const backup = target + '.before-osa-' + Date.now()
copyFileSync(target,backup)
renameSync(temporary,target)
console.log(JSON.stringify({installed:target,backup,events:join(dirname(target),'events')}))
