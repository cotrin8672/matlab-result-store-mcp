import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ProtocolError, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Job } from './jobs.ts';

const eventName = 'matlab.job.finished';
const jobId = z.string().uuid();
const args = z.object({ job_id: jobId, directory: z.string().min(1).refine(path.isAbsolute).optional() }).strict();
const destination = z.object({ mode: z.literal('webhook'), url: z.url() });
const subscription = z.object({ name: z.literal(eventName), arguments: args,
  delivery: destination.extend({ secret: z.string().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  cursor: z.null().optional(), ttlMs: z.number().int().positive().nullable().optional() });
type Subscription = { id: string; owner: string; job_id: string; url: string; secret: string;
  previous_secret: string | null; rotated_at: number; expires: number; verified_at: number };
type Delivery = { subscription_id: string; event_id: string; body: string; attempts: number; next_at: number };

export function jobOwner(context: ServerContext) {
  const auth = context.http?.authInfo;
  return auth ? createHash('sha256').update(JSON.stringify([auth.clientId, auth.extra?.sub ?? auth.token])).digest('hex') : 'local';
}

const privateV4 = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) privateV4.addSubnet(ip, prefix);
const globalV6 = new BlockList(), privateV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) privateV6.addSubnet(ip, prefix, 'ipv6');

export function publicAddress(address: string) {
  return isIP(address) === 4 ? !privateV4.check(address) : isIP(address) === 6 && globalV6.check(address, 'ipv6') && !privateV6.check(address, 'ipv6');
}

function signingKey(secret: string) {
  const value = secret.slice(6), key = Buffer.from(value, 'base64');
  if (!secret.startsWith('whsec_') || key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new ProtocolError(-32602, 'Webhook secret must be whsec_ followed by 24–64 bytes encoded as base64.');
  }
  return key;
}

