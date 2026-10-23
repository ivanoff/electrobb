import { createHash } from 'node:crypto';
import { MINUTE, dayKey, quietTime, todayIntervals, describe, timeLabel, normalize, mergeIntervals, effectiveEvents, upcomingQuietIntervals } from './outages.js';
export const regularInterval = 120 * MINUTE;
export const minQueryInterval = 15 * MINUTE;
export const historyInterval = 10 * MINUTE;
export const startKey = (day, i) => `${day}:start:${i.start}`;
export const endKey = (day, i) => `${day}:end:${i.end}`;
const intervalKey = (day, i) => `${day}:${i.start}`;
export function newState() {
  return { version: 2, snapshot: { events: [], at: 0 }, pushes: {}, unknown: {}, unknownSent: {}, sent: {}, announced: {}, seen: {}, outbox: {} };
}
export function applyDelivery(state, patch, now) {
  for (const key of patch.sent || []) state.sent[key] = now;
  for (const item of patch.announced || []) state.announced[item.key] = item.interval;
  for (const type of patch.unknown || []) state.unknownSent[type] = now;
  if (patch.morningDay) state.morningDay = patch.morningDay;
}
export function queryDecision(state, now, config) {
  const intervals = todayIntervals(state, now);
  const confirm = !quietTime(now, config) && intervals.some(i => now >= i.end - 15 * MINUTE &&
    !state.sent[endKey(dayKey(now), i)] && (state.lastQuerySuccess || 0) < i.end - 15 * MINUTE);
  const regular = !state.lastQueryAttempt || now - state.lastQueryAttempt >= regularInterval;
  const reasons = [regular && 'regular_2h', confirm && 'confirm_end_15m'].filter(Boolean);
  const allowedAt = Math.max((state.lastQueryAttempt || 0) + minQueryInterval, state.blockedUntil || 0);
  return { due: reasons.length > 0 && now >= allowedAt, reasons, allowedAt };
}
export function planNotifications(state, now, config) {
  const intervals = todayIntervals(state, now), day = dayKey(now);
  const decisions = [], notifications = [], working = structuredClone(state);
  if (quietTime(now, config)) return { notifications, decisions: [{ reason: 'quiet_hours', intervals }], intervals };
  function add(type, text, patch) {
    const id = createHash('sha256').update(JSON.stringify([type, patch, text])).digest('hex');
    notifications.push({ id, type, text, patch });
    applyDelivery(working, patch, now);
  }
  const record = i => ({ key: intervalKey(day, i), interval: { ...i, day } });
  const startKeys = i => i.start > now && i.start - now <= 60 * MINUTE ? [startKey(day, i)] : [];
  if (working.morningDay !== day && intervals.length) {
    // Chunk at interval boundaries so even a long schedule stays below Telegram's limit.
    for (let pos = 0; pos < intervals.length; pos += 10) {
      const batch = intervals.slice(pos, pos + 10);
      const changes = batch.flatMap(i => {
        const previous = working.announced[intervalKey(day, i)];
        return previous && previous.end !== i.end ? [`Час завершення змінено: ${timeLabel(previous.end, now)} → ${timeLabel(i.end, now)}.`] : [];
      });
      add('daily_summary', batch.map(i => describe(i, now)).join('\n') +
        (changes.length ? '\n' + changes.join('\n') : ''), {
        morningDay: day, announced: batch.map(record), sent: batch.flatMap(startKeys),
      });
    }
  }
  for (const interval of intervals) {
    const key = intervalKey(day, interval), previous = working.announced[key];
    if (!previous || previous.end !== interval.end || previous.kinds.join() !== interval.kinds.join()) {
      let text = describe(interval, now);
      if (previous && previous.end !== interval.end) text = `Час завершення відключення змінено: ${timeLabel(previous.end, now)} → ${timeLabel(interval.end, now)}.\n${text}`;
      add(previous ? 'interval_changed' : 'new_interval', text, { announced: [record(interval)], sent: startKeys(interval) });
    }
    const reminder = startKey(day, interval);
    if (interval.start > now && interval.start - now <= 60 * MINUTE && !working.sent[reminder]) {
      add('before_start', describe(interval, now), { sent: [reminder] });
    }
    const endReminder = endKey(day, interval);
    if (now >= interval.end - 15 * MINUTE && !working.sent[endReminder]) {
      if ((state.lastQuerySuccess || 0) >= interval.end - 15 * MINUTE &&
          (state.lastQuerySuccess || 0) >= (state.lastQueryAttempt || 0) &&
          state.snapshot.events.some(e => e.end === interval.end) &&
          !effectiveEvents(state).some(e => interval.members.includes(`${e.kind}:${e.start}`) && e.observedAt > state.lastQuerySuccess)) {
        add('before_end', `За оновленим графіком скоро ввімкнуть світло (о ${timeLabel(interval.end, now)}).`, { sent: [endReminder] });
      } else decisions.push({ reason: 'end_reminder_waits_for_fresh_query', interval });
    }
  }
  // Today's intervals have already been announced above. Extend only early warnings,
  // not regular timers or the daily summary, into the upcoming quiet window.
  const todayStarts = new Set(intervals.map(i => i.start));
  const quietIntervals = upcomingQuietIntervals(state, now, config).filter(i => !todayStarts.has(i.start));
  for (const interval of quietIntervals) {
    const previous = working.announced[intervalKey(day, interval)];
    if (!previous || previous.end !== interval.end || previous.kinds.join() !== interval.kinds.join()) {
      const change = previous && previous.end !== interval.end
        ? `Час завершення відключення змінено: ${timeLabel(previous.end, now)} → ${timeLabel(interval.end, now)}.\n` : '';
      add(previous ? 'quiet_interval_changed' : 'upcoming_quiet_outage',
        `Завчасне попередження про відключення під час тихих годин.\n${change}${describe(interval, now)}`,
        { announced: [record(interval)] });
    }
  }
  for (const interval of mergeIntervals(effectiveEvents(state))) {
    const previous = working.announced[intervalKey(day, interval)];
    if (previous && previous.end > now && interval.end <= now && previous.end !== interval.end) {
      add('end_moved_to_past', `Час завершення відключення змінено: ${timeLabel(previous.end, now)} → ${timeLabel(interval.end, now)}. За оновленим графіком цей інтервал уже завершився.`, { announced: [record(interval)] });
    }
  }
  for (const [type, info] of Object.entries(state.unknown)) {
    if (!working.unknownSent[type]) add('unknown_type', `Невідомий тип відключення: «${info.reason.slice(0, 500)}». Потрібне уточнення правил; цей тип не враховано в розкладі.`, { unknown: [type] });
  }
  if (!notifications.length) decisions.push({ reason: intervals.length || quietIntervals.length ? 'no_new_or_due_notifications' : 'no_remaining_outages_today' });
  return { notifications, decisions, intervals, quietIntervals };
}
export function ingestParsed(state, parsed, log) {
  for (const item of parsed.unknown) state.unknown[normalize(item.reason)] = item;
  log('parsed', parsed);
}
