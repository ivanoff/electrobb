import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatMonitor, heartbeatServer, heartbeatConfig, dailyReport } from '../src/heartbeat.js';
import { local, parseDate } from '../src/outages.js';

function setup(state = {}, start = '01-11-2026 12:00') {
  let now = parseDate(start), saved;
  const sent = [];
  const monitor = new HeartbeatMonitor({ state, now: () => now, save: s => { saved = structuredClone(s); },
    send: async (...args) => { sent.push(args); }, config: { silentStart: 1200, silentEnd: 660 } });
  return { monitor, sent, set: value => { now = typeof value === 'string' ? parseDate(value) : value; }, saved: () => saved };
}
test('five misses: report 12:01 at 12:05, recover once, ignore startup time', async () => {
  const f = setup();
  f.monitor.tick(); await f.monitor.deliver();
  assert.equal(f.sent.length, 0);
  f.monitor.heartbeat(); await f.monitor.deliver();
  assert.equal(f.sent.length, 1);
  f.set('01-11-2026 12:01'); f.monitor.check(parseDate('01-11-2026 12:01'));
  assert.equal(f.monitor.online, true);
  f.set(parseDate('01-11-2026 12:00') + 299999); f.monitor.check(parseDate('01-11-2026 12:00') + 299999);
  assert.equal(f.monitor.online, true);
  assert.equal(f.monitor.state.outages.length, 0);
  f.set('01-11-2026 12:05'); f.monitor.check(parseDate('01-11-2026 12:05'));
  await f.monitor.deliver();
  assert.match(f.sent[1][0], /12:01:00/);
  f.set('01-11-2026 12:05'); f.monitor.heartbeat(); f.monitor.heartbeat(); await f.monitor.deliver();
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.monitor.state.outages, [{ start: parseDate('01-11-2026 12:01'), end: parseDate('01-11-2026 12:05') }]);
});
test('request after timeout detects outage even before timer runs; gap below five minutes does not', () => {
  const f = setup(); f.monitor.heartbeat();
  f.set(parseDate('01-11-2026 12:00') + 299999); f.monitor.heartbeat();
  assert.equal(f.monitor.state.outages.length, 0);
  f.set('01-11-2026 12:10'); f.monitor.heartbeat();
  assert.equal(f.monitor.state.outages.length, 1);
});
test('restart retains history but excludes unobserved time and waits for heartbeat', async () => {
  const f = setup(); f.monitor.heartbeat(); f.set('01-11-2026 12:06'); f.monitor.tick();
  const restarted = setup(f.saved(), '02-11-2026 08:00');
  restarted.monitor.tick(); await restarted.monitor.deliver(); assert.equal(restarted.sent.length, 0);
  restarted.monitor.heartbeat(); restarted.monitor.tick(); await restarted.monitor.deliver();
  assert.equal(restarted.monitor.state.outages[0].end, parseDate('01-11-2026 12:06'));
  const report = restarted.sent.find(([text]) => text.startsWith('Статистика за 01.11.2026'));
  assert.match(report[0], /0 год 5 хв 0 с/);
  assert.equal(report[2].silent, true);
  const count = restarted.sent.length;
  restarted.monitor.tick(); await restarted.monitor.deliver(); assert.equal(restarted.sent.length, count);
});
test('daily report clips intervals at midnight and uses actual DST day duration', () => {
  const state = { outages: [{ start: parseDate('31-10-2026 23:00'), end: parseDate('02-11-2026 01:00') }] };
  assert.deepEqual(dailyReport(state, local(parseDate('01-11-2026 12:00'))), []);
  assert.match(dailyReport(state, local(parseDate('31-10-2026 12:00')))[0], /23:00:00–24:00:00/);
  const dst = { outages: [{ start: parseDate('25-10-2026 00:00'), end: parseDate('26-10-2026 00:00') }] };
  assert.match(dailyReport(dst, local(dst.outages[0].start))[0], /25 год/);
});
test('failed deliveries retry with same Telegram random ID', async () => {
  const f = setup(); let calls = [];
  f.monitor.send = async (text, id) => { calls.push(id); if (calls.length === 1) throw new Error('offline'); };
  f.monitor.heartbeat(); await f.monitor.deliver();
  assert.equal(f.monitor.state.outbox.length, 1);
  f.set('01-11-2026 12:01'); await f.monitor.deliver();
  assert.equal(calls[0], calls[1]); assert.equal(f.monitor.state.outbox.length, 0);
});
test('HTTP endpoint accepts only POST with correct bearer token', async () => {
  let count = 0;
  const server = heartbeatServer({ monitor: { heartbeat() { count++; } }, token: 'secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/heartbeat`;
  try {
    for (const [method, token, status] of [['GET', 'secret', 405], ['POST', '', 401], ['POST', 'wrong!', 401], ['POST', 'secret', 204]]) {
      const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, status);
    }
    assert.equal(count, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('port and token must be configured together', () => {
  assert.equal(heartbeatConfig({}), null);
  for (const env of [{ HEARTBEAT_PORT: '3000' }, { HEARTBEAT_TOKEN: 'x' }, { HEARTBEAT_PORT: '65536', HEARTBEAT_TOKEN: 'x' }]) assert.throws(() => heartbeatConfig(env));
  assert.deepEqual(heartbeatConfig({ HEARTBEAT_PORT: '3000', HEARTBEAT_TOKEN: 'x' }), { port: 3000, token: 'x' });
});

test('startup and confirmation grace do not enable accelerated schedule queries', () => {
  const f = setup();
  const powerOff = () => f.monitor.ready && !f.monitor.online;
  assert.equal(powerOff(), false);
  f.monitor.heartbeat();
  f.set('01-11-2026 12:04'); f.monitor.tick(); assert.equal(powerOff(), false);
  f.set('01-11-2026 12:05'); f.monitor.tick(); assert.equal(powerOff(), true);
  f.monitor.heartbeat(); assert.equal(powerOff(), false);
});


test('24-hour report is skipped and marked processed; shorter outages are reported', async () => {
  const f = setup({ outages: [{ start: parseDate('01-11-2026 00:00'), end: parseDate('02-11-2026 00:00') }] }, '02-11-2026 08:00');
  f.monitor.heartbeat(); await f.monitor.deliver();
  f.sent.length = 0;
  f.monitor.tick(); await f.monitor.deliver();
  assert.equal(f.sent.length, 0);
  assert.equal(f.saved().reportDay, '2026-11-01');
  f.monitor.tick(); await f.monitor.deliver();
  assert.equal(f.sent.length, 0);
  const shorter = { outages: [{ start: parseDate('01-11-2026 00:00'), end: parseDate('02-11-2026 00:00') - 1000 }] };
  assert.match(dailyReport(shorter, local(parseDate('01-11-2026 12:00')))[0], /23 год 59 хв 59 с/);
});
