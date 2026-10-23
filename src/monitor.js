import { randomBytes, createHash } from 'node:crypto';
import { parseOutages, eventKey, dayKey, local, quietTime, MINUTE } from './outages.js';
import { newState, ingestParsed, queryDecision, planNotifications, applyDelivery, historyInterval } from './notifications.js';

export class Monitor {
  constructor({ state, save, log, transport, config, account, now = Date.now }) {
    Object.assign(this, { state, save, log, transport, config, account, now });
  }
  async persist() { await this.save(this.state); }
  parse(message, source) {
    this.log('bot_message', { id: message.id, date: message.date, editDate: message.edit_date, source, text: message.message });
    const parsed = parseOutages(message.message || '', { account: this.account, source, messageId: message.id,
      observedAt: (message.edit_date || message.date) * 1000 || this.now() });
    ingestParsed(this.state, parsed, this.log);
    return parsed;
  }
  ingestMessages(messages) {
    for (const message of [...messages].sort((a, b) => a.id - b.id)) {
      if (message.out) continue;
      const hash = createHash('sha256').update(JSON.stringify([message.message, message.edit_date])).digest('hex');
      if (this.state.seen[message.id] === hash) continue;
      const parsed = this.parse(message, 'push');
      // An edited push replaces that message's previous contribution, including an excluded reason.
      for (const [key, event] of Object.entries(this.state.pushes)) {
        if (event.messageId === message.id) delete this.state.pushes[key];
      }
      for (const event of parsed.events) {
        if (event.end < local(this.now()).minus({ days: 2 }).startOf('day').toMillis()) { this.log('event_ignored', { reason: 'old_completed_event', event }); continue; }
        const key = eventKey(event), previous = this.state.pushes[key];
        if (!previous || previous.observedAt <= event.observedAt) this.state.pushes[key] = event;
      }
      this.state.seen[message.id] = hash;
    }
    this.state.historyCursor = Math.max(this.state.historyCursor || 0, ...messages.map(m => m.id), 0);
  }
  seedSnapshot(messages) {
    if (this.state.snapshot.at || this.state.seedChecked) return;
    this.state.seedChecked = true;
    // Reuse a recent completed response, including one requested manually, to avoid another bot command.
    const message = [...messages].sort((a, b) => b.id - a.id).find(m => !m.out &&
      (m.message || '').includes(`О/р ${this.account}`) && this.now() - (m.edit_date || m.date) * 1000 < 120 * MINUTE);
    if (!message) return;
    const parsed = this.parse(message, 'snapshot');
    if (!parsed.recognized || parsed.errors.length) return;
    const at = (message.edit_date || message.date) * 1000;
    this.state.snapshot = { events: parsed.events, at };
    this.state.lastQuerySuccess = at;
    this.state.lastQueryAttempt = Math.max(this.state.lastQueryAttempt || 0, at);
    this.log('snapshot_reused', { messageId: message.id, at, reason: 'recent_response_avoids_duplicate_query' });
  }
  async failure(error, operation) {
    const message = error.error_message || error.message || String(error);
    const flood = message.match(/(?:FLOOD_WAIT|SLOWMODE_WAIT)_(\d+)/);
    if (flood) this.state.blockedUntil = this.now() + Number(flood[1]) * 1000;
    this.log('operation_failed', { operation, error: message, blockedUntil: this.state.blockedUntil });
    await this.persist();
  }
  async tick() {
    if ((this.state.blockedUntil || 0) > this.now()) {
      this.log('tick_skipped', { reason: 'telegram_flood_wait', until: this.state.blockedUntil }); return;
    }
    if (!this.state.lastHistoryPoll || this.now() - this.state.lastHistoryPoll >= historyInterval) {
      this.state.lastHistoryPoll = this.now();
      await this.persist();
      try {
        const messages = await this.transport.historySince(this.state.historyCursor || 0);
        this.log('history_read', { count: messages.length, previousCursor: this.state.historyCursor });
        this.ingestMessages(messages);
        this.seedSnapshot(messages);
        await this.persist();
      } catch (error) { await this.failure(error, 'history_poll'); }
    }
    if ((this.state.blockedUntil || 0) > this.now()) return;
    const query = queryDecision(this.state, this.now(), this.config);
    if (query.due) {
      this.state.lastQueryAttempt = this.now();
      await this.persist(); // Commit rate limit before the first network request, even if we crash.
      this.log('query_started', query);
      try {
        const { replies, observed } = await this.transport.query();
        this.ingestMessages(observed);
        const results = replies.map(m => this.parse(m, 'snapshot'));
        if (!results.length || results.some(r => !r.recognized || r.errors.length)) throw new Error('snapshot_not_understood: keeping previous intervals');
        const at = this.now();
        this.state.snapshot = { at, events: results.flatMap(r => r.events).map(e => ({ ...e, observedAt: at })) };
        // A newer snapshot supersedes a push describing the same type and start.
        // Independent push-only outages stay until their stated end: absence alone is not cancellation.
        for (const event of this.state.snapshot.events) {
          const previous = this.state.pushes[eventKey(event)];
          if (previous && previous.observedAt <= at) delete this.state.pushes[eventKey(event)];
        }
        this.state.lastQuerySuccess = at;
        this.log('query_succeeded', { at, events: this.state.snapshot.events, reasons: query.reasons });
        await this.persist();
      } catch (error) { await this.failure(error, 'active_query'); }
    } else if (query.reasons.length) this.log('query_deferred', { ...query, reason: 'minimum_15m_or_flood_wait' });
    if ((this.state.blockedUntil || 0) > this.now()) return;
    await this.deliver();
    this.prune();
    await this.persist();
  }
  async deliver() {
    const now = this.now();
    let plan = planNotifications(this.state, now, this.config);
    this.log('notification_decision', { decisions: plan.decisions, intervals: plan.intervals, quietIntervals: plan.quietIntervals,
      candidates: plan.notifications.map(n => ({ id: n.id, type: n.type, text: n.text })) });
    // A queue is only a retry record, never permission to send an obsolete notification.
    const valid = new Set(plan.notifications.map(n => n.id));
    for (const id of Object.keys(this.state.outbox)) {
      if (!valid.has(id)) { delete this.state.outbox[id]; this.log('outbox_dropped', { id, reason: 'no_longer_current_or_quiet_hours' }); }
    }
    if (quietTime(now, this.config)) return;
    if (this.state.morningDay !== dayKey(now) && !plan.intervals.length) this.state.morningDay = dayKey(now);
    // Re-evaluate before every send: quiet hours may begin while the network is slow.
    for (const initial of plan.notifications) {
      if (quietTime(this.now(), this.config)) { this.log('send_suppressed', { reason: 'quiet_hours_started' }); break; }
      plan = planNotifications(this.state, this.now(), this.config);
      const notification = plan.notifications.find(n => n.id === initial.id);
      if (!notification) { this.log('send_suppressed', { id: initial.id, reason: 'candidate_changed' }); continue; }
      const pending = this.state.outbox[notification.id] ||= { randomId: randomBytes(8).readBigInt64LE().toString(), ...notification };
      if (pending.retryAfter > this.now()) continue;
      await this.persist();
      try {
        await this.transport.send(pending.text, pending.randomId);
        applyDelivery(this.state, pending.patch, this.now());
        delete this.state.outbox[notification.id];
        this.log('notification_sent', { id: notification.id, type: pending.type, text: pending.text });
        await this.persist();
      } catch (error) {
        pending.retryAfter = this.now() + 60_000;
        await this.failure(error, 'channel_send');
        break;
      }
    }
  }
  prune() {
    const cutoff = local(this.now()).minus({ days: 2 }).startOf('day').toMillis();
    for (const [key, event] of Object.entries(this.state.pushes)) if (event.end < cutoff) delete this.state.pushes[key];
    for (const [key, event] of Object.entries(this.state.announced)) if (event.end < cutoff) delete this.state.announced[key];
    for (const [key, at] of Object.entries(this.state.sent)) if (at < cutoff) delete this.state.sent[key];
    const ids = Object.keys(this.state.seen).sort((a, b) => Number(b) - Number(a));
    for (const id of ids.slice(2000)) delete this.state.seen[id];
  }
}
export function migrateState(old) {
  if (old.version === 2) return old;
  return { ...newState(), lastQueryAttempt: old.lastSuccess || 0 };
}