export async function sendWebhook(sub: Pick<Subscription, 'id' | 'url' | 'secret' | 'previous_secret' | 'rotated_at'>, id: string, body: string) {
  const url = new URL(sub.url), hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Callback must be an HTTPS URL without credentials or a fragment.');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw new Error('Callback must resolve only to public IP addresses.');
  if (Buffer.byteLength(body) > 262144) throw new Error('Webhook body exceeds 256 KiB.');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secrets = [sub.secret, ...(sub.previous_secret && Date.now() - sub.rotated_at < 120000 ? [sub.previous_secret] : [])];
  const signature = secrets.map(secret => 'v1,' + createHmac('sha256', signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')).join(' ');
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    // Pin the checked address; TLS still verifies the original hostname. Native HTTPS never follows redirects.
    const req = request(url, { method: 'POST', agent: false, family: addresses[0].family, signal: AbortSignal.timeout(10000),
      lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, addresses[0].family),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature, 'X-MCP-Subscription-Id': sub.id } }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16384) { res.destroy(new Error('Webhook response exceeds 16 KiB.')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

export class JobEvents {
  private db: DatabaseSync;
  private getJob: (id: string, owner: string) => Job;
  constructor(db: DatabaseSync, getJob: (id: string, owner: string) => Job) {
    this.db = db; this.getJob = getJob;
    db.exec(`CREATE TABLE IF NOT EXISTS event_subscriptions (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, job_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
      previous_secret TEXT, rotated_at INTEGER NOT NULL, expires INTEGER NOT NULL, verified_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_deliveries (subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(subscription_id, event_id));`);
  }

  static register(server: McpServer, getEvents: (directory?: string) => JobEvents) {
    // Events is a draft extension; SDK 2.3.1 accepts custom capabilities but has no Events type yet.
    const capabilities = { ...server.server.getCapabilities(), events: {} };
    server.server.registerCapabilities(capabilities);
    server.server.setRequestHandler('events/list', { params: z.object({ cursor: z.null().optional() }).default({}) }, () => ({ events: [{
      name: eventName, description: 'A MATLAB Job completed, failed, or was cancelled. Filter by job_id and pass directory when using a nondefault Store. Retrieve logs and output variables with get_matlab_job.',
      delivery: ['webhook'], inputSchema: z.toJSONSchema(args),
      payloadSchema: { type: 'object', properties: { job_id: { type: 'string' }, backend: { enum: ['background', 'worker'] },
        state: { enum: ['succeeded', 'failed', 'cancelled'] }, result_uri: { type: 'string' } },
        required: ['job_id', 'backend', 'state', 'result_uri'], additionalProperties: false },
    }] }));
    server.server.setRequestHandler('events/subscribe', { params: subscription }, (value, context) => getEvents(value.arguments.directory).subscribe(value, jobOwner(context)));
    server.server.setRequestHandler('events/unsubscribe', { params: z.object({ name: z.literal(eventName), arguments: args, delivery: destination.strict() }) }, (value, context) => {
      const events = getEvents(value.arguments.directory), owner = jobOwner(context), id = events.identity(owner, value.delivery.url, value.arguments.job_id);
      events.db.prepare('DELETE FROM event_subscriptions WHERE id=? AND owner=?').run(id, owner);
      return {};
    });
  }

  private identity(owner: string, url: string, job: string) {
    return 'sub_' + createHash('sha256').update(JSON.stringify([owner, url, eventName, { job_id: job }])).digest('hex');
  }

  async subscribe(value: z.infer<typeof subscription>, owner: string) {
    const job = this.getJob(value.arguments.job_id, owner);
    signingKey(value.delivery.secret);
    const id = this.identity(owner, value.delivery.url, job.job_id), now = Date.now();
    const old = this.db.prepare('SELECT * FROM event_subscriptions WHERE id=? AND owner=?').get(id, owner) as Subscription | undefined;
    const next: Subscription = { id, owner, job_id: job.job_id, url: value.delivery.url, secret: value.delivery.secret,
      previous_secret: old && old.secret !== value.delivery.secret ? old.secret : old?.previous_secret ?? null,
      rotated_at: old && old.secret !== value.delivery.secret ? now : old?.rotated_at ?? 0,
      expires: now + Math.min(86400000, Math.max(60000, value.ttlMs ?? 86400000)), verified_at: old?.verified_at ?? 0 };
    if (!old || old.secret !== next.secret || now - next.verified_at > 600000) {
      const challenge = randomUUID(), body = JSON.stringify({ type: 'verification', challenge });
      try {
        const response = await sendWebhook(next, 'msg_verification_' + randomUUID(), body);
        const echoed = JSON.parse(response.body).challenge;
        const bytes = typeof echoed === 'string' ? Buffer.from(echoed) : Buffer.alloc(0);
        if (response.status < 200 || response.status >= 300 || bytes.length !== Buffer.byteLength(challenge) || !timingSafeEqual(bytes, Buffer.from(challenge))) throw new Error('Challenge verification failed.');
      } catch (error) {
        throw new ProtocolError(-32015, 'Webhook callback verification failed.', { reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'challenge_failed' });
      }
      next.verified_at = now;
    }
    this.db.prepare('INSERT OR REPLACE INTO event_subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(next.id, next.owner, next.job_id, next.url, next.secret, next.previous_secret, next.rotated_at, next.expires, next.verified_at);
    const saved = this.db.prepare('SELECT body FROM events WHERE job_id=?').get(job.job_id) as { body: string } | undefined;
    // A fast Job can finish before the client subscribes; enqueue its stored completion too.
    if (saved) this.publish(job);
    return { id, refreshBefore: new Date(next.expires).toISOString(), cursor: null, truncated: false };
  }

  publish(job: Job) {
    if (!['succeeded', 'failed', 'cancelled'].includes(job.state)) return;
    const id = 'evt_' + job.job_id;
    const body = JSON.stringify({ eventId: id, name: eventName, timestamp: job.finished_at ?? job.updated_at,
      data: { job_id: job.job_id, backend: job.backend, state: job.state, result_uri: job.result_uri }, cursor: null });
    this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?)').run(id, job.job_id, body);
    this.db.prepare(`INSERT OR IGNORE INTO event_deliveries (subscription_id, event_id, body)
      SELECT id, ?, ? FROM event_subscriptions WHERE job_id=? AND expires>?`).run(id, body, job.job_id, Date.now());
  }

  async flush() {
    const now = Date.now();
    const deliveries = this.db.prepare(`UPDATE event_deliveries SET next_at=? WHERE rowid IN
      (SELECT d.rowid FROM event_deliveries d JOIN event_subscriptions s ON s.id=d.subscription_id
       WHERE d.done=0 AND d.next_at<=? AND s.expires>? LIMIT 8) RETURNING *`).all(now + 30000, now, now) as Delivery[];
    await Promise.all(deliveries.map(async delivery => {
      const sub = this.db.prepare('SELECT * FROM event_subscriptions WHERE id=? AND expires>?').get(delivery.subscription_id, Date.now()) as Subscription | undefined;
      if (!sub) return;
      let status = 0;
      try {
        this.getJob(sub.job_id, sub.owner);
        status = (await sendWebhook(sub, delivery.event_id, delivery.body)).status;
      } catch { /* A failed attempt stays queued with the same event ID. */ }
      const attempts = delivery.attempts + 1;
      const done = status >= 200 && status < 300 || status === 410 || status === 413 || attempts >= 6 || status >= 400 && status < 500 && status !== 408 && status !== 429;
      this.db.prepare('UPDATE event_deliveries SET attempts=?, next_at=?, done=? WHERE subscription_id=? AND event_id=?')
        .run(attempts, Date.now() + 1000 * 2 ** attempts, Number(done), delivery.subscription_id, delivery.event_id);
    }));
  }
}
