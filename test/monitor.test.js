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
  const monitor=new Monitor({ state, account, config:{quietStart:1320,quietEnd:540,silentStart:1200,silentEnd:660}, now:()=>now,
    log:(event,data)=>logs.push({event,...data}), save:async s=>saves.push(structuredClone(s)),
    transport:{ historySince:async()=>{reads.push(now);return[];}, query:async()=>{queries.push(now);return {replies:[message(1)],observed:[]};},
      send:async(text,id,options)=>sent.push({text,id,...options}), ...overrides } });
  return {state,monitor,sent,logs,queries,reads,saves,setTime:t=>{now=at(t);}};
}
test('single snapshot satisfies multiple timers, no bot requests from local timer ticks', async()=>{
  const h=harness('10:00'); await h.monitor.tick();
  assert.equal(h.queries.length,1); assert.equal(h.sent.length,1);
  for(const t of ['10:01','10:02','10:09','10:10','10:59']){h.setTime(t);await h.monitor.tick();}
  assert.equal(h.queries.length,1);assert.equal(h.sent.length,1);
  h.setTime('11:00');await h.monitor.tick();assert.equal(h.queries.length,2);
  assert(h.saves.some(s=>s.lastQueryAttempt===at('10:00')&&!s.lastQuerySuccess));
});
test('delivery is silent only in the two-hour windows around quiet hours', async()=>{
  for (const [time, silent] of [['09:00',true],['10:59',true],['11:00',false],['19:59',false],['20:00',true],['21:59',true]]) {
    const h=harness(time,{query:async()=>({replies:[message(1,'21:00','23:00')],observed:[]})});
    await h.monitor.tick();
    assert(h.sent.length>0,time);
    assert(h.sent.every(m=>m.silent===silent),time);
  }
});
test('retry recalculates silent mode at delivery time', async()=>{
  const attempts=[];
  const h=harness('10:59',{send:async(text,id,options)=>{
    attempts.push({id,...options});
    if(attempts.length===1) throw new Error('network');
  }});
  await h.monitor.tick();
  h.setTime('11:00');await h.monitor.tick();
  assert.equal(attempts.length,2);
  assert.equal(attempts[0].id,attempts[1].id);
  assert.deepEqual(attempts.map(a=>a.silent),[true,false]);
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
  const h=harness('10:00',{historySince:async()=>[push]});h.state.lastQueryAttempt=at('09:30');h.monitor.startupPending=false;
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

test('startup requests fresh data despite a recent saved snapshot, respecting minimum spacing', async()=>{
  const h=harness('10:00');
  h.state.lastQueryAttempt=at('09:50');h.state.snapshot.at=at('09:50');
  await h.monitor.tick();assert.equal(h.queries.length,0);
  h.setTime('10:05');await h.monitor.tick();assert.equal(h.queries.length,1);
  h.setTime('10:20');await h.monitor.tick();assert.equal(h.queries.length,1);
});
test('checks five minutes after merged restoration during quiet hours, only once', async()=>{
  const h=harness('21:45',{query:async()=>({replies:[message(1,'20:00','22:00'),message(2,'21:00','22:10')],observed:[]})});
  await h.monitor.tick();
  h.setTime('22:05');await h.monitor.tick();assert.equal(h.logs.filter(l=>l.event==='query_started').length,1);
  h.setTime('22:15');await h.monitor.tick();
  assert.equal(h.logs.filter(l=>l.event==='query_started').length,2);
  assert(h.logs.some(l=>l.event==='query_started'&&l.reasons.includes('after_end_5m')));
  h.setTime('22:30');await h.monitor.tick();
  assert.equal(h.logs.filter(l=>l.event==='query_started').length,2);
});
test('after restoration check waits for rate limit and failed attempt is not repeated', async()=>{
  const h=harness('14:00',{query:async()=>{throw new Error('network');}});
  h.monitor.startupPending=false;
  h.state.lastQueryAttempt=at('13:59');
  h.state.snapshot.events=[{kind:'planned',start:at('12:00'),end:at('14:00')}];
  h.setTime('14:05');await h.monitor.tick();
  assert.equal(h.logs.filter(l=>l.event==='query_started').length,0);
  h.setTime('14:14');await h.monitor.tick();
  h.setTime('14:30');await h.monitor.tick();
  assert.equal(h.logs.filter(l=>l.event==='query_started').length,1);
});

test('confirmed unexpected outage polls every 15 minutes and stops on power restoration', async () => {
  const h = harness('10:00');
  await h.monitor.tick();
  h.monitor.powerOff = () => true;
  h.setTime('10:14'); await h.monitor.tick(); assert.equal(h.queries.length, 1);
  h.setTime('10:15'); await h.monitor.tick(); assert.equal(h.queries.length, 2);
  h.setTime('10:29'); await h.monitor.tick(); assert.equal(h.queries.length, 2);
  h.setTime('10:30'); await h.monitor.tick(); assert.equal(h.queries.length, 3);
  h.monitor.powerOff = () => false;
  h.setTime('10:45'); await h.monitor.tick(); assert.equal(h.queries.length, 3);
});

test('scheduled outage stops extra polling, including when added by a push', async () => {
  const h = harness('10:00'); await h.monitor.tick();
  h.monitor.powerOff = () => true;
  h.state.pushes.current = { kind: 'planned', start: at('10:01'), end: at('12:00'), observedAt: at('10:01') };
  h.setTime('10:15'); await h.monitor.tick();
  assert.equal(h.queries.length, 1);
});

test('unexpected outage queries during quiet hours; failures still wait 15 minutes', async () => {
  const h = harness('06:00'); await h.monitor.tick();
  h.monitor.powerOff = () => true;
  h.setTime('06:15'); await h.monitor.tick(); assert.equal(h.queries.length, 2);
  assert.equal(h.sent.length, 0);
  let attempts = 0;
  h.monitor.transport.query = async () => { attempts++; throw new Error('offline'); };
  h.setTime('06:30'); await h.monitor.tick(); assert.equal(attempts, 1);
  h.setTime('06:31'); await h.monitor.tick(); assert.equal(attempts, 1);
  h.setTime('06:45'); await h.monitor.tick(); assert.equal(attempts, 2);
});


test('heartbeat refresh queries before returning, defers inside cooldown and survives restart', async () => {
  const h = harness('10:00');
  h.monitor.startupPending = false;
  await h.monitor.refreshForHeartbeat();
  assert.equal(h.queries.length, 1);
  assert.equal(h.state.lastQuerySuccess, at('10:00'));
  assert.equal(h.sent.length, 0);
  h.setTime('10:01');
  await h.monitor.refreshForHeartbeat();
  assert.equal(h.queries.length, 1);
  assert.equal(h.state.heartbeatQueryPending, true);
  h.monitor.state = JSON.parse(JSON.stringify(h.state));
  h.setTime('10:14'); await h.monitor.tick();
  assert.equal(h.queries.length, 1);
  h.setTime('10:15'); await h.monitor.tick();
  assert.equal(h.queries.length, 2);
  assert.equal(h.monitor.state.heartbeatQueryPending, false);
  h.setTime('10:30'); await h.monitor.tick();
  assert.equal(h.queries.length, 2);
});

test('concurrent heartbeat refresh and timer never overlap queries', async () => {
  const h = harness();
  await Promise.all([h.monitor.refreshForHeartbeat(), h.monitor.tick()]);
  assert.equal(h.queries.length, 1);
});

test('failed heartbeat query releases notification preparation and respects cooldown', async () => {
  let attempts = 0;
  const h = harness('10:00', { query: async () => { attempts++; throw new Error('offline'); } });
  await h.monitor.refreshForHeartbeat();
  assert.equal(attempts, 1);
  h.setTime('10:01'); await h.monitor.refreshForHeartbeat();
  assert.equal(attempts, 1);
  h.setTime('10:15'); await h.monitor.tick();
  assert.equal(attempts, 2);
});
