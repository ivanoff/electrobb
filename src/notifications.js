import { createHash } from 'node:crypto';
import { MINUTE, local, dayKey, quietTime, todayIntervals, describe, timeLabel, normalize, mergeIntervals, effectiveEvents, upcomingQuietIntervals } from './outages.js';
export const regularInterval = 60 * MINUTE;
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
export function queryDecision(state, now, config, startup = false, powerOff = false) {
  const intervals = todayIntervals(state, now);
  const confirm = !quietTime(now, config) && intervals.some(i => now >= i.end - 15 * MINUTE &&
    !state.sent[endKey(dayKey(now), i)] && (state.lastQuerySuccess || 0) < i.end - 15 * MINUTE);
  const regular = !state.lastQueryAttempt || now - state.lastQueryAttempt >= regularInterval;
  const afterEnd = mergeIntervals(effectiveEvents(state)).some(i =>
    now >= i.end + 5 * MINUTE && (state.lastQueryAttempt || 0) < i.end + 5 * MINUTE);
  const unexpectedOutage = powerOff && state.snapshot.at > 0 &&
    !effectiveEvents(state).some(i => i.start <= now && now < i.end);
  const reasons = [unexpectedOutage && 'unexpected_outage_15m', startup && 'startup', regular && 'regular_1h', confirm && 'confirm_end_15m',
    afterEnd && 'after_end_5m'].filter(Boolean);
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
    if (!previous || previous.end !== interval.end) {
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
    if (!previous || previous.end !== interval.end) {
      const change = previous && previous.end !== interval.end
        ? `Час завершення відключення змінено: ${timeLabel(previous.end, now)} → ${timeLabel(interval.end, now)}.\n` : '';
      add(previous ? 'quiet_interval_changed' : 'upcoming_quiet_outage',
        `Завчасне попередження про відключення під час тихих годин.\n${change}${describe(interval, now)}`,
        { announced: [record(interval)] });
    }
  }
  // First announcements cover both calendar days; reminders remain today's only.
  const tomorrowStart = local(now).plus({ days: 1 }).startOf('day').toMillis();
  const tomorrowEnd = local(now).plus({ days: 2 }).startOf('day').toMillis();
  const tomorrowIntervals = mergeIntervals(effectiveEvents(state))
    .filter(i => i.start >= tomorrowStart && i.start < tomorrowEnd);
  for (const interval of tomorrowIntervals) {
    const previous = working.announced[intervalKey(day, interval)];
    if (!previous || previous.end !== interval.end) {
      const change = previous && previous.end !== interval.end
        ? `Час завершення відключення змінено: ${timeLabel(previous.end, now)} → ${timeLabel(interval.end, now)}.\n` : '';
      add(previous ? 'interval_changed' : 'new_interval', `${change}${describe(interval, now)}`,
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
  if (!notifications.length) decisions.push({ reason: intervals.length || quietIntervals.length || tomorrowIntervals.length ? 'no_new_or_due_notifications' : 'no_remaining_outages_today' });
  // Combine simultaneous first announcements with the same description and date.
  // Keep patches together so retries and successful delivery cover every interval.
  const grouped = [];
  for (const notification of notifications) {
    const match = ['new_interval', 'upcoming_quiet_outage'].includes(notification.type)
      && notification.text.match(/^([\s\S]*?: (?:завтра \(\d{2}\.\d{2}\) |\d{2}\.\d{2} )?)(з .*)$/);
    const group = match && grouped.find(g => g.header === match[1] && g.type === notification.type
      && g.text.length + match[2].length + 4 < 3500);
    if (group) {
      group.lines.push(match[2]);
      group.text = group.header.trimEnd() + (group.header.trimEnd().endsWith(':') ? '' : ':')
        + '\n' + group.lines.map(line => '- ' + line).join('\n');
      group.patch.announced.push(...notification.patch.announced);
      group.patch.sent = [...(group.patch.sent || []), ...(notification.patch.sent || [])];
      group.id = createHash('sha256').update(JSON.stringify([group.type, group.patch, group.text])).digest('hex');
    } else grouped.push({ ...notification, patch: structuredClone(notification.patch),
      ...(match ? { header: match[1], lines: [match[2]] } : {}) });
  }
  return { notifications: grouped.map(({ header, lines, ...notification }) => notification), decisions, intervals, quietIntervals };
}
export function ingestParsed(state, parsed, log) {
  for (const item of parsed.unknown) state.unknown[normalize(item.reason)] = item;
  log('parsed', parsed);
}
