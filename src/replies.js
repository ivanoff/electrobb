export const signature = message => JSON.stringify([message.message, message.edit_date, message.media]);
export function freshReplies(before, after) {
  const snapshots = new Map(before.map(m => [m.id, signature(m)]));
  const latest = Math.max(0, ...before.map(m => m.id));
  return after.filter(m => !m.out && (m.id > latest ||
    (snapshots.has(m.id) && snapshots.get(m.id) !== signature(m))));
}
