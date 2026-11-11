import { expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configAt, launchAgent, retryDelay } from '../scripts/osa-supervisor.mjs'

test('restart backoff is capped and does not become a hot loop', () => {
  expect([1, 2, 3, 4, 5, 6, 1000].map(retryDelay)).toEqual([15000, 30000, 60000, 120000, 240000, 300000, 300000])
})

test('config requires exact paths and cannot override the managed state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-supervisor-config-')), path = join(dir, 'config.json')
  const valid = { state: dir, runtimeFile: join(dir, 'runtime'), orcaExecutable: process.execPath, serveArgs: ['--repository', dir] }
  try {
    writeFileSync(path, JSON.stringify(valid))
    expect(configAt(path)).toEqual(valid)
    for (const invalid of [{ state: 'relative' }, { serveArgs: ['--repository'] }, { serveArgs: ['--repository', dir, '--state', dir] }, { serveArgs: ['--repository', 'relative'] }]) {
      writeFileSync(path, JSON.stringify({ ...valid, ...invalid }))
      expect(() => configAt(path)).toThrow()
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('LaunchAgent uses native supervision and escapes paths without shell interpolation', () => {
  const xml = launchAgent('/tmp/a & <b> "config".json', '/tmp/log space')
  expect(xml).toContain('/tmp/a &amp; &lt;b&gt; &quot;config&quot;.json')
  expect(xml).toContain('<key>RunAtLoad</key><false/>')
  expect(xml).not.toContain('<key>KeepAlive</key>')
  expect(xml).toContain('<key>ThrottleInterval</key><integer>30</integer>')
  expect(xml).toContain('<key>ProgramArguments</key>')
  expect(xml).not.toContain('/bin/sh')
})


test('restart reads updated launch arguments without changing the managed identity', () => {
  const dir=mkdtempSync(join(tmpdir(),'osa-config-reload-')), path=join(dir,'config.json')
  const original={state:dir,runtimeFile:join(dir,'runtime'),orcaExecutable:process.execPath,serveArgs:['--repository',dir,'--max-executors','2']}
  try {
    writeFileSync(path,JSON.stringify(original))
    const loaded=configAt(path)
    writeFileSync(path,JSON.stringify({...original,serveArgs:['--repository',dir,'--max-executors','6','--executor-model','gpt-6.1-terra']}))
    expect(configAt(path,loaded).serveArgs).toContain('6')
    expect(configAt(path,loaded).serveArgs).toContain('gpt-6.1-terra')
    writeFileSync(path,JSON.stringify({...original,state:join(dir,'other')}))
    expect(()=>configAt(path,loaded)).toThrow('identity paths changed')
  } finally {rmSync(dir,{recursive:true,force:true})}
})
