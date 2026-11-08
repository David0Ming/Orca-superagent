import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Store } from './store.ts'

export const ATTACHMENT_CHUNK = 192 * 1024
const MAX_FILE = 20 * 1024 * 1024
export type Attachment = { id: string; name: string; mime: string; size: number; path: string; sha256: string }
type Upload = Omit<Attachment, 'sha256'> & { sha256?: string; declaredMime: string; offset: number; ready: boolean }
const uuid = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Attachment ID must be a canonical UUID')
  return id
}
const decimal = (value: string, name: string) => {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid attachment ${name}`)
  return Number(value)
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const imageMime = (bytes: Buffer): string => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}

export class Attachments {
  private readonly directory?: string
  constructor(private readonly store: Store, directory?: string) {
    this.directory = directory ?? (store.path === ':memory:' ? undefined : join(dirname(resolve(store.path)), 'attachments'))
  }

  write(options: Record<string, string>) {
    const id = uuid(options.id), name = options.name, declaredMime = options.mime?.trim().toLowerCase() || 'application/octet-stream'
    if (!name?.trim() || name.length > 255 || /[/\\\x00-\x1f\x7f]/.test(name) || ['.', '..'].includes(name)) throw new Error('Invalid attachment filename')
    if (declaredMime.length > 127 || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(declaredMime)) throw new Error('Invalid attachment MIME type')
    const size = decimal(options.size, 'size'), offset = decimal(options.offset, 'offset')
    if (size > MAX_FILE) throw new Error('Attachments must be at most 20 MiB per file')
    if (typeof options.data !== 'string' || options.data.length > Math.ceil(ATTACHMENT_CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(options.data)) throw new Error('Invalid attachment base64 or chunk larger than 192 KiB')
    const bytes = Buffer.from(options.data, 'base64')
    if (bytes.toString('base64') !== options.data || bytes.length > ATTACHMENT_CHUNK || offset + bytes.length > size || (!bytes.length && size > 0)) throw new Error('Invalid attachment chunk')
    if (!this.directory) throw new Error('Attachments require a persistent state directory')
    const prior = this.store.get<Upload>('attachment', id)
    if (prior && (prior.name !== name || prior.declaredMime !== declaredMime || prior.size !== size)) throw new Error('Attachment ID reused with different metadata')
    if (!prior && offset !== 0) throw new Error('First attachment chunk must start at offset 0')
    mkdirSync(this.directory, {recursive: true, mode: 0o700})
    const partial = join(this.directory, `${id}.part`), final = join(this.directory, id)
    const path = prior?.ready || (!existsSync(partial) && existsSync(final)) ? final : partial
    const file = openSync(path, prior || existsSync(path) ? 'r+' : 'wx+', 0o600)
    let length: number
    try {
      length = fstatSync(file).size
      if (length < (prior?.offset ?? 0) || length > size || offset > length) throw new Error(`Attachment offset mismatch; saved offset is ${length}`)
      const overlap = Math.min(bytes.length, length - offset), existing = Buffer.alloc(overlap)
      if (readSync(file, existing, 0, overlap, offset) !== overlap || !existing.equals(bytes.subarray(0, overlap))) throw new Error('Attachment chunk replay has different bytes')
      let written = overlap
      while (written < bytes.length) {
        const count = writeSync(file, bytes, written, bytes.length - written, offset + written)
        if (!count) throw new Error('Attachment write made no progress')
        written += count
      }
      fsyncSync(file)
      length = fstatSync(file).size
    } finally { closeSync(file) }
    const record: Upload = {id, name, declaredMime, mime: prior?.mime ?? 'application/octet-stream', size, path, offset: length, ready: length === size}
    if (record.ready) {
      const content = readFileSync(path)
      record.sha256 = createHash('sha256').update(content).digest('hex')
      if (prior?.sha256 && prior.sha256 !== record.sha256) throw new Error('Attachment content changed after completion')
      record.mime = imageMime(content)
      if (path !== final) renameSync(path, final)
      record.path = final
    }
    this.store.put('attachment', id, record)
    return {id, name, mime:record.mime, size, ready:record.ready, offset:record.offset, ...(record.sha256 ? {sha256:record.sha256} : {})}
  }

  private completed(id: string): Upload & {sha256: string} {
    const record = this.store.get<Upload>('attachment', uuid(id))
    if (!record?.ready || !record.sha256) throw new Error('Attachment is not ready')
    if (!statSync(record.path).isFile() || statSync(record.path).size !== record.size) throw new Error('Attachment file is missing or changed')
    return record as Upload & {sha256: string}
  }

  resolve(value?: string): Attachment[] {
    if (value === undefined) return []
    let ids: unknown
    try { ids = JSON.parse(value) } catch { throw new Error('Attachments must be a JSON array of IDs') }
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length || ids.length > 10) throw new Error('Use at most 10 distinct attachment IDs per message')
    return ids.map(id => {
      const record = this.completed(id)
      if (hash(record.path) !== record.sha256) throw new Error('Attachment content hash mismatch')
      return {id:record.id, name:record.name, mime:record.mime, size:record.size, path:record.path, sha256:record.sha256}
    })
  }

  read(options: Record<string, string>) {
    const record = this.completed(options.id), offset = decimal(options.offset, 'offset')
    if (offset > record.size) throw new Error('Attachment offset exceeds file size')
    const bytes = Buffer.alloc(Math.min(ATTACHMENT_CHUNK, record.size - offset)), file = openSync(record.path, 'r')
    try { if (readSync(file, bytes, 0, bytes.length, offset) !== bytes.length) throw new Error('Attachment read was incomplete') }
    finally { closeSync(file) }
    const nextOffset = offset + bytes.length, done = nextOffset === record.size
    if ((offset === 0 || done) && hash(record.path) !== record.sha256) throw new Error('Attachment content hash mismatch')
    return {id:record.id, data:bytes.toString('base64'), offset, nextOffset, size:record.size, done}
  }
}
