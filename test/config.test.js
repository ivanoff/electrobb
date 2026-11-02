import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv } from '../src/config.js';
import { parseDate, silentTime, quietTime, upcomingQuietWindow, upcomingQuietIntervals } from '../src/outages.js';
import { newState, planNotifications } from '../src/notifications.js';

test('missing or empty quiet hours disable suppression throughout the day', () => {
  for (const overrides of [{}, { QUIET_HOURS_START: '', QUIET_HOURS_END: '' }]) {
    const config = configFromEnv({ BOT_ACCOUNT: '123456789', ...overrides });
    for (let minute = 0; minute < 1440; minute++) {
      const now = parseDate('23-10-2026 00:00') + minute * 60000;
      assert.equal(quietTime(now, config), false);
    }
    const now = parseDate('23-10-2026 23:00');
    const state = newState();
    state.snapshot.events = [{ start: now + 600000, end: now + 1800000, kind: 'planned' }];
    assert.equal(upcomingQuietWindow(now, config), null);
    assert.deepEqual(upcomingQuietIntervals(state, now, config), []);
    assert.ok(planNotifications(state, now, config).notifications.length > 0);
    assert.equal(silentTime(now, config), true);
  }
});

test('quiet hours require a complete valid pair and respect configured boundaries', () => {
  const env = { BOT_ACCOUNT: '123456789', QUIET_HOURS_START: '22:00', QUIET_HOURS_END: '09:00' };
  for (const name of ['QUIET_HOURS_START', 'QUIET_HOURS_END']) {
    assert.throws(() => configFromEnv({ ...env, [name]: undefined }), /must be set together/);
    for (const value of ['24:00', '12:60', '9:00', 'invalid']) {
      assert.throws(() => configFromEnv({ ...env, [name]: value }), new RegExp(name));
    }
  }
  assert.throws(() => configFromEnv({ ...env, QUIET_HOURS_END: '22:00' }), /must differ/);
  const config = configFromEnv(env);
  for (const [time, expected] of [['21:59', false], ['22:00', true], ['00:00', true], ['08:59', true], ['09:00', false]]) {
    assert.equal(quietTime(parseDate(`23-10-2026 ${time}`), config), expected, time);
  }
});

test('silent hours have defaults and can be configured independently', () => {
  const env = { BOT_ACCOUNT: '123456789' };
  const defaults = configFromEnv(env);
  assert.equal(defaults.silentStart, 1200);
  assert.equal(defaults.silentEnd, 660);
  for (const [start, end, cases] of [
    ['21:15', '08:45', [['21:14',false],['21:15',true],['00:00',true],['08:44',true],['08:45',false]]],
    ['12:15', '14:45', [['12:14',false],['12:15',true],['14:44',true],['14:45',false],['00:00',false]]],
  ]) {
    const config = configFromEnv({ ...env, SILENT_HOURS_START: start, SILENT_HOURS_END: end });
    for (const [time, expected] of cases) assert.equal(silentTime(parseDate(`23-10-2026 ${time}`), config), expected, time);
  }
});

test('invalid silent hours are rejected', () => {
  const env = { BOT_ACCOUNT: '123456789' };
  for (const name of ['SILENT_HOURS_START', 'SILENT_HOURS_END']) {
    for (const value of ['24:00', '12:60', '9:00', 'invalid']) {
      assert.throws(() => configFromEnv({ ...env, [name]: value }), new RegExp(name));
    }
  }
  assert.throws(() => configFromEnv({ ...env, SILENT_HOURS_START: '12:00', SILENT_HOURS_END: '12:00' }), /must differ/);
});
