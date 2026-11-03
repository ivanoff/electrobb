import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatMonitor, heartbeatServer, heartbeatConfig, dailyReport, powerMessage } from '../src/heartbeat.js';
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
  assert.equal(f.sent[0][0], '⚡️ Світло увімкнено о 12:00.');
  assert.equal(f.sent[1][0], '🪫 Світло вимкнено о 12:01.');
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
  assert.deepEqual(heartbeatConfig({ HEARTBEAT_PORT: '3000', HEARTBEAT_TOKEN: 'x' }), { port: 3000, token: 'x', timeoutMinutes: 5 });
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

test('configured heartbeat timeout controls confirmation boundary', () => {
  for (const timeoutMinutes of [1, 3, 10]) {
    const options = heartbeatConfig({ HEARTBEAT_PORT: '3000', HEARTBEAT_TOKEN: 'x',
      HEARTBEAT_TIMEOUT_MINUTES: String(timeoutMinutes) });
    const f = setup();
    f.monitor.timeoutMinutes = options.timeoutMinutes;
    f.monitor.heartbeat();
    const boundary = parseDate('01-11-2026 12:00') + timeoutMinutes * 60000;
    f.monitor.check(boundary - 1);
    assert.equal(f.monitor.online, true);
    f.monitor.check(boundary);
    assert.equal(f.monitor.online, false);
    assert.equal(f.monitor.state.outages[0].start, parseDate('01-11-2026 12:01'));
  }
  for (const value of ['0', '-1', '1.5', 'abc', 'Infinity']) {
    assert.throws(() => heartbeatConfig({ HEARTBEAT_PORT: '3000', HEARTBEAT_TOKEN: 'x',
      HEARTBEAT_TIMEOUT_MINUTES: value }), /HEARTBEAT_TIMEOUT_MINUTES/);
  }
});

const scheduleOf = ranges => ({ snapshot: { events: ranges.map(([start, end]) => ({
  kind: 'planned', start: parseDate(start), end: parseDate(end),
})) } });

test('power messages follow the six examples and exact interval boundaries', () => {
  const schedule = scheduleOf([
    ['03-11-2026 13:00', '03-11-2026 16:00'],
    ['03-11-2026 20:00', '03-11-2026 22:00'],
  ]);
  for (const [online, time, until] of [
    [true, '12:00', '13:00'], [true, '14:00', '20:00'], [true, '23:00', null],
    [false, '12:00', '16:00'], [false, '14:00', '16:00'], [false, '23:00', null],
    [true, '13:00', '20:00'], [false, '16:00', '22:00'], [false, '22:00', null],
  ]) {
    assert.equal(powerMessage(online, parseDate(`03-11-2026 ${time}`), schedule),
      `${online ? '⚡️ Світло увімкнено' : '🪫 Світло вимкнено'} о ${time}${until ? ` (до ${until})` : ''}.`);
  }
});

test('power forecasts merge overlapping and adjacent intervals and label future dates', () => {
  const schedule = scheduleOf([
    ['03-11-2026 13:00', '03-11-2026 16:00'],
    ['03-11-2026 15:00', '03-11-2026 17:00'],
    ['03-11-2026 17:00', '04-11-2026 06:00'],
  ]);
  assert.equal(powerMessage(false, parseDate('03-11-2026 14:00'), schedule),
    '🪫 Світло вимкнено о 14:00 (до завтра, 04.11 06:00).');
  assert.equal(powerMessage(true, parseDate('03-11-2026 14:00'), schedule),
    '⚡️ Світло увімкнено о 14:00.');
  const future = scheduleOf([['04-11-2026 06:00', '05-11-2026 10:00']]);
  assert.equal(powerMessage(true, parseDate('03-11-2026 23:00'), future),
    '⚡️ Світло увімкнено о 23:00 (до завтра, 04.11 06:00).');
  assert.equal(powerMessage(false, parseDate('03-11-2026 23:00'), future),
    '🪫 Світло вимкнено о 23:00 (до 05.11 10:00).');
});

test('heartbeat uses latest schedule and outage event time before timeout confirmation', () => {
  const f = setup({}, '03-11-2026 15:58');
  let schedule = {};
  f.monitor.getSchedule = () => schedule;
  f.monitor.heartbeat();
  assert.equal(f.monitor.state.outbox.at(-1).text, '⚡️ Світло увімкнено о 15:58.');
  schedule = scheduleOf([
    ['03-11-2026 13:00', '03-11-2026 16:00'],
    ['03-11-2026 20:00', '03-11-2026 22:00'],
  ]);
  f.set('03-11-2026 16:03'); f.monitor.check(parseDate('03-11-2026 16:03'));
  assert.equal(f.monitor.state.outbox.at(-1).text, '🪫 Світло вимкнено о 15:59 (до 16:00).');
  f.monitor.heartbeat();
  assert.equal(f.monitor.state.outbox.at(-1).text, '⚡️ Світло увімкнено о 16:03 (до 20:00).');
});


