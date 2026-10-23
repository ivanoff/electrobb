import { DateTime } from 'luxon';

export const ZONE = 'Europe/Kyiv';
export const MINUTE = 60_000;
export const local = ms => DateTime.fromMillis(ms, { zone: ZONE });
export const dayKey = ms => local(ms).toISODate();
export const timeLabel = (ms, now) => local(ms).toFormat(dayKey(ms) === dayKey(now) ? 'HH:mm' : 'dd.MM HH:mm');
export const normalize = text => text.replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').toLocaleLowerCase('uk');
export function classify(reason) {
  const text = normalize(reason);
  if (text.startsWith('виконання оперативних перемикань') ||
      text.startsWith('виконання ремонтних робіт на обладнанні підстанції')) return 'ignored';
  if (text === 'заходи обмеження' || /^графік погодинних відключень(?:\s*\(гпв\))?$/.test(text)) return 'planned';
  if (/^графіки аварійних відключень(?:\s*\(гав\))?$/.test(text)) return 'emergency';
  return 'unknown';
}
export function parseDate(text) {
  const value = DateTime.fromFormat(text, 'dd-MM-yyyy HH:mm', { zone: ZONE });
  // Reject nonexistent local times (spring DST jump), rather than silently moving them.
  if (!value.isValid || value.toFormat('dd-MM-yyyy HH:mm') !== text) throw new Error(`invalid_local_datetime: ${text}`);
  if (value.getPossibleOffsets().length > 1) throw new Error(`ambiguous_local_datetime: ${text}`);
  return value.toMillis();
}
const DATE = '(\\d{2}-\\d{2}-\\d{4} \\d{2}:\\d{2})';
export const eventKey = event => `${event.kind}:${event.start}`;
export function parseOutages(text, { account, source = 'snapshot', messageId, observedAt = Date.now() } = {}) {
  const result = { events: [], unknown: [], ignored: [], errors: [], recognized: false };
  const add = (reason, from, to, forcePlanned = false) => {
    const kind = classify(reason);
    if (kind === 'ignored') { result.ignored.push({ reason, from, to, decision: 'explicitly_excluded_reason' }); return; }
    if (kind === 'unknown' && !forcePlanned) { result.unknown.push({ reason, from, to }); return; }
    try {
      const start = parseDate(from), end = parseDate(to);
      if (end <= start) throw new Error('end_not_after_start');
      result.events.push({ kind: forcePlanned ? 'planned' : kind, start, end, reason, source, messageId, observedAt });
    } catch (error) { result.errors.push({ reason, from, to, error: error.message }); }
  };
  if (/повідомляє про планову перерву в електропостачанні/i.test(text)) {
    result.recognized = true;
    const foundAccount = text.match(/особовий рахунок\s*[–—\-:]\s*(\d+)/i)?.[1];
    if (account && foundAccount !== account) {
      result.ignored.push({ decision: 'different_or_missing_account' }); return result;
    }
    const reason = text.match(/Причина:\s*([\s\S]*?)(?:\n\s*Статус:|$)/i)?.[1]?.trim();
    const status = text.match(/Статус:\s*([^\n]+)/i)?.[1]?.trim();
    const dates = text.match(new RegExp('Дата/час перерви:\\s*з\\s*' + DATE + '\\s*по\\s*' + DATE, 'i'));
    if (!reason || !dates) { result.errors.push({ error: 'unrecognized_push_format' }); return result; }
    if (status && normalize(status) !== 'роботи заплановано') {
      result.errors.push({ error: 'unsupported_push_status', status }); return result;
    }
    add(reason, dates[1], dates[2], true);
    return result;
  }
  if (source !== 'snapshot') return result;
  if (account && !new RegExp(`О/р\\s+${account}(?!\\d)`).test(text)) {
    result.ignored.push({ decision: 'different_or_missing_account' }); return result;
  }
  const blocks = text.split(/~{3,}/);
  for (const block of blocks) {
    const match = block.match(new RegExp('([^\\n]+)\\s*\\nПочаток:\\s*' + DATE + '\\s*\\nЗакінчення:\\s*' + DATE, 'i'));
    if (!match) {
      if (/Початок:|Закінчення:/i.test(block)) result.errors.push({ error: 'unrecognized_schedule_block', block });
      continue;
    }
    result.recognized = true;
    add(match[1].trim(), match[2], match[3]);
  }
  if (!result.recognized && /(?:відключен\S*\s+(?:не\s+заплановано|не\s+передбачено|відсутні)|перерв\S*\s+(?:немає|не\s+заплановано))/i.test(text)) result.recognized = true;
  return result;
}
export function mergeIntervals(events) {
  const result = [];
  for (const event of [...events].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && event.start <= last.end) {
      last.end = Math.max(last.end, event.end);
      last.kinds = [...new Set([...last.kinds, event.kind])].sort();
      last.members.push(eventKey(event));
    } else result.push({ start: event.start, end: event.end, kinds: [event.kind], members: [eventKey(event)] });
  }
  return result;
}
export function effectiveEvents(state) {
  const events = new Map((state.snapshot?.events || []).map(e => [eventKey(e), e]));
  for (const event of Object.values(state.pushes || {})) {
    const previous = events.get(eventKey(event));
    if (!previous || event.observedAt > previous.observedAt) events.set(eventKey(event), event);
  }
  return [...events.values()];
}
export function todayIntervals(state, now) {
  const endOfDay = local(now).plus({ days: 1 }).startOf('day').toMillis();
  return mergeIntervals(effectiveEvents(state)).filter(i => i.end > now && i.start < endOfDay);
}
export function upcomingQuietWindow(now, config) {
  let start = local(now).set({ hour: Math.floor(config.quietStart / 60), minute: config.quietStart % 60, second: 0, millisecond: 0 });
  if (start.toMillis() <= now) start = start.plus({ days: 1 });
  const endDay = config.quietStart > config.quietEnd ? start.plus({ days: 1 }) : start;
  const end = endDay.set({ hour: Math.floor(config.quietEnd / 60), minute: config.quietEnd % 60, second: 0, millisecond: 0 });
  return { start: start.toMillis(), end: end.toMillis() };
}
export function upcomingQuietIntervals(state, now, config) {
  const window = upcomingQuietWindow(now, config);
  return mergeIntervals(effectiveEvents(state)).filter(i => i.start < window.end && i.end > window.start);
}
export function quietTime(now, config) {
  const date = local(now), minute = date.hour * 60 + date.minute;
  const start = config.quietStart, end = config.quietEnd;
  return start > end ? minute >= start || minute < end : minute >= start && minute < end;
}
export function describe(interval, now) {
  const kind = interval.kinds.length === 2 ? 'Відключення електроенергії' : interval.kinds[0] === 'emergency' ? 'Аварійне відключення електроенергії' : 'Планове відключення електроенергії';
  const mixed = interval.kinds.length === 2 ? ' (планове та аварійне)' : '';
  const minutes = Math.ceil((interval.start - now) / MINUTE);
  const relative = minutes <= 0 ? ' триває' : minutes === 60 ? ' через 1 годину' : minutes < 60 ? ` через ${minutes} хв` : '';
  return `${kind}${relative}: з ${timeLabel(interval.start, now)} до ${timeLabel(interval.end, now)}${mixed}.`;
}
