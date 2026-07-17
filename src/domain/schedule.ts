import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';

export const SCHEDULE_CADENCES = ['once', 'daily', 'weekly', 'monthly', 'custom'] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

export const SCHEDULE_STATUSES = ['active', 'paused', 'completed', 'revoked', 'depleted', 'expired'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_EXECUTORS = ['nwc', 'btcpay', 'fiber'] as const;
export type ScheduleExecutor = (typeof SCHEDULE_EXECUTORS)[number];

export const OCCURRENCE_STATUSES = [
  'resolving',
  'executing',
  'uncertain',
  'retrying',
  'succeeded',
  'failed',
  'blocked'
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export interface CalendarSchedule {
  cadence: ScheduleCadence;
  timeZone: string;
  anchorDay?: number;
  customIntervalSeconds?: number;
}

export function assertTimeZone(timeZone: string): string {
  const normalized = timeZone.trim();
  try {
    Temporal.Now.zonedDateTimeISO(normalized);
  } catch {
    throw new Error('Schedule time zone must be a valid IANA time-zone identifier.');
  }
  return normalized;
}

function localDateTimeFields(value: Temporal.PlainDateTime, timeZone: string) {
  return {
    timeZone,
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
    second: value.second,
    millisecond: value.millisecond,
    microsecond: value.microsecond,
    nanosecond: value.nanosecond
  };
}

export function nextOccurrenceAfter(current: Date, schedule: CalendarSchedule): Date | undefined {
  if (!Number.isFinite(current.getTime())) throw new Error('Current occurrence must be a valid date.');
  if (schedule.cadence === 'once') return undefined;
  if (schedule.cadence === 'custom') {
    const interval = schedule.customIntervalSeconds;
    if (!Number.isSafeInteger(interval) || (interval ?? 0) < 1 || (interval ?? 0) > 31_536_000) {
      throw new Error('Custom schedule interval must be between 1 second and 365 days.');
    }
    return new Date(current.getTime() + (interval as number) * 1000);
  }

  const timeZone = assertTimeZone(schedule.timeZone);
  const zoned = Temporal.Instant.from(current.toISOString()).toZonedDateTimeISO(timeZone);
  let local = zoned.toPlainDateTime();
  if (schedule.cadence === 'daily') local = local.add({ days: 1 });
  if (schedule.cadence === 'weekly') local = local.add({ days: 7 });
  if (schedule.cadence === 'monthly') {
    const anchorDay = schedule.anchorDay ?? local.day;
    if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
      throw new Error('Monthly schedule anchor day must be between 1 and 31.');
    }
    const nextMonth = local.with({ day: 1 }).add({ months: 1 });
    local = nextMonth.with({ day: Math.min(anchorDay, nextMonth.daysInMonth) });
  }

  const next = Temporal.ZonedDateTime.from(localDateTimeFields(local, timeZone), { disambiguation: 'compatible' });
  return new Date(Number(next.epochMilliseconds));
}

export function occurrenceLocalDay(occurrence: Date, timeZone: string): number {
  if (!Number.isFinite(occurrence.getTime())) throw new Error('Occurrence must be a valid date.');
  return Temporal.Instant.from(occurrence.toISOString()).toZonedDateTimeISO(assertTimeZone(timeZone)).day;
}

export function stableOccurrenceId(scheduleId: string, dueAt: Date): string {
  if (!scheduleId.trim() || !Number.isFinite(dueAt.getTime())) throw new Error('Occurrence identity requires a schedule and valid due time.');
  return 'occ_' + createHash('sha256').update(scheduleId + '|' + dueAt.toISOString()).digest('hex');
}

export function paymentRequestHash(paymentRequest: string): string {
  const normalized = paymentRequest.trim();
  if (!normalized) throw new Error('Payment request cannot be empty.');
  return createHash('sha256').update(normalized).digest('hex');
}
