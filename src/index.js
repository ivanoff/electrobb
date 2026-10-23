import { Monitor, migrateState } from './monitor.js';
import { configFromEnv } from './config.js';
import { createLogger } from './log.js';
import { parseOutages } from './outages.js';
import { newState, planNotifications } from './notifications.js';
import { loginQr } from './login-qr.js';
import qrcode from 'qrcode-terminal';
import { requestLoginCode } from './login-code.js';
import { signature, freshReplies } from './replies.js';
import MTProto from '@mtproto/core';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'cache'), { recursive: true, mode: 0o700 });
const mt = new MTProto({ api_id: Number(process.env.TELEGRAM_API_ID), api_hash: process.env.TELEGRAM_API_HASH,
  storageOptions: { path: resolve(root, 'cache/storage.json') } });
const randomId = () => randomBytes(8).readBigInt64LE().toString();
async function call(method, params, attempts = 0) {
  try { return await mt.call(method, params); }
  catch (error) {
    const migration = error.error_message?.match(/^(?:PHONE|USER|NETWORK)_MIGRATE_(\d+)$/);
    if (attempts < 3 && migration) {
      await mt.setDefaultDc(Number(migration[1]));
      return call(method, params, attempts + 1);
    }
    throw error;
  }
}
async function login() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    try {
      if (process.argv.includes('--qr')) {
        console.log('На телефоне: Telegram → Настройки → Устройства → Подключить устройство. Отсканируйте QR-код.');
        await loginQr({ call, setDc: id => mt.setDefaultDc(id), updates: mt.updates,
          show: url => qrcode.generate(url, { small: true }) });
      } else {
      const phone_number = await rl.question('Телефон (+380…): ');
      const code = await requestLoginCode({ call, phone_number, ask: question => rl.question(question) });
      if (!code.authorized) await call('auth.signIn', { phone_number, ...code });
      }
    } catch (error) {
      if (error.error_message !== 'SESSION_PASSWORD_NEEDED') throw error;
      const { srp_id, current_algo: { salt1, salt2, g, p }, srp_B } = await call('account.getPassword', {});
      // readline does not hide input: use a private terminal for this prompt.
      const { A, M1 } = await mt.crypto.getSRPParams({ g, p, salt1, salt2, gB: srp_B,
        password: await rl.question('Пароль 2FA (ввод виден): ') });
      await call('auth.checkPassword', { password: { _: 'inputCheckPasswordSRP', srp_id, A, M1 } });
    }
    console.log('Вход выполнен.');
  } finally { rl.close(); }
}
function peer(chat) {
  if (chat._ === 'channel') return { _: 'inputPeerChannel', channel_id: chat.id, access_hash: chat.access_hash };
  if (chat._ === 'chat') return { _: 'inputPeerChat', chat_id: chat.id };
  return { _: 'inputPeerUser', user_id: chat.id, access_hash: chat.access_hash };
}
async function target() {
  const matches = new Map();
  let offset = { offset_date: 0, offset_id: 0, offset_peer: { _: 'inputPeerEmpty' } };
  for (;;) {
    const page = await call('messages.getDialogs', { ...offset, limit: 100, hash: 0, exclude_pinned: true });
    for (const chat of page.chats) {
      if (process.env.TARGET_ID ? String(chat.id) === process.env.TARGET_ID : chat.title === (process.env.TARGET_TITLE || '😱AAA')) matches.set(String(chat.id), chat);
    }
    if (!page.dialogs.length || page._ !== 'messages.dialogsSlice') break;
    const last = page.dialogs.at(-1);
    const id = last.peer.channel_id || last.peer.chat_id || last.peer.user_id;
    const entity = [...page.chats, ...page.users].find(x => String(x.id) === String(id));
    const message = page.messages.find(x => x.id === last.top_message && String(x.peer_id?.channel_id || x.peer_id?.chat_id || x.peer_id?.user_id) === String(id));
    if (!entity || !message) throw new Error('Не удалось продолжить поиск канала. Укажите TARGET_ID.');
    offset = { offset_date: message.date, offset_id: message.id, offset_peer: peer(entity) };
  }
  if (matches.size !== 1) throw new Error(`Найдено каналов назначения: ${matches.size}. Проверьте TARGET_TITLE или TARGET_ID.`);
  return peer([...matches.values()][0]);
}
async function history(bot, offset_id = 0) {
  const h = await call('messages.getHistory', { peer: bot, limit: 100, offset_id, offset_date: 0, add_offset: 0, max_id: 0, min_id: 0, hash: 0 });
  return h.messages.filter(x => x._ === 'message');
}
async function fetchSnapshot(bot) {
  const before = await history(bot);
  if (process.env.BOT_BUTTON) {
    const message = before.find(m => m.reply_markup?.rows?.some(r => r.buttons.some(b => b.text === process.env.BOT_BUTTON)));
    const button = message?.reply_markup.rows.flatMap(r => r.buttons).find(b => b.text === process.env.BOT_BUTTON);
    if (!button) throw new Error('Кнопка BOT_BUTTON не найдена. Выполните bun run inspect.');
    if (button._ === 'keyboardButtonCallback') {
      await call('messages.getBotCallbackAnswer', { peer: bot, msg_id: message.id, data: button.data });
    } else if (button._ === 'keyboardButton') {
      await call('messages.sendMessage', { peer: bot, message: button.text, random_id: randomId() });
    } else throw new Error('Этот тип кнопки не поддерживается.');
  } else {
    await call('messages.sendMessage', { peer: bot, message: process.env.BOT_COMMAND, random_id: randomId() });
  }
  let changed = await waitForReplies(bot, before);
  const observed = [...before, ...changed];
  if (process.env.BOT_ACCOUNT) {
    if (!changed.some(m => /Введіть особовий рахунок/i.test(m.message || ''))) {
      throw new Error('Бот не запросил лицевой счёт; ответ не отправлен.');
    }
    const accountBefore = await history(bot);
    await call('messages.sendMessage', { peer: bot, message: process.env.BOT_ACCOUNT, random_id: randomId() });
    changed = await waitForReplies(bot, accountBefore);
    observed.push(...accountBefore, ...changed);
    changed = changed.filter(m => (m.message || '').includes(`О/р ${process.env.BOT_ACCOUNT}`));
    if (!changed.length) throw new Error('Нет итогового ответа для выбранного лицевого счёта.');
  }
  return { replies: changed, observed };
}
async function waitForReplies(bot, before) {
  const deadline = Date.now() + 60000;
  let changed = [], previous = '', stable = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    changed = freshReplies(before, await history(bot));
    const current = JSON.stringify(changed.map(m => [m.id, signature(m)]));
    stable = changed.length && current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 3) break;
  }
  if (!changed.length) throw new Error('Бот не прислал новый ответ за 60 секунд; старые сообщения не отправлены.');
  return changed;
}
const statePath = resolve(root, 'cache/state.json');
async function save(state) {
  await writeFile(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
  await rename(statePath + '.tmp', statePath);
}
async function state() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
async function main() {
  if (process.argv.includes('--login')) return login();
  await call('users.getFullUser', { id: { _: 'inputUserSelf' } });
  const resolved = await call('contacts.resolveUsername', { username: 'ChernigivOEbot' });
  const user = resolved.users.find(u => String(u.id) === String(resolved.peer.user_id));
  if (!user?.bot) throw new Error('@ChernigivOEbot не является ботом.');
  const bot = peer(user);
  if (process.argv.includes('--inspect')) {
    console.log(JSON.stringify((await history(bot)).slice(0, 10).map(m => ({ id: m.id, out: !!m.out, text: m.message, buttons: m.reply_markup?.rows?.flatMap(r => r.buttons.map(b => ({ text: b.text, type: b._ }))) })), null, 2));
    return;
  }
  const config = configFromEnv();
  if (!!process.env.BOT_COMMAND === !!process.env.BOT_BUTTON) throw new Error('Задайте ровно одно: BOT_COMMAND или BOT_BUTTON.');
  if (process.argv.includes('--preview')) {
    const messages = await history(bot);
    const sample = newState();
    const latest = messages.find(m => !m.out && (m.message || '').includes(`О/р ${process.env.BOT_ACCOUNT}`));
    if (latest) sample.snapshot = { at: latest.date * 1000, events: parseOutages(latest.message, { account: process.env.BOT_ACCOUNT }).events };
    console.log(JSON.stringify(planNotifications(sample, Date.now(), config), null, 2));
    return;
  }
  const destination = await target();
  const log = createLogger(resolve(root, 'logs'));
  const monitor = new Monitor({ state: migrateState(await state()), save, log, config, account: process.env.BOT_ACCOUNT,
    transport: {
      async historySince(cursor) {
        let page = await history(bot), messages = [...page];
        // First run reads the latest 100 messages. Subsequent reads paginate all messages since the saved cursor.
        while (cursor && page.length === 100 && page.at(-1).id > cursor) {
          page = await history(bot, page.at(-1).id);
          messages.push(...page);
        }
        return messages;
      },
      query: () => fetchSnapshot(bot),
      send: (message, random_id) => call('messages.sendMessage', { peer: destination, message, random_id }),
    },
  });
  log('monitor_started', { config, queryMinutes: 120, historyMinutes: 10, minimumQueryMinutes: 15, destinationId: destination.channel_id || destination.chat_id });
  do {
    try { await monitor.tick(); }
    catch (error) { await monitor.failure(error, 'tick'); }
    if (process.argv.includes('--once')) return;
    await sleep(15_000);
  } while (true);
}
main().then(() => process.exit(0)).catch(error => {
  console.error(error.error_message || error.message);
  if (error.error_message === 'AUTH_KEY_UNREGISTERED') console.error('Выполните bun run login:qr.');
  process.exit(1);
});
