import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loginQr } from '../src/login-qr.js';
test('QR acceptance migrates DC and imports the returned token', async () => {
  const updates = new EventEmitter(); const calls = []; let count = 0; let dc;
  await loginQr({ updates, setDc: async id => { dc = id; },
    show: url => { assert.equal(url, 'tg://login?token=-_8'); updates.emit('updateShort', { update: { _: 'updateLoginToken' } }); },
    call: async (method, params) => {
      calls.push(method);
      if (method === 'auth.importLoginToken') { assert.equal(dc, 4); assert.deepEqual(params.token, [1]); return { _: 'auth.loginTokenSuccess' }; }
      return count++ === 0 ? { _: 'auth.loginToken', token: [251, 255], expires: Date.now()/1000+30 } : { _: 'auth.loginTokenMigrateTo', dc_id: 4, token: [1] };
    } });
  assert.deepEqual(calls, ['auth.exportLoginToken', 'auth.exportLoginToken', 'auth.importLoginToken']);
  assert.equal(updates.eventNames().length, 0);
});
test('2FA error propagates to login password handler and removes listeners', async () => {
  const updates = new EventEmitter();
  await assert.rejects(loginQr({ updates, call: async () => { throw new Error('SESSION_PASSWORD_NEEDED'); } }), /SESSION_PASSWORD_NEEDED/);
  assert.equal(updates.eventNames().length, 0);
});
