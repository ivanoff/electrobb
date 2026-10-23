export async function loginQr({ call, setDc, updates, show, now = Date.now }) {
  let wake;
  let notified = false;
  const onUpdate = event => {
    if (event?._ === 'updateLoginToken' || event?.update?._ === 'updateLoginToken' ||
        event?.updates?.some(u => u._ === 'updateLoginToken')) {
      notified = true;
      wake?.();
    }
  };
  const events = ['updateShort', 'updates', 'updatesCombined', 'updateLoginToken'];
  for (const event of events) updates.on(event, onUpdate);
  try {
    for (;;) {
      notified = false;
      let result = await call('auth.exportLoginToken', { except_ids: [] });
      if (result._ === 'auth.loginTokenMigrateTo') {
        await setDc(result.dc_id);
        result = await call('auth.importLoginToken', { token: result.token });
      }
      if (result._ === 'auth.loginTokenSuccess') return;
      if (result._ !== 'auth.loginToken') throw new Error(`Неожиданный ответ QR-входа: ${result._}`);
      show(`tg://login?token=${Buffer.from(result.token).toString('base64url')}`);
      if (notified) continue;
      await new Promise(resolve => {
        let timer;
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        timer = setTimeout(wake, Math.max(1000, result.expires * 1000 - now()));
      });
    }
  } finally {
    for (const event of events) updates.removeListener(event, onUpdate);
  }
}
