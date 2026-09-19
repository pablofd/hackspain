import { z } from "zod";
import { AppError } from "./errors.js";

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const timesOfDay = ["any", "morning", "afternoon"] as const;

export type Weekday = typeof weekdays[number];
export type TimeOfDay = typeof timesOfDay[number];
export type ISODate = string;

const isoDateSchema = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1 &&
    date.toISOString().slice(0, 10) === value;
});
const dateRequestSchema = z.object({
  date_from: isoDateSchema.optional(),
  date_to: isoDateSchema.optional(),
  date_phrase: z.string().trim().min(1).max(200).optional(),
  time_of_day: z.enum(timesOfDay).optional(),
  weekday: z.enum(weekdays).optional(),
  allow_next_open_day: z.boolean().optional(),
});

export type DateRequest = z.infer<typeof dateRequestSchema>;
export interface SchedulingCalendar {
  starts: string;
  ends: string;
  max_span_days: number;
  slot_minutes: number;
  closure_days: readonly string[];
}
export interface SchedulingLocation {
  id: string;
  name: string;
  hours?: readonly { weekday: string; intervals: readonly string[] }[];
}
export interface DateWindow {
  dateFrom: string;
  dateTo: string;
}
export interface ResolvedDateRequest extends DateWindow {
  timeOfDay: TimeOfDay;
  weekday?: Weekday;
  requestedDate?: string;
  adjustedFrom?: string;
  closed?: {
    reason: "clinic_closed" | "location_hours";
    requestedDate: string;
    nextOpenDate?: string;
  };
}

const calendarSchema = z.object({
  starts: isoDateSchema,
  ends: isoDateSchema,
  max_span_days: z.number().int().positive(),
  slot_minutes: z.number().int().min(1).max(24 * 60),
  closure_days: z.array(isoDateSchema),
}).refine((calendar) => calendar.starts <= calendar.ends);
const locationsSchema = z.array(z.object({
  id: z.string().min(1),
  name: z.string(),
  hours: z.array(z.object({
    weekday: z.string(),
    intervals: z.array(z.string()),
  })).optional(),
}));
const madridFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid", calendar: "iso8601", numberingSystem: "latn",
  year: "numeric", month: "2-digit", day: "2-digit",
});
const madridTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid", numberingSystem: "latn", hour: "2-digit", hourCycle: "h23",
});

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(code, message);
  return result.data;
}

function isoDate(value: string): string {
  return parse(isoDateSchema, value, "invalid_date", "Use a real calendar date in YYYY-MM-DD format.");
}

function validInstant(date: Date): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) ||
      date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new AppError("invalid_date", "A valid date and time within years 0001 to 9999 is required.");
  }
}

export function madridDate(date: Date): string {
  validInstant(date);
  const parts = madridFormatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return isoDate(`${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`);
}

/** Calendar arithmetic, independent of the host timezone and Madrid's DST transitions. */
export function addDays(date: ISODate, days: number): string {
  isoDate(date);
  if (!Number.isSafeInteger(days)) {
    throw new AppError("invalid_date_offset", "The number of calendar days must be a safe integer.");
  }
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() < 1 || result.getUTCFullYear() > 9999) {
    throw new AppError("invalid_date_offset", "The resulting date must be within years 0001 to 9999.");
  }
  return result.toISOString().slice(0, 10);
}

function weekdayOf(date: string): Weekday {
  return weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

function nextWeekday(date: string, weekday: Weekday): string {
  const offset = (weekdays.indexOf(weekday) - weekdays.indexOf(weekdayOf(date)) + 7) % 7;
  return addDays(date, offset || 7);
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[’‘]/g, "'").trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
}

function ownValue<T>(entries: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}

