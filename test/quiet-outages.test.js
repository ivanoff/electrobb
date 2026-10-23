import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, upcomingQuietWindow, MINUTE } from '../src/outages.js';
import { newState, planNotifications, applyDelivery, queryDecision } from '../src/notifications.js';
const config = { quietStart: 1320, quietEnd: 540 };
const at = (time, day = '23') => parseDate(`${day}-10-2026 ${time}`);
const interval = (start, end, day='24', kind='planned') => ({start:at(start,day),end:at(end,day),kind});
const stateWith = events => ({...newState(),snapshot:{events,at:at('20:00')},morningDay:'2026-10-23'});
const plan = (state,time='20:00',day='23',cfg=config) => planNotifications(state,at(time,day),cfg);
test('tomorrow early outage is announced before quiet hours, without a new bot query',()=>{
  const state=stateWith([interval('06:00','08:00')]);state.lastQueryAttempt=at('19:00');
  const result=plan(state);
  assert.equal(result.notifications.length,1);assert.equal(result.notifications[0].type,'upcoming_quiet_outage');
  assert.match(result.notifications[0].text,/24\.10 06:00 до 24\.10 08:00/);
  assert.equal(queryDecision(state,at('20:00'),config).due,false);
});
test('night warning persists across restart, but changed end is announced',()=>{
  let state=stateWith([interval('06:00','08:00')]);const first=plan(state);
  applyDelivery(state,first.notifications[0].patch,at('20:00'));
  state=JSON.parse(JSON.stringify(state));assert.equal(plan(state,'20:10').notifications.length,0);
  state.snapshot.events[0].end=at('08:30','24');const changed=plan(state,'21:00');
  assert.equal(changed.notifications.length,1);assert.match(changed.notifications[0].text,/08:00 → 24\.10 08:30/);
  assert.equal(plan(state,'22:00').notifications.length,0);
});
test('today late outage is not announced twice by the new rule',()=>{
  const state=stateWith([interval('23:00','23:50','23')]);const first=plan(state);
  assert.equal(first.notifications.length,1);assert.equal(first.notifications[0].type,'new_interval');
  applyDelivery(state,first.notifications[0].patch,at('20:00'));assert.equal(plan(state,'21:00').notifications.length,0);
});
test('tomorrow at quiet-end is announced but later days wait',()=>{
  const state=stateWith([interval('09:00','10:00'),interval('06:00','08:00','25')]);
  const result=plan(state);
  assert.equal(result.notifications.length,1);
  assert.match(result.notifications[0].text,/24\.10 09:00/);
});
test('partial overlap with quiet hours is enough',()=>{
  const state=stateWith([interval('08:30','10:00')]);
  assert.equal(plan(state).notifications.length,1);
});
test('overlapping tomorrow intervals and pushes produce one mixed warning',()=>{
  const state=stateWith([interval('06:00','08:00')]);
  state.pushes.x=interval('05:00','07:00','24','emergency');
  const result=plan(state);assert.equal(result.notifications.length,1);
  assert.match(result.notifications[0].text,/05:00 до 24\.10 08:00/);
  assert.match(result.notifications[0].text,/планове та аварійне/);
});
test('morning skips completed night outage but summarizes ongoing one',()=>{
  const state=stateWith([interval('06:00','08:00'),interval('08:30','10:00')]);
  for(const n of plan(state).notifications)applyDelivery(state,n.patch,at('20:00'));
  assert.equal(plan(state,'08:59','24').notifications.length,0);
  const morning=plan(state,'09:00','24');assert.equal(morning.notifications.length,1);
  assert.match(morning.notifications[0].text,/триває: з 08:30 до 10:00/);
  assert.doesNotMatch(morning.notifications[0].text,/06:00/);
});
test('quiet window uses configured minutes and Kyiv DST calendar day',()=>{
  const window=upcomingQuietWindow(at('20:00','24'),config);
  assert.equal(window.start,at('22:00','24'));assert.equal(window.end,at('09:00','25'));
  assert.equal((window.end-window.start)/MINUTE,12*60);
  const state=stateWith([interval('09:15','10:00')]);
  assert.equal(plan(state,'20:00','23',{quietStart:1350,quietEnd:570}).notifications.length,1);
});

for (const kind of ['planned', 'emergency']) {
  test(`${kind}: tomorrow daytime is announced immediately and survives restart without duplicates`, () => {
    let state = stateWith([interval('18:00', '20:00', '24', kind)]);
    const first = plan(state, '09:00');
    assert.equal(first.notifications.length, 1);
    assert.match(first.notifications[0].text, /24\.10 18:00 до 24\.10 20:00/);
    applyDelivery(state, first.notifications[0].patch, at('09:00'));
    state = JSON.parse(JSON.stringify(state));
    assert.equal(plan(state, '12:00').notifications.length, 0);
    state.snapshot.events[0].end = at('21:00', '24');
    assert.equal(plan(state, '13:00').notifications[0].type, 'interval_changed');
  });
}
test('stored distant event is announced at quiet end on the preceding calendar day', () => {
  const state = stateWith([interval('18:00', '20:00', '26')]);
  assert.equal(plan(state).notifications.length, 0);
  assert.equal(plan(state, '21:00', '24').notifications.length, 0);
  assert.equal(plan(state, '08:59', '25').notifications.length, 0);
  const morning = plan(state, '09:00', '25');
  assert.equal(morning.notifications.length, 1);
  assert.match(morning.notifications[0].text, /26\.10 18:00/);
  applyDelivery(state, morning.notifications[0].patch, at('09:00', '25'));
  assert.equal(plan(state, '09:10', '25').notifications.length, 0);
});
test('tomorrow information received during quiet hours waits until quiet end', () => {
  const state = stateWith([interval('18:00', '20:00')]);
  assert.equal(plan(state, '08:59').notifications.length, 0);
  assert.equal(plan(state, '09:00').notifications.length, 1);
});
