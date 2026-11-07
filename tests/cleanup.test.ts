import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Store } from '../src/store.ts'
import { Projects } from '../src/projects.ts'
import { WorkspaceCleanup } from '../src/cleanup.ts'

const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()) })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'osa-cleanup-')), repo = join(dir,'repo'), work = join(dir,'work'), cli = join(dir,'orca')
  const git = (...args: string[]) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe'}).trim()
  execFileSync('git',['init','-q',repo]); git('config','user.email','test@example.invalid'); git('config','user.name','Test')
  writeFileSync(join(repo,'.gitignore'),'ignored\n'); git('add','.'); git('commit','-qm','baseline'); git('worktree','add','-b','task',work)
  const store = new Store(join(dir,'state.db')), id = 'repo::'+work
  store.tickets.save({id:'t',title:'Task',mandate:{scope:'Task',strength:'explicit',policyVersion:'1',basis:{via:'listed'},actor:{source:'router',id:'owner'}},
    decisionId:'d',channels:[],inputs:[],undelivered:[],assignments:[{id:'a',state:'ended',createdAt:'now'}],createdAt:'now',updatedAt:'now',
    origin:{triggerId:'i',triggerIds:['i']},ended:{at:'now',by:'executor',outcome:'completed'},execution:{name:'task',directory:work,assignment:'Task'}})
  store.put('ticket-target','t',{ticketId:'t',projectId:'p',componentId:'c',locationId:'l',hostId:'local',kind:'git',repository:repo})
  store.put('project','p',{id:'p'}); store.put('component','c',{id:'c'}); store.put('location','l',{id:'l'})
  store.put('orca-assignment','a',{id:'a',ticketId:'t',finished:true,releaseState:'released'})
  store.put('orca-operation','worktree:t',{response:{ok:true,result:{worktree:{id,path:work}}}})
  store.put('workspace-baseline','t',{directory:work,revision:git('rev-parse','HEAD')})
  const state = join(dir,'native.json'); writeFileSync(state,JSON.stringify({terminals:[],removes:0}))
  writeFileSync(cli,`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2),p=${JSON.stringify(state)},s=JSON.parse(fs.readFileSync(p));
let result;
if(args[0]==='terminal') result={terminals:s.terminals};
else if(args[1]==='show') result={worktree:{id:${JSON.stringify(id)},path:${JSON.stringify(work)}}};
else if(args[1]==='list') result={worktrees:fs.existsSync(${JSON.stringify(work)})?[{id:${JSON.stringify(id)},path:${JSON.stringify(work)}}]:[]};
else if(args[1]==='rm') {if(s.fail)process.exit(18);if(args.includes('--force'))throw Error('force forbidden');cp.execFileSync('git',['-C',${JSON.stringify(repo)},'worktree','remove',${JSON.stringify(work)}]);s.removes++;result={removed:true,branchRetained:true};}
fs.writeFileSync(p,JSON.stringify(s));if(s.drop && args[1]==='rm')process.exit(17);
console.log(JSON.stringify({ok:true,result}));
`,{mode:0o700})
  clean.push(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  const gate = new WorkspaceCleanup(store,cli), evidence = join(dir,'references.json')
  writeFileSync(evidence,JSON.stringify({directory:work,checkedAt:new Date().toISOString(),checks:['Isolated test repository, no deployed services or external references'],references:[]}))
  await gate.references('t',(await gate.inspect('t')).referenceFingerprint,evidence,()=>{})
  return {dir,repo,work,store,gate,state,git,evidence}
}

test('cleanup preserves dirty and ignored artifacts and unresolved resources', async () => {
  const f=await fixture(); expect((await f.gate.inspect('t')).eligible).toBe(true)
  for(const name of ['untracked','ignored']) {
    writeFileSync(join(f.work,name),'preserve')
    const report=await f.gate.inspect('t');expect(report.eligible).toBe(false)
    await expect(f.gate.remove('t',report.fingerprint,()=>{})).rejects.toThrow('blocked')
    expect(existsSync(join(f.work,name))).toBe(true);rmSync(join(f.work,name))
  }
  f.store.put('orca-assignment','a',{id:'a',ticketId:'t',finished:true,releaseState:'retained'})
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('retained')
})

test('cleanup revalidates inventory and authorization, removes without force, and preserves audit records', async () => {
  const f=await fixture(), report=await f.gate.inspect('t')
  await expect(f.gate.remove('t',report.fingerprint,()=>{throw Error('Lease replaced')})).rejects.toThrow('Lease replaced')
  writeFileSync(join(f.work,'new'),'arrived after inventory')
  await expect(f.gate.remove('t',report.fingerprint,()=>{})).rejects.toThrow('blocked')
  rmSync(join(f.work,'new'))
  const current=await f.gate.inspect('t')
  expect(await f.gate.remove('t',current.fingerprint,()=>{})).toMatchObject({state:'removed',receipt:{branchRetained:true}})
  expect(existsSync(f.work)).toBe(false);expect(f.store.tickets.get('t')?.ended?.outcome).toBe('completed')
  expect(await f.gate.remove('t',current.fingerprint,()=>{})).toMatchObject({state:'removed'})
})