const dayNames: Readonly<Record<string, Weekday>> = {
  sunday: "sunday", monday: "monday", tuesday: "tuesday", wednesday: "wednesday",
  thursday: "thursday", friday: "friday", saturday: "saturday",
  domingo: "sunday", lunes: "monday", martes: "tuesday", miercoles: "wednesday",
  jueves: "thursday", viernes: "friday", sabado: "saturday",
  diumenge: "sunday", dilluns: "monday", dimarts: "tuesday", dimecres: "wednesday",
  dijous: "thursday", divendres: "friday", dissabte: "saturday",
};
const shortDayNames: Readonly<Record<string, Weekday>> = {
  sun: "sunday", mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday",
  thu: "thursday", thur: "thursday", thurs: "thursday", fri: "friday", sat: "saturday",
};
const relativeDays: Readonly<Record<string, number>> = {
  tomorrow: 1, "day after tomorrow": 2, "the day after tomorrow": 2,
  "a week from today": 7, "one week from today": 7, "in a week": 7, "in one week": 7,
  "in a fortnight": 14, "in two weeks": 14, "two weeks from today": 14,
  manana: 1, "pasado manana": 2, "dentro de una semana": 7, "en una semana": 7,
  "de hoy en una semana": 7, "una semana a partir de hoy": 7,
  "dentro de dos semanas": 14, "en dos semanas": 14, "dentro de catorce dias": 14,
  dema: 1, "dema passat": 2, "passat dema": 2,
  "d'aqui a una setmana": 7, "d'aqui una setmana": 7, "en una setmana": 7,
  "una setmana a partir d'avui": 7, "d'aqui a dues setmanes": 14,
  "d'aqui dues setmanes": 14, "en dues setmanes": 14,
};
const monthNames: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  gener: 1, febrer: 2, marc: 3, maig: 5, juny: 6,
  juliol: 7, agost: 8, setembre: 9, novembre: 11, desembre: 12,
};
const spokenDayNumbers: Readonly<Record<string, number>> = { twelfth: 12, doce: 12, dotze: 12 };
const weekdayPattern = new RegExp(
  `^(?:(?:on|this coming|this|next|el proximo|proximo|el proper|proper|el proxim|proxim|el|este|aquest) )?` +
  `(${Object.keys(dayNames).join("|")})(?: (?:que viene|vinent))?$`,
);
const absolutePattern = new RegExp(
  `^(?:(?:on|el) )?(?:(${Object.keys(dayNames).join("|")}) )?(?:the )?` +
  `(\\d{1,2}(?:st|nd|rd|th)?|${Object.keys(spokenDayNumbers).join("|")}) ` +
  `(?:(?:of|de) |d')?(${Object.keys(monthNames).join("|")})(?: (?:de |del )?(\\d{4}))?$`,
);
const monthFirstPattern = new RegExp(
  `^(?:(?:on|el) )?(?:(${Object.keys(dayNames).join("|")}) )?` +
  `(${Object.keys(monthNames).join("|")}) (?:the )?` +
  `(\\d{1,2}(?:st|nd|rd|th)?|${Object.keys(spokenDayNumbers).join("|")})(?: (?:de |del )?(\\d{4}))?$`,
);

interface ParsedPhrase {
  date: string;
  timeOfDay?: Exclude<TimeOfDay, "any">;
  weekday?: Weekday;
}

function conflict(message: string): never {
  throw new AppError("conflicting_date_request", `${message} Ask the caller to clarify the date or time.`);
}

