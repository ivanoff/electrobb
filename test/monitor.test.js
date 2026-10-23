import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/monitor.js';
import { newState } from '../src/notifications.js';
import { parseDate, MINUTE } from '../src/outages.js';
const at = t => parseDate(`23-10-2026 ${t}`);
const account='123456789';
const message = (id, from='18:30', to='22:00') => ({ id, date: at('09:00')/1000, message: `О/р ${account},\nадреса\nЗаходи обмеження\nПочаток: 23-10-2026 ${from}\nЗакінчення: 23-10-2026 ${to}` });
function harness(time='10:00', overrides={}) {
  const state = newState(), sent=[], logs=[], queries=[], reads=[], saves=[];
  let now=at(time);
  const monitor=new Monitor({ state, account, config:{quietStart:1320,quietEnd:540}, now:()=>now,
    log:(event,data)=>logs.push({event,...data}), save:async s=>saves.push(structuredClone(s)),
    transport:{ historySince:async()=>{reads.push(now);return[];}, query:async()=>{queries.push(now);return {replies:[message(1)],observed:[]};},
      send:async(text,id)=>sent.push({text,id}), ...overrides } });
  return {state,monitor,sent,logs,queries,reads,saves,setTime:t=>{now=at(t);}};
}
test('single snapshot satisfies multiple timers, no bot requests from local timer ticks', async()=>{
  const h=harness('10:00'); await h.monitor.tick();
  assert.equal(h.queries.length,1); assert.equal(h.sent.length,1);
  for(const t of ['10:01','10:02','10:09','10:10','11:59']){h.setTime(t);await h.monitor.tick();}
  assert.equal(h.queries.length,1);assert.equal(h.sent.length,1);
  h.setTime('12:00');await h.monitor.tick();assert.equal(h.queries.length,2);
  assert(h.saves.some(s=>s.lastQueryAttempt===at('10:00')&&!s.lastQuerySuccess));
});
test('normal and restoration checks at same time execute exactly one query', async()=>{
  let count=0;
  const h=harness('13:45',{query:async()=>{count++;return {replies:[message(1,'10:00','14:00')],observed:[]};}});
  h.state.snapshot.events=[{kind:'planned',start:at('10:00'),end:at('14:00'),observedAt:at('11:45')}];
  h.state.lastQueryAttempt=at('11:45');h.state.lastQuerySuccess=at('11:45');
  await h.monitor.tick();assert.equal(count,1);assert(h.sent.some(m=>m.text.includes('скоро ввімкнуть')));
  h.setTime('13:46');await h.monitor.tick();assert.equal(count,1);
});
test('failed requests retain rate limit after restart', async()=>{
  let count=0;
  const h=harness('10:00',{query:async()=>{count++;throw new Error('network');}});
  await h.monitor.tick();
  h.monitor.state=JSON.parse(JSON.stringify(h.state));h.setTime('10:01');await h.monitor.tick();
  assert.equal(count,1);assert.equal(h.sent.length,0);
});
test('failed channel delivery retains random ID for retry', async()=>{
  const ids=[];let fail=true;
  const h=harness('10:00',{send:async(text,id)=>{ids.push(id);if(fail)throw new Error('network');}});
  await h.monitor.tick(); assert.equal(Object.keys(h.state.outbox).length,1);
  fail=false;h.setTime('10:01');await h.monitor.tick();assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
  assert.equal(Object.keys(h.state.outbox).length,0);
});
test('quiet time blocks previously pending sends and morning rebuilds current messages', async()=>{
  let fail=true; const sent=[];
  const h=harness('21:59',{query:async()=>({replies:[message(1,'21:00','23:00')],observed:[]}),send:async text=>{if(fail)throw new Error('network');sent.push(text);}});
  await h.monitor.tick();fail=false;
  h.setTime('22:00');await h.monitor.tick();assert.equal(sent.length,0);assert.equal(Object.keys(h.state.outbox).length,0);
});
test('passive push is processed without a bot command', async()=>{
  const push={id:10,date:at('10:00')/1000,message:`АТ повідомляє про планову перерву в електропостачанні за адресою: X\nособовий рахунок – ${account}.\nДата/час перерви:\nз 23-10-2026 18:30\nпо 23-10-2026 22:00 орієнтовно.\nПричина: Заходи обмеження.\nСтатус: РОБОТИ ЗАПЛАНОВАНО`};
  const h=harness('10:00',{historySince:async()=>[push]});h.state.lastQueryAttempt=at('09:00');
  await h.monitor.tick(); assert.equal(h.queries.length,0);assert.equal(h.sent.length,1);assert.match(h.sent[0].text,/18:30 до 22:00/);
  h.setTime('10:10');await h.monitor.tick();assert.equal(h.sent.length,1);
});
test('unrecognized query response preserves last known intervals', async()=>{
  const h=harness('12:00',{query:async()=>({replies:[{id:20,message:`О/р ${account}\nБот тимчасово недоступний`,date:at('12:00')/1000}],observed:[]})});
  const events=[{kind:'planned',start:at('18:00'),end:at('20:00')}];h.state.snapshot={events,at:at('09:00')};
  await h.monitor.tick();assert.deepEqual(h.state.snapshot.events,events);assert(!h.state.lastQuerySuccess);
});
test('FLOOD_WAIT is persisted and pauses all network work',async()=>{
  let calls=0;
  const h=harness('10:00',{historySince:async()=>{calls++;throw {error_message:'FLOOD_WAIT_1800'};}});
  await h.monitor.tick();assert.equal(h.state.blockedUntil,at('10:00')+30*MINUTE);
  h.setTime('10:15');await h.monitor.tick();assert.equal(calls,1);assert.equal(h.queries.length,0);
});
