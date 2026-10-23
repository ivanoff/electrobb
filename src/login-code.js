export async function requestLoginCode({ call, ask, log = console.log, now = Date.now, phone_number }) {
  let sent = await call('auth.sendCode', { phone_number, settings: { _: 'codeSettings' } });
  let receivedAt = now();
  for (;;) {
    if (sent._ === 'auth.sentCodeSuccess') return { authorized: true };
    const descriptions = {
      'auth.sentCodeTypeApp': 'служебный чат Telegram на уже авторизованных устройствах',
      'auth.sentCodeTypeSms': 'SMS на указанный номер',
      'auth.sentCodeTypeCall': 'телефонный звонок с голосовым кодом',
      'auth.sentCodeTypeEmailCode': `почта ${sent.type?.email_pattern || ''}`,
      'auth.sentCodeTypeFragmentSms': 'Fragment',
      'auth.sentCodeTypeMissedCall': 'последние цифры номера входящего звонка',
      'auth.sentCodeTypeFlashCall': 'номер входящего звонка',
    };
    log(`Telegram выбрал доставку: ${descriptions[sent.type?._] || sent.type?._ || 'неизвестно'}.`);
    if (['auth.sentCodeTypeSetUpEmailRequired', 'auth.sentCodeTypeFirebaseSms'].includes(sent.type?._)) {
      throw new Error(`Этот способ входа не поддерживается: ${sent.type._}.`);
    }
    if (!sent.phone_code_hash) throw new Error('Telegram не вернул данные для ввода кода.');
    if (sent.next_type) log(`Повторная доставка: ${sent.next_type._}; таймер Telegram: ${sent.timeout ?? 0} сек.`);
    else log('Telegram не предложил альтернативный способ доставки.');
    for (;;) {
      const answer = (await ask('Код Telegram (или /resend, если не пришёл): ')).trim();
      if (answer !== '/resend') {
        if (!answer) continue;
        return { phone_code_hash: sent.phone_code_hash, phone_code: answer };
      }
      if (!sent.next_type) {
        log('Повторная доставка сейчас недоступна по ответу Telegram.');
        continue;
      }
      const remaining = Math.ceil(((sent.timeout ?? 0) * 1000 - (now() - receivedAt)) / 1000);
      if (remaining > 0) {
        log(`До повторного запроса осталось ${remaining} сек. Затем введите /resend.`);
        continue;
      }
      sent = await call('auth.resendCode', { phone_number, phone_code_hash: sent.phone_code_hash });
      receivedAt = now();
      break;
    }
  }
}
