export function configFromEnv(env = process.env) {
  const parse = (value, name) => {
    if (!/^\d{2}:\d{2}$/.test(value)) throw new Error(`${name}: expected HH:mm`);
    const [hour, minute] = value.split(':').map(Number);
    if (hour > 23 || minute > 59) throw new Error(`${name}: invalid time`);
    return hour * 60 + minute;
  };
  const quietEnabled = Boolean(env.QUIET_HOURS_START || env.QUIET_HOURS_END);
  if (quietEnabled && (!env.QUIET_HOURS_START || !env.QUIET_HOURS_END)) {
    throw new Error('QUIET_HOURS_START and QUIET_HOURS_END must be set together');
  }
  const config = { quietStart: quietEnabled ? parse(env.QUIET_HOURS_START, 'QUIET_HOURS_START') : null,
    quietEnd: quietEnabled ? parse(env.QUIET_HOURS_END, 'QUIET_HOURS_END') : null,
    silentStart: parse(env.SILENT_HOURS_START || '20:00', 'SILENT_HOURS_START'),
    silentEnd: parse(env.SILENT_HOURS_END || '11:00', 'SILENT_HOURS_END') };
  if (quietEnabled && config.quietStart === config.quietEnd) throw new Error('Quiet start and end must differ');
  if (config.silentStart === config.silentEnd) throw new Error('Silent start and end must differ');
  if (env.TIMEZONE && env.TIMEZONE !== 'Europe/Kyiv') throw new Error('TIMEZONE must be Europe/Kyiv');
  if (!/^\d{9}$/.test(env.BOT_ACCOUNT || '')) throw new Error('BOT_ACCOUNT must contain 9 digits');
  return config;
}
