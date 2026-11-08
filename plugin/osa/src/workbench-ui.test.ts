import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('main workbench shows project requests, preserves drafts during refresh and opens a topic', { skip: !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && 'Chrome is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-workbench-test-'))
  try {
    const source = fileURLToPath(new URL('.', import.meta.url))
    for (const file of ['workbench.html', 'workbench.js', 'workbench.css', 'workbench-model.js']) cpSync(join(source, file), join(dir, file))
    const mock = `<script>
    const status={stateDir:'/test',tickets:[],projects:{projects:[{id:'p',name:'示例项目'}],tasks:[]},triggers:[{id:'one',source:'panel',human:true,at:'2026-11-07T01:00:00Z',text:'原始请求',channel:{source:'panel',thread:'one'},meta:{projectId:'p'}},{id:'two',source:'panel',human:true,at:'2026-11-08T01:00:00Z',text:'今天的新进展',channel:{source:'panel',thread:'one'},meta:{projectId:'p',topicTriggerId:'one'}}],candidates:[{triggers:[{id:'two'}]}],outbox:[{id:'r',kind:'reply',status:'sent',triggerId:'one',channel:{source:'panel',thread:'one'},createdAt:'2026-11-07T02:00:00Z',text:'查询回复'}],routingHistory:[{id:'d',kind:'ignore',triggerIds:['one'],at:'2026-11-07T02:00:01Z'}]};
    const calls=[], saved={};let change;
    window.orca={document:{get:async()=>({})},storage:{get:async key=>saved[key]||{},set:async(key,value)=>{saved[key]=value}},settings:{onDidChange:fn=>{change=fn}},plugin:{request:async(_name,input)=>{calls.push(input);return input.action==='status'?status:{}}},shell:{openExternal:async()=>({opened:true})}};
    window.addEventListener('load',()=>setTimeout(async()=>{try{
      const click=el=>{if(!el)throw Error('missing element');el.click()};
      if(!document.querySelector('#detail').textContent.includes('原始请求'))throw Error('initial topic missing');
      if(document.querySelector('.task').dataset.state!=='pending'||!document.querySelector('.pill').textContent.includes('等待 Router'))throw Error('followup candidate is not pending');
      if(document.querySelectorAll('.inline-form').length!==1)throw Error('today input duplicated');
      if(document.querySelectorAll('.group-head').length<2)throw Error('missing foldable groups');
      if(!document.querySelector('.task-time').textContent)throw Error('missing local time');
      const groups=[...document.querySelectorAll('.group')];const old=groups.find(g=>g.firstElementChild.textContent.includes('2026-11-07'));const recent=groups.find(g=>g.firstElementChild.textContent.includes('2026-11-08'));
      if(!old||!recent||!old.querySelector('.task-preview').textContent.includes('查询回复')||old.querySelector('.task-preview').textContent.includes('今天的新进展')||!recent.querySelector('.task-preview').textContent.includes('今天的新进展'))throw Error('wrong daily activity');
      click(old.querySelector('.task'));if(!document.querySelector('#detail').textContent.includes('原始请求'))throw Error('old day topic missing');click(recent.querySelector('.task'));if(!document.querySelector('#detail').textContent.includes('原始请求'))throw Error('new day topic differs');
      if(!document.querySelector('#count').textContent.includes('0 项任务'))throw Error('wrong unique task count');
      const input=document.querySelector('.inline-form input');input.value='草稿';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();
      click(document.querySelector('#refresh'));await new Promise(r=>setTimeout(r,50));
      if(document.querySelector('.inline-form input').value!=='草稿')throw Error('draft lost');
      click(document.querySelector('.task'));
      if(!document.querySelector('#detail').textContent.includes('原始请求'))throw Error('detail missing');
      if(document.querySelector('#composer').hidden)throw Error('composer missing');
      const message=document.querySelector('#message');message.value='补充原话';message.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,50));
      const sent=calls.find(c=>c.action==='comment');if(!sent||sent.options.trigger!=='one'||sent.options.text!=='补充原话'||sent.stateDir!=='/test')throw Error('incorrect comment');
      message.value='未发送补充';message.dispatchEvent(new Event('input',{bubbles:true}));
      const ticket={id:'t',title:'已接收任务',origin:{triggerId:'two',triggerIds:['two']},assignments:[],inputs:[],undelivered:[],mandate:{scope:'原始请求'}};
      status.tickets=[ticket];status.projects.tasks=[{ticket,context:{target:{projectId:'p'},workspaces:[],targets:[]}}];
      click(document.querySelector('#refresh'));await new Promise(r=>setTimeout(r,60));
      if(!document.querySelector('#detail').textContent.includes('已接收任务')||message.value!=='未发送补充')throw Error('accepted topic or draft lost');
      document.querySelector('#composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,50));
      const accepted=calls.filter(c=>c.action==='comment'&&c.options.ticket==='t');if(accepted.length!==1||accepted[0].options.text!=='未发送补充')throw Error('accepted draft not sent once');
      const oldForm=document.querySelector('.inline-form'); const oldInput=oldForm.querySelector('input');oldInput.value='A草稿';oldInput.dispatchEvent(new Event('input',{bubbles:true}));oldInput.focus();
      status.stateDir='/B';change({key:'stateDir'});await new Promise(r=>setTimeout(r,80));
      if(document.querySelector('.inline-form input').value!=='')throw Error('cross-state draft');
      oldForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,30));
      if(calls.some(c=>c.action==='request'))throw Error('stale form sent');
      status.stateDir='/test';change({key:'stateDir'});await new Promise(r=>setTimeout(r,80));
      if(document.querySelector('.inline-form input').value!=='A草稿')throw Error('old draft lost');
      document.activeElement?.blur();
      status.projects.tasks[0].context.workspaces=[{worktreeId:'tree-1',directory:'/repo/branch-live',name:'branch-live'}];
      click(document.querySelector('#refresh'));await new Promise(r=>setTimeout(r,50));
      click(document.querySelector('[data-view=worktree]'));
      if(!document.querySelector('#list').textContent.includes('/repo/branch-live'))throw Error('worktree group missing');
      const search=document.querySelector('#search');search.value='branch-live';search.dispatchEvent(new Event('input',{bubbles:true}));
      if(document.querySelectorAll('.task').length!==1)throw Error('worktree search mismatch');
      const filter=document.querySelector('#filter');filter.value='ended';filter.dispatchEvent(new Event('change',{bubbles:true}));
      if(document.querySelectorAll('.task').length!==0)throw Error('state filter mismatch');
      filter.value='all';filter.dispatchEvent(new Event('change',{bubbles:true}));search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
      click(document.querySelector('[data-view=date]'));if(document.querySelectorAll('.task').length<2)throw Error('date switch lost activity');
      document.body.dataset.test='passed';
    }catch(e){document.body.dataset.test='failed: '+e.message}},100));</script>`
    const html = readFileSync(join(dir, 'workbench.html'), 'utf8').replace('<script type="module"', `${mock}<script type="module"`)
    writeFileSync(join(dir, 'workbench.html'), html)
    const output = execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files', `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=3000', '--dump-dom', `file://${join(dir, 'workbench.html')}`], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
    assert.match(output, /data-test="passed"/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
