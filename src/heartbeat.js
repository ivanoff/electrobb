import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { local, silentTime, effectiveEvents, mergeIntervals } from './outages.js';

const MINUTE = 60_000;
export function heartbeatConfig(env = process.env) {
  if (!env.HEARTBEAT_PORT && !env.HEARTBEAT_TOKEN) return null;
  if (!/^\d+$/.test(env.HEARTBEAT_PORT || '') || Number(env.HEARTBEAT_PORT) < 1 || Number(env.HEARTBEAT_PORT) > 65535) {
    throw new Error('HEARTBEAT_PORT must be an integer from 1 to 65535');
  }
  if (!env.HEARTBEAT_TOKEN || /\s/.test(env.HEARTBEAT_TOKEN)) throw new Error('HEARTBEAT_TOKEN must be nonempty and contain no whitespace');
  const timeoutMinutes = Number(env.HEARTBEAT_TIMEOUT_MINUTES || 5);
  if (!Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 1) {
    throw new Error('HEARTBEAT_TIMEOUT_MINUTES must be a positive integer');
  }
  return { port: Number(env.HEARTBEAT_PORT), token: env.HEARTBEAT_TOKEN, timeoutMinutes };
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

export function powerMessage(online, at, schedule = {}) {
  const intervals = mergeIntervals(effectiveEvents(schedule));
  const interval = intervals.find(i => online ? i.start > at : i.end > at);
  const until = interval && (online ? interval.start : interval.end);
  let suffix = '';
  if (until != null) {
    const date = local(until), today = local(at);
    const label = date.toISODate() === today.toISODate() ? date.toFormat('HH:mm')
      : date.toISODate() === today.plus({ days: 1 }).toISODate()
        ? `завтра, ${date.toFormat('dd.MM HH:mm')}` : date.toFormat('dd.MM HH:mm');
    suffix = ` (до ${label})`;
  }
  return `${online ? '⚡️ Світло увімкнено' : '🪫 Світло вимкнено'} о ${local(at).toFormat('HH:mm')}${suffix}.`;
}

export class HeartbeatMonitor {
  constructor({ state = {}, save, send, config, timeoutMinutes = 5, now = Date.now, log = () => {}, getSchedule = () => ({}), refreshSchedule = async () => {} }) {
    this.state = { outages: [], outbox: [], ...state };
    Object.assign(this, { save, send, config, timeoutMinutes, now, log, getSchedule, refreshSchedule });
    // Older cache files have no explicit status: an open outage means offline.
    this.online = typeof state.online === 'boolean' ? state.online
      : state.observedUntil != null ? !this.state.outages.some(outage => outage.end == null) : null;
    this.startedAt = this.now();
    this.ready = false;
    // A previous process's last observation is the limit of known downtime.
    for (const outage of this.state.outages) if (outage.end == null) outage.end = this.state.observedUntil ?? outage.start;
    this.persist();
  }
  persist() { this.state.online = this.online; this.save(this.state); }
  enqueue(text) { this.state.outbox.push({ text, randomId: randomBytes(8).readBigInt64LE().toString() }); }
  enqueuePower(online, at) {
    this.enqueue(powerMessage(online, at, this.getSchedule()));
    Object.assign(this.state.outbox.at(-1), { power: { online, at } });
  }
  check(now) {
    if (!this.ready) {
      if (now - this.startedAt < this.timeoutMinutes * MINUTE) return;
      // The restart gap is unknown. Only count observations by this process.
      this.state.outages.push({ start: this.startedAt, end: null });
      if (this.online !== false) this.enqueuePower(false, this.startedAt);
      this.online = false;
      this.ready = true;
    }
    if (this.online && now - this.lastHeartbeat >= this.timeoutMinutes * MINUTE) {
      this.online = false;
      const start = this.lastHeartbeat + MINUTE;
      this.state.outages.push({ start, end: null });
      this.enqueuePower(false, start);
    }
    this.state.observedUntil = now;
  }
  heartbeat() {
    const now = this.now();
    this.check(now);
    if (!this.online) {
      const outage = this.state.outages.at(-1);
      if (outage?.end === null) outage.end = now;
      this.enqueuePower(true, now);
    }
    this.ready = true;
    this.online = true;
    this.lastHeartbeat = now;
    this.state.observedUntil = now;
    this.persist();
  }
  tick() {
    const now = this.now();
    this.check(now);
    if (!this.ready) return;
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
        if (item.power && !item.prepared) {
          await this.refreshSchedule();
          item.text = powerMessage(item.power.online, item.power.at, this.getSchedule());
          // Freeze the payload before sending: ambiguous failures retry the same ID and text.
          item.prepared = true;
          this.persist();
        }
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

export async function startHeartbeat({ port, token, timeoutMinutes = 5, path, send, config, log, getSchedule, refreshSchedule }) {
  let state = {};
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const monitor = new HeartbeatMonitor({ state, send, config, timeoutMinutes, log, getSchedule, refreshSchedule, save(value) {
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