test('power forecast is built after awaited refresh and frozen for delivery retries', async () => {
  const f = setup({}, '03-11-2026 14:58');
  f.monitor.heartbeat(); await f.monitor.deliver();
  f.sent.length = 0;
  let schedule = scheduleOf([['03-11-2026 20:00', '03-11-2026 23:30']]);
  f.monitor.getSchedule = () => schedule;
  let refreshes = 0;
  f.monitor.refreshSchedule = async () => {
    refreshes++;
    await Promise.resolve();
    schedule = scheduleOf([['03-11-2026 14:44', '03-11-2026 16:00']]);
  };
  f.set('03-11-2026 15:03'); f.monitor.check(parseDate('03-11-2026 15:03'));
  const attempts = [];
  f.monitor.send = async (text, id) => { attempts.push({ text, id }); if (attempts.length === 1) throw new Error('offline'); };
  await f.monitor.deliver();
  assert.equal(attempts[0].text, '🪫 Світло вимкнено о 14:59 (до 16:00).');
  schedule = {};
  f.set('03-11-2026 15:04'); await f.monitor.deliver();
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(refreshes, 1);
});

for (const previousOnline of [true, false]) {
  for (const confirmedOnline of [true, false]) {
    test(`restart restores ${previousOnline}, confirmation ${confirmedOnline} only announces a change`, async () => {
      const first = setup();
      first.monitor.heartbeat();
      first.set('01-11-2026 12:05');
      if (previousOnline) first.monitor.heartbeat();
      first.monitor.tick();
      await first.monitor.deliver();
      assert.equal(first.saved().online, previousOnline);
      const restarted = setup(first.saved(), '02-11-2026 12:00');
      restarted.monitor.timeoutMinutes = 3;
      assert.equal(restarted.monitor.online, previousOnline);
      assert.equal(restarted.monitor.ready, false);
      restarted.set('02-11-2026 12:02');
      restarted.monitor.tick();
      await restarted.monitor.deliver();
      assert.equal(restarted.sent.length, 0);
      if (confirmedOnline) restarted.monitor.heartbeat();
      else {
        restarted.set('02-11-2026 12:03');
        restarted.monitor.tick();
      }
      await restarted.monitor.deliver();
      assert.equal(restarted.monitor.ready, true);
      assert.equal(restarted.saved().online, confirmedOnline);
      const powerMessages = () => restarted.sent.filter(([text]) => /Світло/.test(text));
      assert.equal(powerMessages().length, previousOnline === confirmedOnline ? 0 : 1);
      if (previousOnline !== confirmedOnline) {
        assert.match(powerMessages()[0][0], confirmedOnline ? /увімкнено о 12:02/ : /вимкнено о 12:00/);
      }
      restarted.monitor.tick();
      await restarted.monitor.deliver();
      assert.equal(powerMessages().length, previousOnline === confirmedOnline ? 0 : 1);
      if (!confirmedOnline) {
        assert.equal(restarted.monitor.state.outages.at(-1).start, parseDate('02-11-2026 12:00'));
      }
    });
  }
}

test('legacy cache restores status from last observation before closing old outage', () => {
  const observedUntil = parseDate('01-11-2026 12:00');
  for (const online of [true, false]) {
    const f = setup({ observedUntil, outages: online ? [] : [{ start: observedUntil - 60000, end: null }] });
    assert.equal(f.monitor.online, online);
    assert.equal(f.saved().online, online);
    const again = setup(f.saved());
    assert.equal(again.monitor.online, online);
  }
});

test('without history startup is unknown and absence is confirmed after timeout', async () => {
  const f = setup();
  assert.equal(f.monitor.online, null);
  f.set('01-11-2026 12:04'); f.monitor.tick();
  assert.equal(f.monitor.ready, false);
  f.set('01-11-2026 12:05'); f.monitor.tick();
  await f.monitor.deliver();
  assert.equal(f.saved().online, false);
  assert.equal(f.sent.filter(([text]) => /Світло вимкнено/.test(text)).length, 1);
});
