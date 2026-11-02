import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { local, silentTime } from './outages.js';

const MINUTE = 60_000;
export function heartbeatConfig(env = process.env) {
  if (!env.HEARTBEAT_PORT && !env.HEARTBEAT_TOKEN) return null;
  if (!/^\d+$/.test(env.HEARTBEAT_PORT || '') || Number(env.HEARTBEAT_PORT) < 1 || Number(env.HEARTBEAT_PORT) > 65535) {
    throw new Error('HEARTBEAT_PORT must be an integer from 1 to 65535');
  }
  if (!env.HEARTBEAT_TOKEN || /\s/.test(env.HEARTBEAT_TOKEN)) throw new Error('HEARTBEAT_TOKEN must be nonempty and contain no whitespace');
  return { port: Number(env.HEARTBEAT_PORT), token: env.HEARTBEAT_TOKEN };
}

export function dailyReport(state, date) {
  const start = date.startOf('day').toMillis(), end = date.plus({ days: 1 }).startOf('day').toMillis();
  const intervals = state.outages.map(i => ({ start: Math.max(start, i.start), end: Math.min(end, i.end ?? state.observedUntil) }))
    .filter(i => i.end > i.start);
  const seconds = Math.floor(intervals.reduce((sum, i) => sum + i.end - i.start, 0) / 1000);
  if (seconds === 24 * 60 * 60) return [];
  const duration = `${Math.floor(seconds / 3600)} год ${Math.floor(seconds % 3600 / 60)} хв ${seconds % 60} с`;
  const lines = intervals.map(i => `${local(i.start).toFormat('HH:mm:ss')}–${i.end === end ? '24:00:00' : local(i.end).toFormat('HH:mm:ss')}`);
  // Split long lists to stay within Telegram's message limit.
  const header = `Статистика за ${date.toFormat('dd.MM.yyyy')}: без світла ${duration}.\nЛише за час спостереження; невідомі періоди не враховано.`;
  const parts = [header];
  for (const line of lines.length ? lines : ['Зафіксованих відключень немає.']) {
    if (parts.at(-1).length + line.length > 3500) parts.push(`Продовження за ${date.toFormat('dd.MM.yyyy')}:`);
    parts[parts.length - 1] += '\n' + line;
  }
  return parts;
}

export class HeartbeatMonitor {
  constructor({ state = {}, save, send, config, now = Date.now, log = () => {} }) {
    this.state = { outages: [], outbox: [], ...state };
    Object.assign(this, { save, send, config, now, log });
    this.online = false;
    this.ready = false;
    // A previous process's last observation is the limit of known downtime.
    for (const outage of this.state.outages) if (outage.end == null) outage.end = this.state.observedUntil ?? outage.start;
    this.persist();
  }
  persist() { this.save(this.state); }
  enqueue(text) { this.state.outbox.push({ text, randomId: randomBytes(8).readBigInt64LE().toString() }); }
  check(now) {
    if (!this.ready) return;
    if (this.online && now - this.lastHeartbeat >= 5 * MINUTE) {
      this.online = false;
      const start = this.lastHeartbeat + MINUTE;
      this.state.outages.push({ start, end: null });
      this.enqueue(`🔴 Світло вимкнено о ${local(start).toFormat('dd.MM.yyyy HH:mm:ss')}.`);
    }
    this.state.observedUntil = now;
  }
  heartbeat() {
    const now = this.now();
    this.check(now);
    if (!this.online) {
      const outage = this.state.outages.at(-1);
      if (outage?.end === null) outage.end = now;
      this.enqueue(`🟢 Світло увімкнено о ${local(now).toFormat('dd.MM.yyyy HH:mm:ss')}.`);
    }
    this.ready = true;
    this.online = true;
    this.lastHeartbeat = now;
    this.state.observedUntil = now;
    this.persist();
  }
  tick() {
    if (!this.ready) return;
    const now = this.now();
    this.check(now);
    const today = local(now);
    const reportDay = today.minus({ days: 1 }).toISODate();
    if (today.hour >= 8 && this.state.reportDay !== reportDay) {
      for (const text of dailyReport(this.state, today.minus({ days: 1 }))) this.enqueue(text);
      this.state.reportDay = reportDay;
    }
    this.persist();
  }
  async deliver() {
    if (!this.ready || this.delivering || (this.retryAt || 0) > this.now()) return;
    this.delivering = true;
    try {
      while (this.state.outbox.length) {
        const item = this.state.outbox[0];
        await this.send(item.text, item.randomId, { silent: silentTime(this.now(), this.config) });
        this.state.outbox.shift();
        this.persist();
      }
    } catch (error) {
      const seconds = Number((error.error_message || '').match(/(?:FLOOD_WAIT|SLOWMODE_WAIT)_(\d+)/)?.[1] || 60);
      this.retryAt = this.now() + seconds * 1000;
      this.log('heartbeat_send_failed', { error: error.error_message || error.message });
    } finally { this.delivering = false; }
  }
}

export function heartbeatServer({ monitor, token, log = () => {} }) {
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer((req, res) => {
    req.resume();
    if (req.url !== '/heartbeat') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401).end(); return; }
    try {
      monitor.heartbeat();
      res.writeHead(204).end();
    } catch (error) {
      log('heartbeat_failed', { error: error.message });
      res.writeHead(500).end();
    }
  });
}

export async function startHeartbeat({ port, token, path, send, config, log }) {
  let state = {};
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const monitor = new HeartbeatMonitor({ state, send, config, log, save(value) {
    writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  } });
  const server = heartbeatServer({ monitor, token, log });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  setInterval(() => {
    try { monitor.tick(); void monitor.deliver(); }
    catch (error) { log('heartbeat_tick_failed', { error: error.message }); }
  }, 1000);
  log('heartbeat_started', { port });
  return { server, monitor };
}
