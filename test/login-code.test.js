import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestLoginCode } from '../src/login-code.js';
const initial = { _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp' }, phone_code_hash: 'first', timeout: 30, next_type: { _: 'auth.codeTypeSms' } };
test('resend obeys timer and uses the replacement hash', async () => {
  let time = 0;
  const methods = [], logs = [];
  const answers = ['/resend', '/resend', '12345'];
  const result = await requestLoginCode({ phone_number: 'test', now: () => time, log: text => logs.push(text),
    ask: async () => { if (answers.length === 2) time = 31000; return answers.shift(); },
    call: async (method, params) => { methods.push(method); if (method === 'auth.sendCode') return initial;
      assert.equal(params.phone_code_hash, 'first'); return { ...initial, phone_code_hash: 'second', type: { _: 'auth.sentCodeTypeSms' } }; } });
  assert.deepEqual(methods, ['auth.sendCode', 'auth.resendCode']);
  assert.equal(result.phone_code_hash, 'second');
  assert(logs.some(s => s.includes('30 сек')));
});
test('no alternative means no resend request', async () => {
  const answers = ['/resend', '12345']; let calls = 0;
  await requestLoginCode({ phone_number: 'test', log: () => {}, ask: async () => answers.shift(), call: async () => {
    calls++; return { ...initial, next_type: undefined }; } });
  assert.equal(calls, 1);
});
test('successful authorization does not prompt for a code', async () => {
  assert.deepEqual(await requestLoginCode({ phone_number: 'test', call: async () => ({ _: 'auth.sentCodeSuccess' }),
    ask: () => { throw new Error('unexpected prompt'); } }), { authorized: true });
});
