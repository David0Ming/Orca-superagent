import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { key, type Engine, type OutboundMessage, type ReplyStatus } from '../vendor/dsh-core/src/index.ts'
import type { Store } from './store.ts'

export type FeishuConfig = { chatId: string; ownerId: string; botId: string; appId: string }
type Json = Record<string, any>
type Topic = { root: string; chatId: string; threadId?: string; deleted?: boolean }
type Mail = OutboundMessage & { status: ReplyStatus; error?: string }
const execute = promisify(execFile)
const id = (value: unknown, prefix: string): string => {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-zA-Z0-9]+$`).test(value)) throw new Error(`Invalid Feishu ${prefix} ID`)
  return value
}
async function command(cli: string, args: string[], auth = false): Promise<Json> {
  const { stdout } = await execute(cli, [...args, ...(auth ? ['--json', '--verify'] : ['--as', 'bot', '--format', 'json'])], {
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  })
  const result = JSON.parse(stdout)
  if (auth) return result
  if (result.ok !== true || result.identity !== 'bot' || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Invalid Feishu bot response')
  return result.data
}

export class Feishu {
  private readonly cli: string
  private ticking?: Promise<void>
  constructor(private readonly store: Store, readonly options: FeishuConfig & { cli?: string }) {
    id(options.chatId, 'oc'); id(options.ownerId, 'ou'); id(options.botId, 'ou'); id(options.appId, 'cli')
    this.cli = options.cli ?? 'lark-cli'
    const identity = { ownerId: options.ownerId, botId: options.botId, appId: options.appId }
    const pinned = store.get<Omit<FeishuConfig, 'chatId'>>('feishu.identity', options.chatId)
    if (pinned && (pinned.ownerId !== identity.ownerId || pinned.botId !== identity.botId || pinned.appId !== identity.appId)) throw new Error('Feishu stored identity changed; source stopped')
    if (!pinned) store.put('feishu.identity', options.chatId, identity)
    if (!store.get('feishu.cursor', options.chatId)) store.put('feishu.cursor', options.chatId, { started: Date.now(), since: Date.now() })
  }

  static async discover(cli = 'lark-cli'): Promise<Omit<FeishuConfig, 'chatId'>> {
    const status = await command(cli, ['auth', 'status'], true)
    if (status.brand !== 'feishu' || status.verified !== true || status.identities?.user?.verified !== true || status.identities?.bot?.verified !== true)
      throw new Error('Verified Feishu user and bot identities are required')
    return { ownerId: id(status.identities.user.openId, 'ou'), botId: id(status.identities.bot.openId, 'ou'), appId: id(status.appId, 'cli') }
  }

  tick(engine: Engine): Promise<void> { return this.ticking ??= this.run(engine).finally(() => { this.ticking = undefined }) }

  private async verifyIdentity(): Promise<void> {
    const current = await Feishu.discover(this.cli)
    if (current.ownerId !== this.options.ownerId || current.botId !== this.options.botId || current.appId !== this.options.appId) throw new Error('Feishu identity changed; source stopped')
  }

  private async run(engine: Engine): Promise<void> {
    await this.verifyIdentity()
    const errors: unknown[] = []
    try { await this.poll(engine) } catch (error) { errors.push(error) }
    try { await this.send() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '))
  }

  private async pages(container: string, kind: 'chat' | 'thread'): Promise<Json[]> {
    const result: Json[] = [], tokens = new Set<string>()
    let page: string | undefined
    do {
      const data = await command(this.cli, ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify({
        container_id_type: kind, container_id: container, page_size: 50, sort_type: 'ByCreateTimeAsc',
        ...(page ? { page_token: page } : {}),
      })])
      if (!Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw new Error('Incomplete Feishu message page')
      for (const message of data.items) {
        if (!message || message.chat_id !== this.options.chatId || (kind === 'thread' && message.thread_id !== container)) throw new Error('Feishu message outside requested chat/thread')
        id(message.message_id, 'om')
        result.push(message)
      }
      if (data.has_more && (typeof data.page_token !== 'string' || !data.page_token || tokens.has(data.page_token))) throw new Error('Feishu pagination did not advance')
      page = data.has_more ? data.page_token : undefined
      if (page) tokens.add(page)
    } while (page)
    return result
  }

  private async message(messageId: string): Promise<Json> {
    id(messageId, 'om')
    const data = await command(this.cli, ['api', 'GET', `/open-apis/im/v1/messages/${messageId}`])
    if (!Array.isArray(data.items) || data.items.length !== 1 || data.items[0]?.message_id !== messageId || data.items[0].chat_id !== this.options.chatId)
      throw new Error('Cannot verify Feishu message address')
    return data.items[0]
  }

  private async topic(root: string): Promise<Topic> {
    const message = await this.message(root)
    if (message.root_id && message.root_id !== root) throw new Error('Feishu destination is not a canonical root')
    const threadId = message.thread_id
    if (threadId) id(threadId, 'omt')
    return { root, chatId: this.options.chatId, ...(threadId ? { threadId } : {}), ...(message.deleted ? { deleted: true } : {}) }
  }

  private async poll(engine: Engine): Promise<void> {
    const cursor = this.store.get<{ started: number; since: number }>('feishu.cursor', this.options.chatId)!
    const until = Date.now()
    // shortcut: scan full chat/topic history to discover late replies on old roots; use events when personal-scale history grows costly.
    const messages = await this.pages(this.options.chatId, 'chat')
    const roots = new Set(this.store.list<Topic>('feishu.topic').filter(topic => topic.chatId === this.options.chatId).map(topic => topic.root))
    for (const message of messages) if (message.thread_id || message.root_id || message.sender?.id === this.options.ownerId) roots.add(id(message.root_id || message.message_id, 'om'))
    const errors: unknown[] = []
    for (const root of roots) {
      const notice = `feishu-topic:${this.options.chatId}:${root}`
      try {
        const topic = await this.topic(root)
        const replies = !topic.deleted && topic.threadId ? await this.pages(topic.threadId, 'thread') : []
        const own = messages.filter(message => (message.root_id || message.message_id) === root)
        for (const message of [...own, ...replies]) {
          if ((message.root_id || message.message_id) !== root) throw new Error('Feishu root mismatch')
          if (message.thread_id && message.thread_id !== topic.threadId) throw new Error('Feishu root/thread mismatch')
        }
        this.store.atomic(() => {
          this.store.put('feishu.topic', `${topic.chatId}:${root}`, topic)
          for (const message of [...own, ...replies]) this.ingest(engine, message, cursor.started, root)
          this.store.delete('notice', notice)
        })
      } catch (error) {
        this.store.put('notice', notice, { id: notice, text: String(error), root, chatId: this.options.chatId })
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '))
    this.store.put('feishu.cursor', this.options.chatId, { ...cursor, since: until })
  }

  private ingest(engine: Engine, message: Json, started: number, rootHint?: string): void {
    if (message.deleted || !['user', 'app'].includes(message.sender?.sender_type)) return
    const human = message.sender.sender_type === 'user', actorId = message.sender.id
    const root = id(message.root_id || rootHint || message.message_id, 'om')
    if (rootHint && root !== rootHint) throw new Error('Feishu root mismatch')
    const thread = `${this.options.chatId}:${root}`
    if (actorId !== this.options.ownerId && !this.store.threads.get(`feishu:${thread}`)?.subscriptions.length) return
    if (typeof actorId !== 'string' || !actorId.trim() || (human && message.sender.id_type !== 'open_id') || typeof message.create_time !== 'string' || !/^\d+$/.test(message.create_time)) throw new Error('Invalid Feishu sender or timestamp')
    const at = Number(message.create_time)
    if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) throw new Error('Invalid Feishu message time')
    if (at < started) return
    if (!['text', 'post'].includes(message.msg_type)) {
      this.store.put('notice', message.message_id, { id: message.message_id, text: 'Feishu input requires text or a text post; attachments are not downloaded.' })
      return
    }
    const body = JSON.parse(message.body?.content ?? '')
    const text = message.msg_type === 'text' ? body.text : JSON.stringify(body)
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty Feishu text')
    if (!human && [this.options.botId, this.options.appId].includes(actorId) && [...text.matchAll(/\[osa:([^\s\[\]]+)\]/g)].some(match => {
      const mail = this.store.get<Mail>('outbox', match[1])
      return mail?.channel.source === 'feishu' && mail.channel.thread === thread && text === `${mail.text}\n\n[osa:${mail.id}]`
    })) return
    this.store.atomic(() => {
      engine.receive({ id: key('feishu', message.message_id, text), source: 'feishu', actor: { source: 'feishu', id: actorId },
        human, addressed: 'direct', text, at: new Date(at).toISOString(), threads: [{ source: 'feishu', id: thread }],
        channel: { source: 'feishu', thread, address: { chatId: this.options.chatId, messageId: root } },
        meta: { chatId: this.options.chatId, messageId: message.message_id, rootId: root, senderType: message.sender.sender_type } })
      if (!this.store.get('feishu.topic', thread)) this.store.put('feishu.topic', thread, { root, chatId: this.options.chatId })
    })
  }

  private async send(): Promise<void> {
    const blocked = new Set<string>(), errors: unknown[] = []
    const messages = this.store.list<Mail>('outbox')
    if (messages.some(mail => mail.status === 'pending' && mail.channel.source === 'feishu')) await this.verifyIdentity()
    for (const mail of messages) {
      if (mail.status !== 'pending' || mail.channel.source !== 'feishu' || blocked.has(mail.channel.thread)) continue
      try {
        const { chatId, messageId } = mail.channel.address
        id(messageId, 'om')
        if (chatId !== this.options.chatId || mail.channel.thread !== `${chatId}:${messageId}` || !/^[\w:-]+$/.test(mail.id)) throw new Error('Invalid Feishu outbox address')
        const marker = `[osa:${mail.id}]`, topic = await this.topic(messageId)
        if (topic.deleted) throw new Error('Feishu root message was deleted')
        const replies = topic.threadId ? await this.pages(topic.threadId, 'thread') : []
        if (replies.some(message => (message.root_id || message.message_id) !== messageId)) throw new Error('Feishu root mismatch')
        const exists = replies.some(message => !message.deleted && message.sender?.sender_type === 'app'
          && [this.options.botId, this.options.appId].includes(message.sender?.id)
          && JSON.parse(message.body?.content ?? '{}').text === `${mail.text}\n\n${marker}`)
        if (!exists) {
          const previous = this.store.get<{ attemptedAt: number }>('feishu.send', mail.id)
          // Leave five minutes for command latency and clock skew inside Feishu's one-hour deduplication window.
          if (previous && Date.now() - previous.attemptedAt >= 55 * 60_000) throw new Error('Feishu reply uncertain beyond idempotency window; inspect before retrying')
          if (!previous) this.store.put('feishu.send', mail.id, { attemptedAt: Date.now() })
          const sent = await command(this.cli, ['im', '+messages-reply', '--message-id', messageId, '--text', `${mail.text}\n\n${marker}`,
            '--reply-in-thread', '--idempotency-key', key('feishu-reply', mail.id)])
          id(sent.message_id, 'om')
          if (sent.chat_id !== chatId) throw new Error('Feishu reply returned a different chat')
          const delivered = await this.message(sent.message_id)
          if (delivered.deleted || delivered.root_id !== messageId || !delivered.thread_id || (topic.threadId && delivered.thread_id !== topic.threadId)
            || delivered.sender?.sender_type !== 'app' || ![this.options.botId, this.options.appId].includes(delivered.sender?.id)
            || JSON.parse(delivered.body?.content ?? '{}').text !== `${mail.text}\n\n${marker}`) throw new Error('Cannot verify Feishu reply thread/sender/content')
          id(delivered.thread_id, 'omt')
        }
        this.store.put('outbox', mail.id, { ...mail, status: 'sent', error: undefined })
      } catch (error) {
        blocked.add(mail.channel.thread)
        this.store.put('outbox', mail.id, { ...mail, error: String(error) })
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '))
  }
}
