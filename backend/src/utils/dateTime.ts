const PROGRAM_TIME_ZONE = (
  process.env['PROGRAM_TIMEZONE']?.trim()
  || process.env['APP_TIMEZONE']?.trim()
  || 'America/Denver'
);

type DateLike = Date | string;

function toValidDate(value: DateLike): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatInProgramTimeZone(value: DateLike): string {
  const parsed = toValidDate(value);
  if (!parsed) {
    return 'TBD';
  }

  return parsed.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: PROGRAM_TIME_ZONE,
    timeZoneName: 'short',
  });
}

export { formatInProgramTimeZone, PROGRAM_TIME_ZONE };