function parsePhrase(value: string, today: string): ParsedPhrase {
  let phrase = normalize(value).replace(/\s*,\s*/g, " ").trim();
  let timeOfDay: Exclude<TimeOfDay, "any"> | undefined;
  const setTime = (time: Exclude<TimeOfDay, "any">) => {
    if (timeOfDay && timeOfDay !== time) conflict("The phrase specifies both morning and afternoon.");
    timeOfDay = time;
  };
  const firstThing = /^(?:first thing(?: on)?|a primera hora(?: del| el)?) /;
  if (firstThing.test(phrase)) {
    phrase = phrase.replace(firstThing, "");
    setTime("morning");
  }
  const timeSuffixes = [
    [/ (?:in the morning|morning|por la manana|de la manana|al mati|pel mati|a primera hora)$/, "morning"],
    [/ (?:in the afternoon|afternoon|por la tarde|de la tarde|a la tarda|de tarda|a la vesprada)$/, "afternoon"],
  ] as const;
  for (const [pattern, time] of timeSuffixes) {
    if (pattern.test(phrase)) {
      phrase = phrase.replace(pattern, "");
      setTime(time);
    }
  }
  const time = timeOfDay ? { timeOfDay } : {};
  const relative = ownValue(relativeDays, phrase);
  if (relative !== undefined) return { date: addDays(today, relative), ...time };
  if (/^\d{4}-\d{2}-\d{2}$/.test(phrase)) return { date: isoDate(phrase), ...time };
  const weekdayMatch = weekdayPattern.exec(phrase);
  if (weekdayMatch?.[1]) {
    const weekday = dayNames[weekdayMatch[1]]!;
    return { date: nextWeekday(today, weekday), weekday, ...time };
  }
  const absolute = absolutePattern.exec(phrase);
  const monthFirst = absolute ? null : monthFirstPattern.exec(phrase);
  const dayText = absolute?.[2] ?? monthFirst?.[3];
  const monthText = absolute?.[3] ?? monthFirst?.[2];
  if (dayText && monthText) {
    const day = spokenDayNumbers[dayText] ?? Number.parseInt(dayText, 10);
    const month = monthNames[monthText]!;
    const year = absolute?.[4] ?? monthFirst?.[4] ?? today.slice(0, 4);
    const date = isoDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    const weekdayText = absolute?.[1] ?? monthFirst?.[1];
    const weekday = weekdayText ? dayNames[weekdayText] : undefined;
    if (weekday && weekdayOf(date) !== weekday) conflict("The named weekday does not match the calendar date.");
    return { date, ...time, ...(weekday ? { weekday } : {}) };
  }
  throw new AppError("unknown_date_phrase",
    "Unsupported date wording. Do not retry it unchanged or widen the search. If the caller already confirmed a complete exact date, use YYYY-MM-DD as both date_from and date_to and omit date_phrase; keep the same request_id and explicit weekday/time/site/provider constraints. Otherwise clarify only the unresolved component. Never discard clock-time limits, exclusions or relative qualifiers without the caller's agreement.");
}

type Interval = readonly [number, number];
type WeeklyHours = ReadonlyMap<Weekday, readonly Interval[]>;

function parseInterval(value: string): Interval {
  const match = /^\s*(\d{1,2}):([0-5]\d)\s*[-‐‑‒–—−]\s*(\d{1,2}):([0-5]\d)\s*$/.exec(value);
  if (match) {
    const startHour = Number(match[1]);
    const endHour = Number(match[3]);
    const start = startHour * 60 + Number(match[2]);
    const end = endHour * 60 + Number(match[4]);
    if (startHour < 24 && endHour <= 24 && end <= 1440 && start < end) return [start, end];
  }
  throw new AppError("invalid_location_hours", "Clinic opening intervals must be increasing local HH:MM-HH:MM times.");
}

function prepareHours(locations: readonly SchedulingLocation[], locationId?: string): (WeeklyHours | undefined)[] {
  const parsed = parse(locationsSchema, locations, "invalid_location_hours", "The clinic's location hours are invalid.");
  if (locationId !== undefined && !parsed.some((location) => location.id === locationId)) {
    throw new AppError("unknown_catalog_id", "The requested location is not in the clinic catalogue.");
  }
  return parsed.filter((location) => locationId === undefined || location.id === locationId).map((location) => {
    if (location.hours === undefined) return undefined;
    const hours = new Map<Weekday, Interval[]>();
    for (const entry of location.hours) {
      const name = normalize(entry.weekday);
      const weekday = ownValue(dayNames, name) ?? ownValue(shortDayNames, name);
      if (!weekday) throw new AppError("invalid_location_hours", "Clinic hours contain an unrecognized weekday.");
      hours.set(weekday, [...(hours.get(weekday) ?? []), ...entry.intervals.map(parseInterval)]);
    }
    return hours;
  });
}

