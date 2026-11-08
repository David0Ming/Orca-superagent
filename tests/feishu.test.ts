import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Feishu } from '../src/feishu.ts'
import { App } from '../src/app.ts'
import { Store } from '../src/store.ts'

const config = { chatId: 'oc_chat', ownerId: 'ou_owner', botId: 'ou_bot', appId: 'cli_app' }
const cleanups: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); cleanups.splice(0).forEach(fn => fn()) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'osa-feishu-')), path = join(dir, 'fixture.json'), cli = join(dir, 'lark')
  let store = new Store(join(dir, 'state.db'))
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  let app = new App(store, { start() {}, deliver() {}, stop() {} }, 'local', undefined, config)
  const state = { identity: { ...config }, messages: [] as any[], replies: [] as any[], calls: [] as any[], roots: {} as Record<string, any>,
    lost: false, fail: false, badPage: false, foreign: false, getOverrides: {} as Record<string, any>, pages: {} as Record<string, any>, hideReplies: false, sent: {} as Record<string, any>, failRoots: [] as string[], changeIdentityOnRead: false }
  const save = () => writeFileSync(path, JSON.stringify(state))
  const load = () => Object.assign(state, JSON.parse(readFileSync(path, 'utf8')))
  save()
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'); const path=${JSON.stringify(path)};
const s=JSON.parse(fs.readFileSync(path)); const args=process.argv.slice(2); const opt=n=>args[args.indexOf(n)+1];
s.calls.push(args); const save=()=>fs.writeFileSync(path,JSON.stringify(s));
const out=data=>{save(); console.log(JSON.stringify({ok:true,identity:'bot',data}));};
if(args[0]!=='auth' && opt('--as')!=='bot') throw Error('Bot identity required');
if(args[0]==='auth'){save(); console.log(JSON.stringify({brand:'feishu',verified:true,appId:s.identity.appId,
identities:{user:{verified:true,openId:s.identity.ownerId},bot:{verified:true,openId:s.identity.botId}}}));}
else if(args[1]==='+messages-reply') {
 if(!args.includes('--reply-in-thread') || !opt('--idempotency-key') || opt('--idempotency-key').length>50) throw Error('Reply contract missing');
 if(s.fail || s.failRoots.includes(opt('--message-id'))){save();process.exit(1);}
 const text=opt('--text'); let m=s.sent[opt('--idempotency-key')];
 if(!m){m={message_id:'om_reply'+s.replies.length,chat_id:s.identity.chatId,thread_id:opt('--message-id')==='om_goal'?'omt_thread':'omt_'+opt('--message-id').slice(3),root_id:opt('--message-id'),
 create_time:String(Date.now()),msg_type:'text',sender:{id:s.identity.appId,sender_type:'app'},body:{content:JSON.stringify({text})}};s.replies.push(m);s.sent[opt('--idempotency-key')]=m;}
 if(s.lost){s.lost=false;save();process.exit(1);} out({message_id:m.message_id,chat_id:m.chat_id});
} else if(args[0]==='api' && args[2].startsWith('/open-apis/im/v1/messages/')) {
 const mid=args[2].split('/').at(-1); let m=s.messages.find(m=>m.message_id===mid)||s.replies.find(m=>m.message_id===mid)||s.roots[mid];
 if(m && !m.root_id && s.replies.some(r=>r.root_id===mid)) m={...m,thread_id:s.replies.find(r=>r.root_id===mid).thread_id};
 out({items:m?[{...m,...s.getOverrides[mid]}]:[]});
} else if(args[0]==='api') {
 if(s.changeIdentityOnRead) s.identity.botId='ou_changed';
 const p=JSON.parse(opt('--params')); const all=p.container_id_type==='chat'?s.messages:s.replies;
 const rows=p.container_id_type==='thread'?(s.hideReplies?[]:all.filter(m=>m.thread_id===p.container_id)):all;
 if(s.pages[p.container_id]) {out(s.pages[p.container_id][Number(p.page_token||0)]);process.exit(0);}
 const offset=Number(p.page_token||0); const items=rows.slice(offset,offset+1).map(m=>({...m,...(s.foreign?{chat_id:'oc_other'}:{})}));
 out({items,has_more:s.badPage||offset+1<rows.length,page_token:s.badPage?'stuck':String(offset+1)});
} else {save();process.exit(2);}
`, { mode: 0o700 })
  const source = new Feishu(store, { ...config, cli })
  store.put('feishu.cursor', config.chatId, { started: Date.now() - 1000, since: Date.now() - 1000 })
  const message = (name: string, extra = {}) => ({ message_id: 'om_' + name, chat_id: config.chatId, create_time: String(Date.now()),
    msg_type: 'text', sender: { id: config.ownerId, id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text: name }) }, ...extra })
  state.roots.om_goal = message('goal'); save()
  const mail = (name: string) => store.put('outbox', name, { id: name, status: 'pending', kind: 'reply', text: 'Result ' + name,
    channel: { source: 'feishu', thread: 'oc_chat:om_goal', address: { chatId: config.chatId, messageId: 'om_goal' } } })
  return { get store() { return store }, get app() { return app }, source, state, save, load, message, mail, cli,
    restart() {
      store.close(); store = new Store(join(dir, 'state.db'))
      app = new App(store, { start() {}, deliver() {}, stop() {} }, 'local', undefined, config)
      return new Feishu(store, { ...config, cli })
    },
  }
}

test('owner/chat filtering, pagination, restart dedup and same-topic followup', async () => {
  const f = fixture()
  f.state.messages = [f.message('old', { create_time: '1' }), f.message('other', { sender: { id: 'ou_other', sender_type: 'user' } }), f.message('goal')]
  f.save(); await f.source.tick(f.app.engine)
  expect(f.store.list('core.trigger')).toHaveLength(1)
  const trigger = f.store.list<any>('core.trigger')[0]
  const decision = f.app.engine.decide(trigger.id, { kind: 'accept', title: 'Goal', scope: 'Goal', reason: 'Owner' })
  f.load(); f.state.replies.push(f.message('followup', { root_id: 'om_goal', thread_id: 'omt_thread' })); f.save()
  await new Feishu(f.store, { ...config, cli: f.cli }).tick(f.app.engine)
  expect(f.store.list('core.trigger')).toHaveLength(2)
  expect(f.store.tickets.get(decision.ticketId!)!.inputs.some(input => input.kind === 'trigger')).toBe(true)
  await f.source.tick(f.app.engine)
  expect(f.store.list('core.trigger')).toHaveLength(2)
})

test('lost reply response is reconciled and bot output never becomes owner input', async () => {
  const f = fixture(); f.state.messages = [f.message('goal')]; f.state.lost = true; f.save(); f.mail('one')
  await expect(f.source.tick(f.app.engine)).rejects.toThrow()
  expect(f.store.get<any>('outbox', 'one').status).toBe('pending')
  await new Feishu(f.store, { ...config, cli: f.cli }).tick(f.app.engine)
  expect(f.store.get<any>('outbox', 'one').status).toBe('sent')
  f.load(); expect(f.state.replies).toHaveLength(1)
  expect(f.state.calls.filter(args => args[1] === '+messages-reply')).toHaveLength(1)
  expect(f.store.list('core.trigger')).toHaveLength(1)
})

test('failed reply preserves ordering; old ambiguous send and changed account cannot send', async () => {
  const f = fixture(); f.state.fail = true; f.save(); f.mail('one'); f.mail('two')
  await expect(f.source.tick(f.app.engine)).rejects.toThrow()
  f.load(); expect(f.state.calls.filter(args => args[1] === '+messages-reply')).toHaveLength(1)
  f.state.fail = false; f.save()
  f.store.put('feishu.send', 'one', { attemptedAt: Date.now() - 3600_000 })
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('idempotency window')
  f.load(); expect(f.state.calls.filter(args => args[1] === '+messages-reply')).toHaveLength(1)
  f.state.identity.ownerId = 'ou_changed'; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('identity changed')
  expect(f.store.get<any>('outbox', 'two').status).toBe('pending')
})

test('bad pagination and foreign chat fail without advancing cursor or ingesting a partial page', async () => {
  const f = fixture(); const cursor = f.store.get('feishu.cursor', config.chatId)
  f.state.messages = [f.message('goal')]; f.state.badPage = true; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('pagination')
  expect(f.store.get('feishu.cursor', config.chatId)).toEqual(cursor)
  expect(f.store.list('core.trigger')).toEqual([])
  f.load(); f.state.badPage = false; f.state.foreign = true; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('outside requested')
  expect(f.store.get('feishu.cursor', config.chatId)).toEqual(cursor)
})

test('outbox address cannot route outside configured chat', async () => {
  const f = fixture(); f.mail('one')
  const mail = f.store.get<any>('outbox', 'one'); mail.channel.address.chatId = 'oc_other'; f.store.put('outbox', 'one', mail)
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('outbox address')
  f.load(); expect(f.state.calls.some(args => args[1] === '+messages-reply')).toBe(false)
})

test('precise activation cutoff, downtime intake and edited content survive a database reopen', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-11-02T00:00:30.500Z')
  const f = fixture(), started = Date.now()
  f.store.put('feishu.cursor', config.chatId, { started, since: started })
  f.state.messages = [f.message('old', { create_time: String(started - 1) }), f.message('goal')]
  f.save(); await f.source.tick(f.app.engine)
  expect(f.store.list<any>('core.trigger').map(t => t.text)).toEqual(['goal'])
  f.load(); f.state.messages[1].update_time = String(started + 10); f.save()
  await f.source.tick(f.app.engine)
  expect(f.store.list('core.trigger')).toHaveLength(1)
  vi.setSystemTime(started + 60_000)
  f.load(); f.state.messages.push(f.message('downtime')); f.save()
  const source = f.restart()
  await source.tick(f.app.engine)
  expect(f.store.list<any>('core.trigger').map(t => t.text)).toEqual(['goal', 'downtime'])
  f.load(); f.state.messages[1].body.content = JSON.stringify({ text: 'edited goal' }); f.save()
  await source.tick(f.app.engine)
  expect(f.store.list<any>('core.trigger').map(t => t.text)).toEqual(['goal', 'downtime', 'edited goal'])
  expect(f.store.get<any>('feishu.cursor', config.chatId).started).toBe(started)
})

test('new owner replies on an old untracked root are discovered and use the canonical root', async () => {
  const f = fixture()
  f.state.messages = [f.message('history', { create_time: '1', thread_id: 'omt_history', sender: { id: 'ou_other', sender_type: 'user' } })]
  f.state.replies = [f.message('before', { create_time: '1', root_id: 'om_history', thread_id: 'omt_history' }),
    f.message('new', { root_id: 'om_history', thread_id: 'omt_history' })]
  f.save(); await f.source.tick(f.app.engine)
  const triggers = f.store.list<any>('core.trigger')
  expect(triggers.map(t => t.text)).toEqual(['new'])
  expect(triggers[0].channel).toEqual({ source: 'feishu', thread: 'oc_chat:om_history', address: { chatId: config.chatId, messageId: 'om_history' } })
  const source = f.restart(); await source.tick(f.app.engine)
  expect(f.store.list('core.trigger')).toHaveLength(1)
})

test('retained topics in another chat do not affect this source', async () => {
  const f = fixture()
  f.store.put('feishu.topic', 'oc_other:om_foreign', { chatId: 'oc_other', root: 'om_foreign', threadId: 'omt_foreign' })
  f.save(); await f.source.tick(f.app.engine)
  f.load(); expect(f.state.calls.some(args => args.includes('/open-apis/im/v1/messages/om_foreign'))).toBe(false)
})

test('malformed topics preserve independent intake and do not advance the shared cursor', async () => {
  const f = fixture(), cursor = f.store.get('feishu.cursor', config.chatId)
  f.state.messages = [f.message('goal'), f.message('bad', { create_time: '2026-11-02 08:00' })]
  f.save(); await expect(f.source.tick(f.app.engine)).rejects.toThrow('timestamp')
  expect(f.store.list<any>('core.trigger').map(t => t.text)).toEqual(['goal'])
  expect(f.store.get('feishu.cursor', config.chatId)).toEqual(cursor)
  f.load(); f.state.messages = [f.message('goal', { thread_id: 'omt_thread' })]
  f.state.pages.omt_thread = [{ items: [f.message('reply', { root_id: 'om_goal', thread_id: 'omt_thread' })], has_more: true, page_token: '1' }, { items: [] }]
  f.save(); await expect(f.source.tick(f.app.engine)).rejects.toThrow('Incomplete')
  expect(f.store.list<any>('core.trigger').map(t => t.text)).toEqual(['goal'])
  expect(f.store.get('feishu.cursor', config.chatId)).toEqual(cursor)
})

test('a mismatched native root cannot ingest replies or confirm an outbox marker', async () => {
  const f = fixture()
  f.state.messages = [f.message('goal', { thread_id: 'omt_thread' })]
  f.state.replies = [f.message('wrong', { root_id: 'om_elsewhere', thread_id: 'omt_thread' })]
  f.save(); f.mail('one')
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('root mismatch')
  expect(f.store.list('core.trigger')).toEqual([])
  f.load(); expect(f.state.calls.some(args => args[1] === '+messages-reply')).toBe(false)
})

test.each([
  { sender: { sender_type: 'user', id: config.ownerId, id_type: 'open_id' } },
  { sender: { sender_type: 'app', id: 'cli_foreign' } },
  { sender: { sender_type: 'unknown', id: config.appId } },
  { deleted: true },
  { body: { content: JSON.stringify({ text: 'Result one\n\n[osa:one] extra' }) } },
])('only the exact pinned bot reply reconciles an outbox message: %j', async extra => {
  const f = fixture(); f.mail('one')
  f.state.replies = [f.message('forged', { root_id: 'om_goal', thread_id: 'omt_thread', sender: { sender_type: 'app', id: config.appId },
    body: { content: JSON.stringify({ text: 'Result one\n\n[osa:one]' }) }, ...extra })]
  f.save(); await f.source.tick(f.app.engine)
  f.load(); expect(f.state.calls.filter(args => args[1] === '+messages-reply')).toHaveLength(1)
  expect(f.store.get<any>('outbox', 'one').status).toBe('sent')
})

test('lost response reconciles all pages after database reopen even beyond the idempotency window', async () => {
  const f = fixture(); f.mail('one'); f.mail('two'); f.state.lost = true; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow()
  f.load(); f.state.replies.unshift(f.message('noise', { root_id: 'om_goal', thread_id: 'omt_thread', sender: { sender_type: 'app', id: 'cli_other' } })); f.save()
  f.store.put('feishu.send', 'one', { attemptedAt: Date.now() - 7200_000 })
  const source = f.restart(); await source.tick(f.app.engine)
  f.load(); expect(f.state.calls.filter(args => args[1] === '+messages-reply').map(args => args[args.indexOf('--text') + 1])).toEqual(['Result one\n\n[osa:one]', 'Result two\n\n[osa:two]'])
  expect(f.store.list<any>('outbox').every(m => m.status === 'sent')).toBe(true)
})

test('unseen lost response retries the same key within the window and stops after the window', async () => {
  const f = fixture(); f.mail('one'); f.state.lost = true; f.state.hideReplies = true; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow()
  const source = f.restart(); await source.tick(f.app.engine)
  f.load(); expect(f.state.replies).toHaveLength(1)
  const sends = f.state.calls.filter(args => args[1] === '+messages-reply')
  expect(sends).toHaveLength(2)
  expect(sends[0][sends[0].indexOf('--idempotency-key') + 1]).toBe(sends[1][sends[1].indexOf('--idempotency-key') + 1])
  f.mail('two'); f.store.put('feishu.send', 'two', { attemptedAt: Date.now() - 3600_000 })
  await expect(source.tick(f.app.engine)).rejects.toThrow('idempotency window')
  f.load(); expect(f.state.calls.filter(args => args[1] === '+messages-reply')).toHaveLength(2)
})

test('sent response with wrong native root is left pending and later reconciled without a second write', async () => {
  const f = fixture(); f.mail('one'); f.state.getOverrides.om_reply0 = { root_id: 'om_wrong' }; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('Cannot verify Feishu reply')
  expect(f.store.get<any>('outbox', 'one').status).toBe('pending')
  f.load(); f.state.getOverrides = {}; f.save()
  await f.source.tick(f.app.engine)
  f.load(); expect(f.state.calls.filter(args => args[1] === '+messages-reply')).toHaveLength(1)
  expect(f.store.get<any>('outbox', 'one').status).toBe('sent')
})

test.each(['ownerId', 'botId', 'appId'] as const)('auth and persisted identity pin %s', async field => {
  const f = fixture(); f.mail('one')
  f.state.identity[field] = field === 'appId' ? 'cli_other' : 'ou_other'; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('identity changed')
  f.load(); expect(f.state.calls.some(args => args[1] === '+messages-reply')).toBe(false)
  expect(() => new Feishu(f.store, { ...config, [field]: f.state.identity[field], cli: f.cli })).toThrow('stored identity changed')
})

test('one failed channel blocks later replies in that channel while another channel delivers', async () => {
  const f = fixture(); f.mail('first'); f.mail('second')
  f.state.roots.om_other = f.message('other')
  f.state.failRoots = ['om_goal']; f.save()
  f.store.put('outbox', 'elsewhere', { id: 'elsewhere', status: 'pending', kind: 'notice', text: 'Elsewhere',
    channel: { source: 'feishu', thread: 'oc_chat:om_other', address: { chatId: config.chatId, messageId: 'om_other' } } })
  await expect(f.source.tick(f.app.engine)).rejects.toThrow()
  expect(f.store.get<any>('outbox', 'first').status).toBe('pending')
  expect(f.store.get<any>('outbox', 'second').status).toBe('pending')
  expect(f.store.get<any>('outbox', 'elsewhere').status).toBe('sent')
  f.load(); expect(f.state.calls.filter(args => args[1] === '+messages-reply').map(args => args[args.indexOf('--message-id') + 1])).toEqual(['om_goal', 'om_other'])
  f.state.failRoots = []; f.save()
  await Promise.all([f.source.tick(f.app.engine), f.source.tick(f.app.engine)])
  f.load(); expect(f.state.replies.map(m => JSON.parse(m.body.content).text)).toEqual(['Elsewhere\n\n[osa:elsewhere]', 'Result first\n\n[osa:first]', 'Result second\n\n[osa:second]'])
})

test('identity is rechecked after polling before outbox writes', async () => {
  const f = fixture(); f.mail('one'); f.state.changeIdentityOnRead = true; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('identity changed')
  f.load(); expect(f.state.calls.some(args => args[1] === '+messages-reply')).toBe(false)
})

test('a reply address using a noncanonical child message fails closed', async () => {
  const f = fixture(); f.mail('one'); f.state.getOverrides.om_goal = { root_id: 'om_parent' }; f.save()
  await expect(f.source.tick(f.app.engine)).rejects.toThrow('canonical root')
  f.load(); expect(f.state.calls.some(args => args[1] === '+messages-reply')).toBe(false)
})

test('regression: missing historical topic must not block new independent owner message', async () => {
  const f = fixture()
  f.store.put('feishu.topic', 'oc_chat:om_missing', { chatId: 'oc_chat', root: 'om_missing' })
  f.state.messages = [f.message('goal')]; f.save()
  let failure: unknown
  try { await f.source.tick(f.app.engine) } catch (error) { failure = error }
  expect(failure).toBeDefined()
  expect(f.store.list('core.trigger')).toHaveLength(1)
})


test('subscribed other people and apps are context with their actual identity, never new-work authority', async () => {
  const f=fixture(); f.state.messages=[f.message('goal')]; f.save(); await f.source.tick(f.app.engine)
  const original=f.store.list<any>('core.trigger')[0], {ticketId}=f.app.engine.decide(original.id,{kind:'accept',title:'Goal',scope:'Original goal',reason:'Owner'})
  const ticket=f.store.tickets.get(ticketId!)!; f.app.engine.assignmentStarted(ticket.id,ticket.assignments[0].id)
  f.load(); f.state.replies=[
    f.message('humanfeedback',{root_id:'om_goal',thread_id:'omt_thread',sender:{id:'ou_reviewer',id_type:'open_id',sender_type:'user'}}),
    f.message('botfeedback',{root_id:'om_goal',thread_id:'omt_thread',sender:{id:'cli_ci',sender_type:'app'}}),
    f.message('historical',{root_id:'om_goal',thread_id:'omt_thread',create_time:'1',sender:{id:'cli_ci',sender_type:'app'}})
  ]; f.save(); await f.source.tick(f.app.engine)
  const feedback=f.store.list<any>('core.trigger').filter(trigger=>trigger.id!==original.id)
  expect(feedback.map(trigger=>[trigger.actor.id,trigger.human])).toEqual([['ou_reviewer',true],['cli_ci',false]])
  expect(f.store.tickets.get(ticket.id)?.mandate).toEqual(ticket.mandate)
  for(const trigger of feedback) {
    expect(f.store.triggers.disposition(trigger.id)?.fanout).toEqual([ticket.id])
    expect(()=>f.app.engine.decide(trigger.id,{kind:'accept',title:'Unauthorized',scope:'New work',reason:'No'})).toThrow()
  }
  expect(f.store.tickets.get(ticket.id)?.inputs.filter(input=>input.kind==='trigger')).toHaveLength(2)
  f.mail('one'); await f.source.tick(f.app.engine); await f.source.tick(f.app.engine)
  expect(f.store.list('core.trigger')).toHaveLength(3)
  f.load(); expect(f.state.calls.filter(args=>args[1]==='+messages-reply')).toHaveLength(1)
})

test('an unapproved sender on a different Feishu topic cannot originate work or become the owner', async () => {
  const f=fixture()
  f.state.messages=[f.message('other',{sender:{id:'ou_other',id_type:'open_id',sender_type:'user'}}),f.message('bot',{sender:{id:'cli_ci',sender_type:'app'},thread_id:'omt_other'})]
  f.save(); await f.source.tick(f.app.engine)
  expect(f.store.tickets.list()).toHaveLength(0)
  expect(f.store.list('candidate')).toHaveLength(0)
  expect(f.store.list('core.trigger')).toHaveLength(0)
})
