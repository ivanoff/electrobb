import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshReplies } from '../src/replies.js';
const old = { id: 10, message: 'старый график' };
test('does not resend history or outgoing request', () => {
  assert.deepEqual(freshReplies([old], [old, { id: 11, out: true, message: '/status' }]), []);
});
test('collects text and media replies, excludes outgoing request', () => {
  const replies = [{ id: 12, message: 'сегодня' }, { id: 13, media: { photo: { id: '123' } } }];
  assert.deepEqual(freshReplies([old], [old, { id: 11, out: true }, ...replies]), replies);
});
test('accepts bot edits to an existing message', () => {
  const edited = { ...old, message: 'новый график', edit_date: 123 };
  assert.deepEqual(freshReplies([old], [edited]), [edited]);
});
test('does not mistake previously unseen older history for a reply', () => {
  assert.deepEqual(freshReplies([old], [{ id: 5, message: 'старое' }, old]), []);
});