function isOpen(
  date: string, hours: readonly (WeeklyHours | undefined)[], time: TimeOfDay,
  slotMinutes: number, closures: ReadonlySet<string>,
): boolean | undefined {
  if (closures.has(date)) return false;
  let unknown = hours.length === 0;
  const lower = time === "afternoon" ? 14 * 60 : 0;
  const upper = time === "morning" ? 14 * 60 : 24 * 60;
  for (const weekly of hours) {
    if (weekly === undefined) {
      unknown = true;
      continue;
    }
    const intervals = weekly.get(weekdayOf(date)) ?? [];
    if (intervals.some(([start, end]) => {
      const firstStart = Math.ceil(Math.max(start, lower) / slotMinutes) * slotMinutes;
      return firstStart < Math.min(end, upper);
    })) return true;
  }
  return unknown ? undefined : false;
}

/**
 * Resolves bounded phrases, including comma-separated day-first/month-first dates,
 * not general natural language. A spoken month/day without
 * a year uses the call's Madrid year; it never silently rolls into the following year.
 * Explicit ranges bound a phrase; `weekday` alone filters a full search window.
 * Ranges remain unsplit: use splitDateRange (or equivalent pagination) before API calls.
 * A present hours array lists every open weekday: omitted weekdays are closed.
 * Only an absent hours field is unknown and stops next-opening suggestions.
 * An accepted next-open-day change clears weekday/closed, retaining requestedDate.
 */
export function resolveDateRequest(
  input: DateRequest,
  startedAt: Date,
  calendar: SchedulingCalendar,
  locations: readonly SchedulingLocation[],
  locationId?: string,
): ResolvedDateRequest {
  const request = parse(dateRequestSchema, input, "invalid_date_request",
    "Use valid YYYY-MM-DD dates, a supported weekday/time, and a boolean next-open-day permission. Ask the caller to clarify invalid dates.");
  const bookable = parse(calendarSchema, calendar, "invalid_calendar", "The bookable clinic calendar is invalid.");
  const hours = prepareHours(locations, locationId);
  const today = madridDate(startedAt);
  const tomorrow = addDays(today, 1);
  const firstBookable = tomorrow > bookable.starts ? tomorrow : bookable.starts;
  const phrase = request.date_phrase === undefined ? undefined : parsePhrase(request.date_phrase, today);

  if (request.date_from !== undefined && request.date_to !== undefined && request.date_from > request.date_to) {
    throw new AppError("invalid_date_window", "The requested start date must not be after the end date.");
  }
  for (const date of [request.date_from, request.date_to, phrase?.date]) {
    if (date === undefined) continue;
    if (date < tomorrow) {
      throw new AppError("same_day_booking_not_allowed",
        "Appointments must be after the day the call began, in Europe/Madrid.");
    }
    if (date < bookable.starts || date > bookable.ends) {
      throw new AppError("invalid_date_window", `The requested dates must be within ${bookable.starts} to ${bookable.ends}.`);
    }
  }
  if (phrase && ((request.date_from && phrase.date < request.date_from) ||
      (request.date_to && phrase.date > request.date_to))) {
    conflict("The date phrase falls outside the explicit date range.");
  }
  if (phrase?.weekday && request.weekday && phrase.weekday !== request.weekday) {
    conflict("The date phrase and requested weekday disagree.");
  }
  if (phrase?.timeOfDay && request.time_of_day && request.time_of_day !== "any" &&
      request.time_of_day !== phrase.timeOfDay) {
    conflict("The date phrase and requested time of day disagree.");
  }
  const dateFrom = phrase?.date ?? request.date_from ?? firstBookable;
  const dateTo = phrase?.date ?? request.date_to ?? bookable.ends;
  const timeOfDay = phrase?.timeOfDay ?? request.time_of_day ?? "any";
  const weekday = phrase?.weekday ?? request.weekday;
  if (dateFrom > dateTo) throw new AppError("invalid_date_window", "No future dates remain in the requested bookable calendar.");
  if (weekday) {
    const offset = (weekdays.indexOf(weekday) - weekdays.indexOf(weekdayOf(dateFrom)) + 7) % 7;
    const rangeDays = (new Date(`${dateTo}T00:00:00Z`).getTime() - new Date(`${dateFrom}T00:00:00Z`).getTime()) / 86_400_000;
    if (offset > rangeDays) conflict("The requested date range contains no occurrence of the selected weekday.");
  }
  const result: ResolvedDateRequest = { dateFrom, dateTo, timeOfDay, ...(weekday ? { weekday } : {}) };
  if (dateFrom !== dateTo) return result;
  result.requestedDate = dateFrom;

  const closures = new Set(bookable.closure_days);
  if (isOpen(dateFrom, hours, timeOfDay, bookable.slot_minutes, closures) !== false) return result;
  let nextOpenDate: string | undefined;
  for (let day = dateFrom; day < bookable.ends;) {
    day = addDays(day, 1);
    const open = isOpen(day, hours, timeOfDay, bookable.slot_minutes, closures);
    if (open === undefined) break;
    if (open) {
      nextOpenDate = day;
      break;
    }
  }
  if (request.allow_next_open_day && nextOpenDate) {
    return { dateFrom: nextOpenDate, dateTo: nextOpenDate, timeOfDay, requestedDate: dateFrom, adjustedFrom: dateFrom };
  }
  result.closed = {
    reason: closures.has(dateFrom) ? "clinic_closed" : "location_hours",
    requestedDate: dateFrom,
    ...(nextOpenDate ? { nextOpenDate } : {}),
  };
  return result;
}