test('lost removal response reconciles inventory without issuing another deletion', async () => {
  const f=await fixture();writeFileSync(f.state,JSON.stringify({terminals:[],removes:0,drop:true}))
  const report=await f.gate.inspect('t')
  await expect(f.gate.remove('t',report.fingerprint,()=>{})).rejects.toThrow()
  expect(f.store.get<any>('workspace-cleanup','t').state).toBe('unknown')
  expect(await f.gate.remove('t',report.fingerprint,()=>{})).toMatchObject({state:'removed'})
})

test('cleanup retains unmerged commits, terminals and a continuing ticket reference', async () => {
  const f=await fixture();writeFileSync(join(f.work,'code'),'change');execFileSync('git',['-C',f.work,'add','.']);execFileSync('git',['-C',f.work,'commit','-qm','change'])
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('commits')
  writeFileSync(f.state,JSON.stringify({terminals:[{handle:'human'}],removes:0}))
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('terminals')
  const next={...f.store.tickets.get('t')!,id:'next',ended:undefined,execution:undefined}
  f.store.tickets.save(next);f.store.put('task-plan','next',{ticketId:'next',continueFrom:'t',dependsOn:[],resources:[],priority:0,createdAt:'now'})
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('references')
})

test('clean Git state cannot substitute for runtime reference evidence or release a persistent workline', async () => {
  const f = await fixture()
  f.store.delete('workspace-reference-check','t')
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('unverified')
  const check = await f.gate.inspect('t')
  writeFileSync(f.evidence, JSON.stringify({directory:f.work, checkedAt:new Date().toISOString(),checks:['systemd mounts'],references:['archive.service']}))
  await expect(f.gate.references('t',check.referenceFingerprint,f.evidence,()=>{})).rejects.toThrow('empty references')
  f.store.put('goal','g',{id:'g',name:'Recovery'})
  f.store.put('task-plan','t',{goalId:'g'})
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('Persistent workline')
})


test('failed-before-removal can be explicitly reset after intact inventory verification, then retried', async () => {
  const f=await fixture();writeFileSync(f.state,JSON.stringify({terminals:[],removes:0,fail:true}))
  const check=await f.gate.inspect('t')
  await expect(f.gate.remove('t',check.fingerprint,()=>{})).rejects.toThrow()
  expect((await f.gate.inspect('t')).eligible).toBe(false)
  expect(new Projects(f.store).blocked('t')).toContain('cleanup')
  await expect(f.gate.reset('t',check.fingerprint,()=>{throw Error('expired')})).rejects.toThrow('expired')
  writeFileSync(join(f.work,'preserve'),'changed')
  await expect(f.gate.reset('t',check.fingerprint,()=>{})).rejects.toThrow('unchanged')
  rmSync(join(f.work,'preserve'))
  expect(await f.gate.reset('t',check.fingerprint,()=>{})).toMatchObject({state:'reset'})
  expect(new Projects(f.store).blocked('t')).toBeUndefined()
  writeFileSync(f.state,JSON.stringify({terminals:[],removes:0}))
  expect(await f.gate.remove('t',(await f.gate.inspect('t')).fingerprint,()=>{})).toMatchObject({state:'removed'})
})

test('ended continuations inherit cleanup ownership without historical dependencies permanently retaining the directory', async () => {
  const f=await fixture(), next={...f.store.tickets.get('t')!,id:'next'}
  f.store.tickets.save(next); f.store.put('ticket-target','next',{...f.store.get<any>('ticket-target','t'),ticketId:'next'})
  f.store.put('task-plan','next',{ticketId:'next',continueFrom:'t',dependsOn:['t'],resources:[],priority:0,createdAt:'now'})
  f.store.put('orca-assignment','b',{id:'b',ticketId:'next',finished:true,releaseState:'released'})
  await f.gate.references('next',(await f.gate.inspect('next')).referenceFingerprint,f.evidence,()=>{})
  expect((await f.gate.inspect('next')).eligible).toBe(true)
  await f.gate.references('t',(await f.gate.inspect('t')).referenceFingerprint,f.evidence,()=>{})
  expect((await f.gate.inspect('t')).eligible).toBe(true)
  f.store.put('handoff','next',{ticketId:'next',evidence:f.work+'/result.txt'})
  expect((await f.gate.inspect('next')).eligible).toBe(false)
  f.store.delete('handoff','next')
  expect(await f.gate.remove('next',(await f.gate.inspect('next')).fingerprint,()=>{})).toMatchObject({state:'removed'})
  expect(existsSync(f.work)).toBe(false)
})
