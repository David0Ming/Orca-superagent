import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
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
else if(args[1]==='rm') {if(s.fail)process.exit(18);if(args.includes('--force')||args.includes('--delete-branch'))throw Error('forced removal or branch deletion forbidden');cp.execFileSync('git',['-C',${JSON.stringify(repo)},'worktree','remove',${JSON.stringify(work)}]);s.removes++;result={removed:true,branchRetained:true};}
fs.writeFileSync(p,JSON.stringify(s));if(s.drop && args[1]==='rm')process.exit(17);
console.log(JSON.stringify({ok:true,result}));
`,{mode:0o700})
  clean.push(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  const gate = new WorkspaceCleanup(store,cli), evidence = join(dir,'references.json')
  writeFileSync(evidence,JSON.stringify({directory:work,checkedAt:new Date().toISOString(),checks:['Isolated test repository, no deployed services or external references'],references:[]}))
  return {dir,repo,work,store,gate,state,git,evidence}
}

test('cleanup preserves dirty and ignored artifacts and unresolved resources', async () => {
  const f=await fixture(); expect((await f.gate.inspect('t')).eligible).toBe(true)
  for(const name of ['.gitignore','untracked','ignored']) {
    writeFileSync(join(f.work,name),'preserve')
    const report=await f.gate.inspect('t');expect(report.eligible).toBe(false)
    await expect(f.gate.remove('t',report.fingerprint,()=>{})).rejects.toThrow('blocked')
    expect(existsSync(join(f.work,name))).toBe(true)
    if (name === '.gitignore') writeFileSync(join(f.work,name),'ignored\n')
    else rmSync(join(f.work,name))
  }
  f.store.put('orca-assignment','a',{id:'a',ticketId:'t',finished:true,releaseState:'retained'})
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('retained')
})

test('cleanup preserves unowned worktrees and open tickets with unresolved executors', async () => {
  const f = await fixture(), owned = f.store.get<any>('orca-operation','worktree:t')
  f.store.delete('orca-operation','worktree:t')
  let check = await f.gate.inspect('t')
  expect(check.reasons.join(' ')).toContain('Not a ticket-owned isolated worktree')
  await expect(f.gate.remove('t',check.fingerprint,()=>{})).rejects.toThrow('blocked')
  f.store.put('orca-operation','worktree:t',owned)
  f.store.tickets.save({...f.store.tickets.get('t')!,ended:undefined})
  f.store.put('orca-assignment','a',{id:'a',ticketId:'t',finished:false})
  check = await f.gate.inspect('t')
  expect(check.reasons).toContain('Business ticket is still open')
  expect(check.reasons).toContain('Executor resources are unresolved')
  await expect(f.gate.remove('t',check.fingerprint,()=>{})).rejects.toThrow('blocked')
  expect(existsSync(f.work)).toBe(true)
  expect(JSON.parse(readFileSync(f.state,'utf8')).removes).toBe(0)
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
  expect(JSON.parse(readFileSync(f.state,'utf8')).removes).toBe(1)
})

test('cleanup retains terminals and a continuing ticket reference', async () => {
  const f=await fixture()
  writeFileSync(f.state,JSON.stringify({terminals:[{handle:'human'}],removes:0}))
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('terminals')
  const next={...f.store.tickets.get('t')!,id:'next',ended:undefined,execution:undefined}
  f.store.tickets.save(next);f.store.put('task-plan','next',{ticketId:'next',continueFrom:'t',dependsOn:[],resources:[],priority:0,createdAt:'now'})
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('references')
})

test('explicit cleanup removes committed worktrees without baseline or reference proof and retains the branch', async () => {
  const f = await fixture()
  writeFileSync(join(f.work,'code'),'committed result')
  execFileSync('git',['-C',f.work,'add','.'])
  execFileSync('git',['-C',f.work,'commit','-qm','result'])
  const head = execFileSync('git',['-C',f.work,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
  expect((await f.gate.inspect('t')).eligible).toBe(true)
  f.store.delete('workspace-baseline','t')
  f.store.put('knowledge','k',{summary:'Historical result at '+f.work})
  f.store.put('handoff','t',{ticketId:'t',evidence:f.work+'/code'})
  const check = await f.gate.inspect('t')
  expect(check.eligible).toBe(true)
  expect(await f.gate.remove('t',check.fingerprint,()=>{})).toMatchObject({state:'removed',receipt:{branchRetained:true}})
  expect(existsSync(f.work)).toBe(false)
  expect(f.git('rev-parse','task')).toBe(head)
  expect(f.git('show','task:code')).toBe('committed result')
  expect(f.store.get<any>('handoff','t').evidence).toBe(f.work+'/code')
  expect(f.store.get<any>('knowledge','k').summary).toContain(f.work)
})

test('reference assessments are optional evidence without an expiry or empty-reference gate', async () => {
  const f = await fixture(), before = await f.gate.inspect('t')
  expect(before.eligible).toBe(true)
  writeFileSync(f.evidence, JSON.stringify({directory:f.work, checkedAt:'2020-01-01T00:00:00.000Z',checks:['Historical service inventory'],references:['archive.service']}))
  await f.gate.references('t',before.referenceFingerprint,f.evidence,()=>{})
  expect((await f.gate.inspect('t')).fingerprint).toBe(before.fingerprint)
  rmSync(f.evidence)
  expect((await f.gate.inspect('t')).eligible).toBe(true)
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
  expect((await f.gate.inspect('next')).eligible).toBe(true)
  expect((await f.gate.inspect('t')).eligible).toBe(true)
  f.store.put('handoff','next',{ticketId:'next',evidence:f.work+'/result.txt'})
  expect((await f.gate.inspect('next')).eligible).toBe(true)
  expect(await f.gate.remove('next',(await f.gate.inspect('next')).fingerprint,()=>{})).toMatchObject({state:'removed'})
  expect(existsSync(f.work)).toBe(false)
})

test('cleanup preserves a workspace used as another active task secondary repository', async () => {
  const f = await fixture(), other = {...f.store.tickets.get('t')!, id:'multi', ended:undefined, execution:{name:'multi',directory:f.repo,assignment:'Task'}}
  f.store.tickets.save(other)
  f.store.put('ticket-workspace', 'multi:second', {ticketId:'multi',locationId:'second',repository:f.repo,directory:f.work,name:'task'})
  expect((await f.gate.inspect('t')).reasons.join(' ')).toContain('Another ticket references')
  expect(existsSync(f.work)).toBe(true)
})