/** Inclusive, contiguous API windows, honoring both the catalogue limit and the hard 14-day cap. */
export function splitDateRange(dateFrom: string, dateTo: string, maxSpanDays = 14): DateWindow[] {
  isoDate(dateFrom);
  isoDate(dateTo);
  if (dateFrom > dateTo) throw new AppError("invalid_date_window", "The requested start date must not be after the end date.");
  if (!Number.isSafeInteger(maxSpanDays) || maxSpanDays < 1) {
    throw new AppError("invalid_calendar", "The maximum query span must be a positive integer.");
  }
  const windows: DateWindow[] = [];
  const span = Math.min(maxSpanDays, 14);
  const finalDay = new Date(`${dateTo}T00:00:00Z`).getTime();
  for (let first = dateFrom;;) {
    const remaining = Math.round((finalDay - new Date(`${first}T00:00:00Z`).getTime()) / 86_400_000);
    const last = addDays(first, Math.min(span - 1, remaining));
    windows.push({ dateFrom: first, dateTo: last });
    if (last === dateTo) return windows;
    first = addDays(last, 1);
  }
}

/** Date/time/weekday filter only; clinic closures, site, provider and eligibility still require API/catalogue checks. */
export function slotMatchesDateRequest(startTime: string | Date, request: ResolvedDateRequest): boolean {
  const instant = typeof startTime === "string"
    ? new Date(parse(z.iso.datetime({ offset: true }), startTime, "invalid_date",
      "A slot must have an ISO timestamp with an explicit timezone offset."))
    : startTime;
  const date = madridDate(instant);
  const from = isoDate(request.dateFrom);
  const to = isoDate(request.dateTo);
  const time = parse(z.enum(timesOfDay), request.timeOfDay, "invalid_date_request", "Select a valid time of day.");
  const weekday = parse(z.enum(weekdays).optional(), request.weekday, "invalid_date_request", "Select a valid weekday.");
  if (from > to) throw new AppError("invalid_date_window", "The requested start date must not be after the end date.");
  if (request.closed || date < from || date > to || (weekday && weekdayOf(date) !== weekday)) return false;
  const hour = Number(madridTimeFormatter.format(instant));
  return time === "any" || (time === "morning" ? hour < 14 : hour >= 14);
}

/** Completed calendar months; a missing anniversary day is not reached until the next calendar day. */
export function ageInMonths(dateOfBirth: string, asOf: string | Date): number {
  const birth = isoDate(dateOfBirth);
  const today = asOf instanceof Date ? madridDate(asOf) : isoDate(asOf);
  if (birth > today) throw new AppError("invalid_birth_date", "The date of birth must not be in the future.");
  const born = new Date(`${birth}T00:00:00Z`);
  const current = new Date(`${today}T00:00:00Z`);
  return (current.getUTCFullYear() - born.getUTCFullYear()) * 12 + current.getUTCMonth() - born.getUTCMonth() -
    (current.getUTCDate() < born.getUTCDate() ? 1 : 0);
}
