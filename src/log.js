import { mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { local } from './outages.js';
export function createLogger(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let day;
  return (event, data = {}) => {
    const now = local(Date.now());
    if (day !== now.toISODate()) {
      day = now.toISODate();
      const cutoff = now.minus({ days: 30 }).toISODate();
      for (const file of readdirSync(root)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) unlinkSync(join(root, file));
    }
    const line = JSON.stringify({ time: now.toISO(), event, ...data }, (key, value) => {
      const times = ['start', 'end', 'at', 'observedAt', 'allowedAt', 'until', 'blockedUntil'];
      return times.includes(key) && typeof value === 'number' && value > 1_000_000_000_000 ? local(value).toISO() : value;
    });
    appendFileSync(join(root, `${day}.jsonl`), line + '\n', { mode: 0o600 });
    console.log(line);
  };
}
