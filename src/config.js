export function configFromEnv(env = process.env) {
  const parse = (value, name) => {
    if (!/^\d{2}:\d{2}$/.test(value)) throw new Error(`${name}: expected HH:mm`);
    const [hour, minute] = value.split(':').map(Number);
    if (hour > 23 || minute > 59) throw new Error(`${name}: invalid time`);
    return hour * 60 + minute;
  };
  const config = { quietStart: parse(env.QUIET_HOURS_START || '22:00', 'QUIET_HOURS_START'),
    quietEnd: parse(env.QUIET_HOURS_END || '09:00', 'QUIET_HOURS_END') };
  if (config.quietStart === config.quietEnd) throw new Error('Quiet start and end must differ');
  if (env.TIMEZONE && env.TIMEZONE !== 'Europe/Kyiv') throw new Error('TIMEZONE must be Europe/Kyiv');
  if (!/^\d{9}$/.test(env.BOT_ACCOUNT || '')) throw new Error('BOT_ACCOUNT must contain 9 digits');
  return config;
}
