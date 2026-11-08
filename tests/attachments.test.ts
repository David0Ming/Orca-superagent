import { afterEach, expect, test } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Attachments, ATTACHMENT_CHUNK } from '../src/attachments.ts'
import { Store } from '../src/store.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(fn => fn()))
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'osa-attachments-')), database = join(directory, 'state.db')
  let store = new Store(database), attachments = new Attachments(store)
  cleanup.push(() => { store.close(); rmSync(directory, {recursive:true, force:true}) })
  const upload = (bytes: Buffer, id = randomUUID(), name = 'example.bin', mime = 'application/octet-stream') => {
    const results = []
    for (let offset = 0; offset < Math.max(bytes.length, 1); offset += ATTACHMENT_CHUNK)
      results.push(attachments.write({id,name,mime,size:String(bytes.length),offset:String(offset),data:bytes.subarray(offset, offset + ATTACHMENT_CHUNK).toString('base64')}))
    return {id, results}
  }
  return {directory, upload, get store() {return store}, get attachments() {return attachments}, restart() {
    store.close(); store = new Store(database); attachments = new Attachments(store)
  }}
}

test('uploads more than the bridge message limit in bounded chunks and reads the same bytes after restart', () => {
  const f = setup(), bytes = Buffer.alloc(1_500_123, 157), {id, results} = f.upload(bytes)
  expect(results.length).toBeGreaterThan(5)
  expect(results[0]).toMatchObject({ready:false,offset:ATTACHMENT_CHUNK})
  expect(results.at(-1)).toMatchObject({ready:true,offset:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
  expect(JSON.stringify(results).length).toBeLessThan(1_000_000)
  const metadata = f.attachments.resolve(JSON.stringify([id]))[0]
  expect(metadata.path).toBe(join(f.directory,'attachments',id))
  expect(statSync(metadata.path).mode & 0o777).toBe(0o600)
  f.restart()
  expect(f.attachments.resolve(JSON.stringify([id]))).toEqual([metadata])
  const chunks: Buffer[] = []
  let offset = 0, done = false
  while (!done) {
    const chunk = f.attachments.read({id,offset:String(offset)})
    expect(Buffer.from(chunk.data,'base64').length).toBeLessThanOrEqual(ATTACHMENT_CHUNK)
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(1_000_000)
    chunks.push(Buffer.from(chunk.data,'base64')); offset=chunk.nextOffset; done=chunk.done
  }
  expect(Buffer.concat(chunks)).toEqual(bytes)
})

test('stable offsets replay exact bytes, reject changes, and recover file bytes written before a record checkpoint', () => {
  const f=setup(), id=randomUUID(), options={id,name:'notes.txt',mime:'text/plain',size:'6',offset:'0',data:Buffer.from('abc').toString('base64')}
  expect(f.attachments.write(options)).toMatchObject({ready:false,offset:3})
  expect(f.attachments.write(options)).toMatchObject({ready:false,offset:3})
  expect(()=>f.attachments.write({...options,data:Buffer.from('abd').toString('base64')})).toThrow('different bytes')
  expect(()=>f.attachments.write({...options,offset:'4',data:Buffer.from('ef').toString('base64')})).toThrow('offset mismatch')
  expect(()=>f.attachments.write({...options,name:'changed.txt'})).toThrow('different metadata')
  expect(()=>f.attachments.resolve(JSON.stringify([id]))).toThrow('not ready')
  appendFileSync(join(f.directory,'attachments',`${id}.part`),'d')
  expect(f.attachments.write({...options,offset:'3',data:Buffer.from('def').toString('base64')})).toMatchObject({ready:true,offset:6})
  const metadata=f.attachments.resolve(JSON.stringify([id]))[0]
  expect(readFileSync(metadata.path,'utf8')).toBe('abcdef')
  expect(f.attachments.write(options)).toMatchObject({ready:true,offset:6,sha256:metadata.sha256})
})

test.each([
  {id:'../../outside'}, {name:'../outside'}, {name:'C:\\outside'}, {name:'bad\nname'},
  {size:String(20*1024*1024+1)}, {size:'01'}, {offset:'-1'}, {offset:'1'},
  {data:'!!!!'}, {data:'Zh=='}, {data:Buffer.alloc(ATTACHMENT_CHUNK+1).toString('base64'),size:String(ATTACHMENT_CHUNK+1)},
])('invalid upload boundaries do not write a record: %j', patch => {
  const f=setup(), options={id:randomUUID(),name:'safe.bin',mime:'application/octet-stream',size:'1',offset:'0',data:Buffer.from('f').toString('base64')}
  expect(()=>f.attachments.write({...options,...patch})).toThrow()
  expect(f.store.list('attachment')).toHaveLength(0)
})

test.each([
  ['image/png',Buffer.from([137,80,78,71,13,10,26,10])],
  ['image/jpeg',Buffer.from([255,216,255,224])],
  ['image/gif',Buffer.from('GIF89a')],
  ['image/webp',Buffer.from('RIFF0000WEBP')],
  ['application/octet-stream',Buffer.from('<script>window.bad=true</script>')],
])('uses byte signatures rather than a browser MIME claim: %s', (mime,bytes) => {
  const f=setup(), {id}=f.upload(bytes,randomUUID(),'image.png','image/png')
  expect(f.attachments.resolve(JSON.stringify([id]))[0].mime).toBe(mime)
})

test('completed bytes must remain readable and match the saved hash; partial and arbitrary-path reads fail', () => {
  const f=setup(), {id}=f.upload(Buffer.from('original')), metadata=f.attachments.resolve(JSON.stringify([id]))[0]
  expect(()=>f.attachments.read({id:'../../outside',offset:'0'})).toThrow('UUID')
  expect(()=>f.attachments.read({id,offset:'999'})).toThrow('exceeds')
  writeFileSync(metadata.path,'tampered')
  expect(()=>f.attachments.read({id,offset:'0'})).toThrow('hash mismatch')
  expect(()=>f.attachments.resolve(JSON.stringify([id]))).toThrow('hash mismatch')
  rmSync(metadata.path)
  expect(()=>f.attachments.read({id,offset:'0'})).toThrow()
  expect(()=>f.attachments.resolve(JSON.stringify([id]))).toThrow()
})

test('message resolution accepts ten ready files including zero bytes and rejects duplicate, partial or extra references', () => {
  const f=setup(), ids=Array.from({length:11},()=>f.upload(Buffer.alloc(0)).id)
  expect(f.attachments.resolve(JSON.stringify(ids.slice(0,10)))).toHaveLength(10)
  expect(f.attachments.read({id:ids[0],offset:'0'})).toMatchObject({data:'',size:0,nextOffset:0,done:true})
  expect(()=>f.attachments.resolve(JSON.stringify(ids))).toThrow('10')
  expect(()=>f.attachments.resolve(JSON.stringify([ids[0],ids[0]]))).toThrow('distinct')
  for(const value of ['{}','null','broken','[12]']) expect(()=>f.attachments.resolve(value)).toThrow()
})
