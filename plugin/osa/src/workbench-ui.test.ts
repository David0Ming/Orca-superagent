import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

test('main workbench shows project requests, preserves drafts during refresh and opens a topic', { skip: !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && 'Chrome is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-workbench-test-'))
  try {
    const source = fileURLToPath(new URL('.', import.meta.url))
    for (const file of ['workbench.html', 'workbench.js', 'workbench.css', 'workbench-model.js']) cpSync(join(source, file), join(dir, file))
    const fingerprint = createHash('sha256').update(Buffer.alloc(196609)).digest('hex')
    const mock = `<script>
    const status={stateDir:'/test',tickets:[],projects:{projects:[{id:'p',name:'示例项目'}],tasks:[]},triggers:[{id:'one',source:'panel',human:true,at:'2026-11-07T01:00:00Z',text:'原始请求',channel:{source:'panel',thread:'one'},meta:{projectId:'p',attachments:[{id:'history-file',name:'旧图.png',mime:'image/png',size:4}]}},{id:'two',source:'panel',human:true,at:'2026-11-08T01:00:00Z',text:'今天的新进展',channel:{source:'panel',thread:'one'},meta:{projectId:'p',topicTriggerId:'one'}}],candidates:[{triggers:[{id:'two'}]}],outbox:[{id:'r',kind:'reply',status:'sent',triggerId:'one',channel:{source:'panel',thread:'one'},createdAt:'2026-11-07T02:00:00Z',text:'查询回复'}],routingHistory:[{id:'d',kind:'ignore',triggerIds:['one'],at:'2026-11-07T02:00:01Z'}]};
    const calls=[], saved={'workbench-drafts-v1':{[JSON.stringify(['/test','topic','one'])]:{text:'',id:'original-message',attachments:[{id:'11111111-1111-4111-8111-111111111111',name:'partial.bin',mime:'application/octet-stream',size:196609,state:'uploading',fingerprint:'${fingerprint}'}]}}};let change;
    window.orca={document:{get:async()=>({})},storage:{get:async key=>saved[key]||{},set:async(key,value)=>{saved[key]=value}},settings:{onDidChange:fn=>{change=fn}},plugin:{request:async(_name,input)=>{calls.push(input);if(input.action==='status')return status;if(input.action==='attachment-read')return {data:btoa('file'),nextOffset:4,size:4,done:true};if(input.action==='attachment-write'){const size=Number(input.options.size),offset=Number(input.options.offset)+atob(input.options.data).length;return {offset,ready:offset===size,mime:input.options.mime,sha256:'test'}}return {}}},shell:{openExternal:async()=>({opened:true})}};
    window.addEventListener('load',()=>setTimeout(async()=>{try{
      const click=el=>{if(!el)throw Error('missing element');el.click()};
      if(!document.querySelector('#detail').textContent.includes('原始请求'))throw Error('initial topic missing');
      if(!document.querySelector('#message-files').textContent.includes('需重选'))throw Error('partial file not marked for reselect');
      let reselect=document.querySelector('#message-files .reselect input');let wrong=new Uint8Array(196609);wrong[196608]=1;let transfer=new DataTransfer();transfer.items.add(new File([wrong],'partial.bin'));reselect.files=transfer.files;reselect.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,100));if(calls.some(c=>c.action==='attachment-write'))throw Error('different file accepted');
      reselect=document.querySelector('#message-files .reselect input');transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(196609)],'partial.bin'));reselect.files=transfer.files;reselect.dispatchEvent(new Event('change',{bubbles:true}));for(let i=0;i<500&&!document.querySelector('#message-files').textContent.includes('已上传');i++)await new Promise(r=>setTimeout(r,100));if(!document.querySelector('#message-files').textContent.includes('已上传'))throw Error('original reselect failed');click(document.querySelector('#message-files button[aria-label]'));

      click([...document.querySelectorAll('.history-attachment button')].find(b=>b.textContent==='查看图片'));await new Promise(r=>setTimeout(r,50));if(!document.querySelector('.history-attachment img')||!document.querySelector('.history-attachment').textContent.includes('保存文件'))throw Error('history preview missing');
      status.configuration={repository:'/changed'};click(document.querySelector('#refresh'));await new Promise(r=>setTimeout(r,50));if(!document.querySelector('.history-attachment img')||!document.querySelector('.history-attachment').textContent.includes('保存文件'))throw Error('history preview lost after refresh');
      if(document.querySelector('.task').dataset.state!=='pending'||!document.querySelector('.pill').textContent.includes('等待 Router'))throw Error('followup candidate is not pending');
      if(document.querySelectorAll('.inline-form').length!==1)throw Error('today input duplicated');
      if(document.querySelectorAll('.group-head').length<2)throw Error('missing foldable groups');
      if(!document.querySelector('.task-time').textContent)throw Error('missing local time');
      const groups=[...document.querySelectorAll('.group')];const old=groups.find(g=>g.firstElementChild.textContent.includes('2026-11-07'));const recent=groups.find(g=>g.firstElementChild.textContent.includes('2026-11-08'));
      if(!old||!recent||!old.querySelector('.task-preview').textContent.includes('查询回复')||old.querySelector('.task-preview').textContent.includes('今天的新进展')||!recent.querySelector('.task-preview').textContent.includes('今天的新进展'))throw Error('wrong daily activity');
      click(old.querySelector('.task'));if(!document.querySelector('#detail').textContent.includes('原始请求'))throw Error('old day topic missing');click(recent.querySelector('.task'));if(!document.querySelector('#detail').textContent.includes('原始请求'))throw Error('new day topic differs');
      if(!document.querySelector('#count').textContent.includes('0 项任务'))throw Error('wrong unique task count');
      const input=document.querySelector('.inline-form textarea');input.value='草稿';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();
      click(document.querySelector('#refresh'));await new Promise(r=>setTimeout(r,50));
      if(document.querySelector('.inline-form textarea').value!=='草稿')throw Error('draft lost');
      click(document.querySelector('.task'));
      if(!document.querySelector('#detail').textContent.includes('原始请求'))throw Error('detail missing');
      if(document.querySelector('#composer').hidden)throw Error('composer missing');
      const message=document.querySelector('#message');message.focus();message.value='补充原话';message.dispatchEvent(new Event('input',{bubbles:true}));message.setSelectionRange(2,2);const beforeDetail=document.querySelector('.detail-head');click(document.querySelector('#refresh'));await new Promise(r=>setTimeout(r,60));if(document.querySelector('.detail-head')!==beforeDetail||message.selectionStart!==2)throw Error('unchanged refresh repainted input');
      document.querySelector('#composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,50));
      const sent=calls.find(c=>c.action==='comment');if(!sent||sent.options.trigger!=='one'||sent.options.text!=='补充原话'||sent.stateDir!=='/test')throw Error('incorrect comment');
      message.value='未发送补充';message.dispatchEvent(new Event('input',{bubbles:true}));
      const ticket={id:'t',title:'已接收任务',origin:{triggerId:'two',triggerIds:['two']},assignments:[],inputs:[],undelivered:[],mandate:{scope:'原始请求'}};
      status.tickets=[ticket];status.projects.tasks=[{ticket,context:{target:{projectId:'p'},workspaces:[],targets:[]}}];
      click(document.querySelector('#refresh'));await new Promise(r=>setTimeout(r,60));
      if(!document.querySelector('#detail').textContent.includes('已接收任务')||message.value!=='未发送补充')throw Error('accepted topic or draft lost');
      document.querySelector('#composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,50));
      const accepted=calls.filter(c=>c.action==='comment'&&c.options.ticket==='t');if(accepted.length!==1||accepted[0].options.text!=='未发送补充')throw Error('accepted draft not sent once');
      const pasteFile=new File([new Uint8Array(1100000)],'screen.png',{type:'image/png'});const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{files:[pasteFile]}});message.dispatchEvent(paste);for(let i=0;i<500&&!document.querySelector('#message-files').textContent.includes('已上传');i++)await new Promise(r=>setTimeout(r,100));
      const writes=calls.filter(c=>c.action==='attachment-write');if(writes.length<6||!document.querySelector('#message-files').textContent.includes('已上传'))throw Error('paste upload failed');
      if(JSON.stringify(saved).includes(writes[0].options.data.slice(0,100)))throw Error('base64 stored in drafts');
      const before=calls.filter(c=>c.action==='comment').length;message.value='';message.dispatchEvent(new Event('input',{bubbles:true}));message.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));message.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:false,bubbles:true}));message.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));await new Promise(r=>setTimeout(r,30));if(calls.filter(c=>c.action==='comment').length!==before)throw Error('IME submitted '+before+'->'+calls.filter(c=>c.action==='comment').length);
      message.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,60));const imageSend=calls.filter(c=>c.action==='comment').at(-1);if(imageSend.options.text!==''||JSON.parse(imageSend.options.attachments).length!==1)throw Error('image-only send failed');
      const projectForm=document.querySelector('.inline-form');const drop=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[new File(['file'],'note.txt',{type:'text/plain'})]}});projectForm.dispatchEvent(drop);for(let i=0;i<500&&!projectForm.querySelector('.attachment-tray').textContent.includes('已上传');i++)await new Promise(r=>setTimeout(r,100));if(!projectForm.querySelector('.attachment-tray').textContent.includes('已上传'))throw Error('project drop failed');
      projectForm.querySelector('textarea').value='';projectForm.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true}));projectForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,60));const request=calls.filter(c=>c.action==='request').at(-1);if(!request||request.options.text!==''||JSON.parse(request.options.attachments).length!==1)throw Error('project attachment send failed');if(projectForm.querySelector('.attachment-tray').childElementCount)throw Error('sent attachment still displayed');
      const oldForm=document.querySelector('.inline-form'); const oldInput=oldForm.querySelector('textarea');oldInput.value='A草稿';oldInput.dispatchEvent(new Event('input',{bubbles:true}));oldInput.focus();
      status.stateDir='/B';change({key:'stateDir'});await new Promise(r=>setTimeout(r,80));
      if(document.querySelector('.inline-form textarea').value!=='')throw Error('cross-state draft');
      oldForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,30));
      if(calls.filter(c=>c.action==='request').length!==1)throw Error('stale form sent');
      status.stateDir='/test';change({key:'stateDir'});await new Promise(r=>setTimeout(r,80));
      if(document.querySelector('.inline-form textarea').value!=='A草稿')throw Error('old draft lost');
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
    const output = execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files', `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=100000', '--dump-dom', `file://${join(dir, 'workbench.html')}`], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
    assert.match(output, /data-test="passed"/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
