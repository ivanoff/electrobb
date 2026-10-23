import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutages, parseDate, mergeIntervals, classify, dayKey, quietTime, effectiveEvents, MINUTE } from '../src/outages.js';
import { newState, planNotifications, applyDelivery, queryDecision } from '../src/notifications.js';
const config = { quietStart: 22*60, quietEnd: 9*60 };
const at = t => parseDate(`23-10-2026 ${t}`);
const event = (start, end, kind = 'planned') => ({ start: at(start), end: at(end), kind, observedAt: at('09:00') });
const snapshot = events => ({ ...newState(), snapshot: { events, at: at('09:00') }, morningDay: '2026-10-23' });
const plan = (state, t) => planNotifications(state, at(t), config);
function delivered(state, result, time) { for (const n of result.notifications) applyDelivery(state, n.patch, at(time)); }
const block = (reason, start, end, date = '23-10-2026') => `${reason}\nПочаток: ${date} ${start}\nЗакінчення: ${date} ${end}`;

test('user example ignores switching and repairs, keeps only emergency and limitations', () => {
  const text = 'О/р 123456789,\nадреса\n' + [block('Виконання оперативних перемикань', '06:00', '08:59'),
    block('Виконання оперативних перемикань', '17:00', '20:00'),
    block('Виконання ремонтних робіт на обладнанні підстанції (ПС, РП, ТП, КТП)', '09:00', '17:00'),
    block('Виконання ремонтних робіт на обладнанні підстанції (ПС, РП, ТП, КТП)', '08:00', '17:00', '29-10-2026'),
    block('Графіки аварійних відключень (ГАВ)', '10:32', '14:00'), block('Заходи обмеження', '18:30', '22:00')].join('\n~~~~~~~~~~~~~~~~~~~~~\n');
  const parsed = parseOutages(text, { account: '123456789' });
  assert.equal(parsed.events.length, 2); assert.equal(parsed.ignored.length, 4); assert.equal(parsed.errors.length, 0);
  assert.deepEqual(mergeIntervals(parsed.events).map(i => [i.start,i.end]), [[at('10:32'),at('14:00')],[at('18:30'),at('22:00')]]);
});
const push = reason => `АТ "ЧЕРНІГІВОБЛЕНЕРГО" повідомляє про планову перерву в електропостачанні за адресою: адреса\nособовий рахунок – 123456789.\nДата/час перерви:\nз 23-10-2026 18:30\nпо 23-10-2026 22:00 орієнтовно.\n\nПричина: ${reason}.\n\nСтатус: РОБОТИ ЗАПЛАНОВАНО\nПриносимо вибачення`;
test('planned push excludes forbidden causes and checks account', () => {
  for (const reason of ['Виконання оперативних перемикань','Виконання ремонтних робіт на обладнанні підстанції (ПС, РП, ТП, КТП)']) {
    const parsed = parseOutages(push(reason), { account: '123456789', source: 'push' });
    assert.equal(parsed.events.length, 0); assert.equal(parsed.ignored.length, 1);
  }
  assert.equal(parseOutages(push('Заходи обмеження'), { account: '123456789', source: 'push' }).events[0].kind, 'planned');
  assert.equal(parseOutages(push('Заходи обмеження'), { account: '987654321', source: 'push' }).events.length, 0);
});
test('hourly schedules are planned outages with or without abbreviation', () => {
  for (const reason of ['Графік погодинних відключень (ГПВ)', 'Графік погодинних відключень', '  ГРАФІК  ПОГОДИННИХ ВІДКЛЮЧЕНЬ (ГПВ). ']) {
    assert.equal(classify(reason), 'planned');
    const parsed = parseOutages(block(reason, '10:00','12:00'));
    assert.equal(parsed.unknown.length, 0);
    assert.equal(parsed.errors.length, 0);
    assert.deepEqual(parsed.events.map(({ kind, start, end }) => ({ kind, start, end })), [
      { kind: 'planned', start: at('10:00'), end: at('12:00') }
    ]);
    const result = plan(snapshot(parsed.events), '09:00');
    assert.equal(result.notifications.length, 1);
    assert.match(result.notifications[0].text, /Планове відключення електроенергії.*10:00 до 12:00/);
  }
});
test('unknown types are reported but never used as an outage', () => {
  assert.equal(classify('Невідомий вид відключень'), 'unknown');
  const parsed = parseOutages(block('Невідомий вид відключень', '10:00','12:00'));
  assert.equal(parsed.events.length, 0); assert.equal(parsed.unknown.length, 1);
});
test('touching and overlapping intervals merge transitively', () => {
  const intervals = mergeIntervals([event('12:00','14:00'), event('11:00','16:00','emergency'),event('16:00','18:00')]);
  assert.equal(intervals.length, 1); assert.equal(intervals[0].start,at('11:00')); assert.equal(intervals[0].end,at('18:00'));
  assert.deepEqual(intervals[0].kinds,['emergency','planned']);
});
test('only union start is announced and reminded, never inner start', () => {
  const state = snapshot([event('12:00','14:00'),event('11:00','16:00','emergency')]);
  const first = plan(state, '09:00'); assert.equal(first.notifications.length,1);
  assert.match(first.notifications[0].text,/11:00 до 16:00/); delivered(state,first,'09:00');
  const hour = plan(state,'10:00'); assert.equal(hour.notifications.length,1); assert.match(hour.notifications[0].text,/через 1 годину/);
  delivered(state,hour,'10:00'); assert.equal(plan(state,'11:00').notifications.length,0);
});
test('end shift gets one notification even on repeated snapshots', () => {
  const state = snapshot([event('10:00','14:00')]); delivered(state,plan(state,'10:00'),'10:00');
  state.snapshot.events[0].end = at('16:00');
  const changed = plan(state,'12:00'); assert.equal(changed.notifications.length,1); assert.match(changed.notifications[0].text,/14:00 → 16:00/);
  delivered(state,changed,'12:00'); assert.equal(plan(state,'12:01').notifications.length,0);
});
test('end reminder waits for confirmation and uses latest overlapping endpoint', () => {
  const state = snapshot([event('10:00','14:00'),event('12:00','16:00','emergency')]);
  delivered(state,plan(state,'10:00'),'10:00'); state.lastQuerySuccess=at('13:45');
  assert.equal(plan(state,'13:45').notifications.length,0);
  assert.equal(plan(state,'15:45').notifications.length,0);
  state.lastQuerySuccess=at('15:45'); state.lastQueryAttempt=at('15:45');
  const result=plan(state,'15:45'); assert.equal(result.notifications.length,1); assert.match(result.notifications[0].text,/16:00/);
  delivered(state,result,'15:45'); assert.equal(plan(state,'15:46').notifications.length,0);
});
test('moved endpoint defers old restoration reminder', () => {
  const state = snapshot([event('10:00','14:00')]); delivered(state,plan(state,'10:00'),'10:00');
  state.snapshot.events[0].end=at('16:00'); state.lastQuerySuccess=at('13:45');
  const result=plan(state,'13:45'); assert.equal(result.notifications.length,1); assert.equal(result.notifications[0].type,'interval_changed');
});
test('quiet hours hold unknown warnings and morning catches up upcoming + ongoing', () => {
  const state = snapshot([event('09:30','11:00'),event('08:00','09:10')]); delete state.morningDay;
  state.unknown.test={reason:'Новий тип'};
  assert.equal(plan(state,'08:59').notifications.length,0);
  const result=plan(state,'09:00'); assert.match(result.notifications[0].text,/через 30 хв/); assert.match(result.notifications[0].text,/триває/);
  assert(result.notifications.some(n=>n.type==='unknown_type')); delivered(state,result,'09:00');
  assert.equal(plan(state,'09:01').notifications.length,0);
  assert.equal(plan(state,'22:00').notifications.length,0);
});
test('days beyond tomorrow and ended intervals are not sent', () => {
  const state=snapshot([event('06:00','08:00'),{...event('10:00','12:00'),start:parseDate('25-10-2026 10:00'),end:parseDate('25-10-2026 12:00')}]);
  assert.equal(plan(state,'09:00').notifications.length,0);
});
test('regular and end checks share one decision; crash/restart retains rate limit', () => {
  const state=snapshot([event('10:00','14:00')]); state.lastQueryAttempt=at('11:45');
  const result=queryDecision(state,at('13:45'),config); assert.equal(result.due,true); assert.deepEqual(result.reasons,['regular_2h','confirm_end_15m']);
  state.lastQueryAttempt=at('13:45');
  assert.equal(queryDecision(JSON.parse(JSON.stringify(state)),at('13:59'),config).due,false);
});
test('no regular retry every minute after a failed query', () => {
  const state=snapshot([]); state.lastQueryAttempt=at('10:00');
  assert.equal(queryDecision(state,at('10:01'),config).due,false);
  assert.equal(queryDecision(state,at('12:00'),config).due,true);
});
test('Kyiv date, quiet boundaries and DST offsets ignore host timezone', () => {
  assert.equal(dayKey(Date.parse('2026-10-22T22:30:00Z')),'2026-10-23');
  assert.equal(quietTime(at('21:59'),config),false); assert.equal(quietTime(at('22:00'),config),true);
  assert.equal(quietTime(at('08:59'),config),true); assert.equal(quietTime(at('09:00'),config),false);
  assert.equal(new Date(parseDate('23-10-2026 09:00')).toISOString(),'2026-10-23T06:00:00.000Z');
  assert.equal(new Date(parseDate('26-10-2026 09:00')).toISOString(),'2026-10-26T07:00:00.000Z');
  assert.throws(()=>parseDate('29-03-2026 03:30'),/invalid_local/);
  assert.throws(()=>parseDate('25-10-2026 03:30'),/ambiguous_local/);
});
test('newer query overrides old push end; independent push survives', () => {
  const state=snapshot([{...event('10:00','15:00'),observedAt:at('12:00')}]);
  state.pushes.old={...event('10:00','14:00'),observedAt:at('11:00')}; state.pushes.other=event('18:00','20:00');
  assert.deepEqual(effectiveEvents(state).map(e=>e.end),[at('15:00'),at('20:00')]);
});
test('end shortened into the past still produces a change notice', () => {
  const state=snapshot([event('10:00','16:00')]); delivered(state,plan(state,'10:00'),'10:00');
  state.snapshot.events[0].end=at('14:00');
  const result=plan(state,'14:30'); assert.equal(result.notifications.length,1); assert.equal(result.notifications[0].type,'end_moved_to_past');
  delivered(state,result,'14:30'); assert.equal(plan(state,'14:31').notifications.length,0);
});
test('unconfirmed push-only end does not produce restoration promise', () => {
  const state=snapshot([]); state.pushes.x=event('10:00','14:00');
  delivered(state,plan(state,'10:00'),'10:00');
  state.lastQuerySuccess=at('13:45');state.lastQueryAttempt=at('13:45');
  assert.equal(plan(state,'13:45').notifications.length,0);
});
