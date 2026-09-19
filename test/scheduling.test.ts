import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import {
  addDays, ageInMonths, madridDate, resolveDateRequest, slotMatchesDateRequest, splitDateRange,
  type DateRequest, type ResolvedDateRequest, type SchedulingCalendar, type SchedulingLocation,
  type TimeOfDay, type Weekday,
} from "../src/scheduling.js";

const calendar: SchedulingCalendar = {
  starts: "2026-09-07", ends: "2026-10-16", max_span_days: 14, slot_minutes: 15,
  closure_days: ["2026-10-12"],
};
const days: readonly Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const startedAt = new Date("2026-09-18T10:00:00Z");

function location(id: string, saturday = false, shortFriday = false): SchedulingLocation {
  return {
    id, name: `Synthetic ${id}`,
    hours: days.filter((weekday) => weekday !== "sunday" && (weekday !== "saturday" || saturday)).map((weekday) => ({
      weekday,
      intervals: weekday === "saturday" ? ["09:00–13:00"]
        : weekday === "friday" && shortFriday ? ["09:00-14:00"]
          : ["09:00–14:00", "16:00 - 20:00"],
    })),
  };
}

const locations: readonly SchedulingLocation[] = [
  location("test-weekend", true), location("test-weekdays"), location("test-short-friday", false, true),
];
const unknownHours: readonly SchedulingLocation[] = [{ id: "test-unknown", name: "Unknown hours" }];

function resolve(input: DateRequest = {}, locationId?: string): ResolvedDateRequest {
  return resolveDateRequest(input, startedAt, calendar, locations, locationId);
}

function hasCode(code: string, message?: RegExp): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code && (!message || message.test(error.message));
}

test("default search starts tomorrow and keeps the whole calendar without inventing a weekday", () => {
  assert.deepEqual(resolve(), { dateFrom: "2026-09-19", dateTo: "2026-10-16", timeOfDay: "any" });
  assert.deepEqual(resolve({ weekday: "monday", time_of_day: "morning" }), {
    dateFrom: "2026-09-19", dateTo: "2026-10-16", timeOfDay: "morning", weekday: "monday",
  });
  assert.deepEqual(resolveDateRequest({}, new Date("2026-09-01T12:00:00Z"), calendar, locations), {
    dateFrom: "2026-09-07", dateTo: "2026-10-16", timeOfDay: "any",
  });
});

const englishRelative = [
  ["tomorrow", "2026-09-19"],
  ["day after tomorrow", "2026-09-20"],
  ["a week from today", "2026-09-25"],
  ["in a fortnight", "2026-10-02"],
] as const;
for (const [phrase, expected] of englishRelative) {
  test(`published relative phrase: ${phrase}`, () => {
    const result = resolve({ date_phrase: phrase });
    assert.equal(result.dateFrom, expected);
    assert.equal(result.dateTo, expected);
    assert.equal(result.requestedDate, expected);
    assert.equal(result.weekday, undefined);
  });
}

test("published Saturday morning phrase resolves an exact day and part of day", () => {
  assert.deepEqual(resolve({ date_phrase: "on Saturday morning" }, "test-weekend"), {
    dateFrom: "2026-09-19", dateTo: "2026-09-19", requestedDate: "2026-09-19",
    timeOfDay: "morning", weekday: "saturday",
  });
});

const nextDates: Readonly<Record<Weekday, string>> = {
  monday: "2026-09-21", tuesday: "2026-09-22", wednesday: "2026-09-23",
  thursday: "2026-09-24", friday: "2026-09-25", saturday: "2026-09-19", sunday: "2026-09-20",
};
for (const weekday of days) {
  for (const [phrase, time] of [
    [`this coming ${weekday}`, "any"],
    [`first thing ${weekday}`, "morning"],
    [`first thing on ${weekday}`, "morning"],
    [`${weekday} afternoon`, "afternoon"],
  ] as const) {
    test(`published weekday vocabulary: ${phrase}`, () => {
      const result = resolve({ date_phrase: phrase });
      assert.equal(result.dateFrom, nextDates[weekday]);
      assert.equal(result.dateTo, nextDates[weekday]);
      assert.equal(result.requestedDate, nextDates[weekday]);
      assert.equal(result.weekday, weekday);
      assert.equal(result.timeOfDay, time);
    });
  }
  test(`a phrase naming today's weekday means seven days later: ${weekday}`, () => {
    const date = addDays("2026-09-14", days.indexOf(weekday));
    for (const phrase of [`this coming ${weekday}`, `first thing ${weekday}`, `${weekday} afternoon`]) {
      const result = resolveDateRequest({ date_phrase: phrase }, new Date(`${date}T10:00:00Z`), calendar, locations);
      assert.equal(result.dateFrom, addDays(date, 7));
      assert.equal(result.dateTo, addDays(date, 7));
    }
  });
}

for (const [phrase, expected] of [
  ["mañana", "2026-09-19"], ["pasado mañana", "2026-09-20"],
  ["dentro de una semana", "2026-09-25"], ["dentro de dos semanas", "2026-10-02"],
  ["demà", "2026-09-19"], ["demà passat", "2026-09-20"],
  ["d’aquí a una setmana", "2026-09-25"], ["d'aquí a dues setmanes", "2026-10-02"],
] as const) {
  test(`Spanish/Catalan relative equivalent: ${phrase}`, () => {
    const result = resolve({ date_phrase: phrase });
    assert.equal(result.dateFrom, expected);
    assert.equal(result.dateTo, expected);
  });
}

const translations = [
  ["monday", "lunes", "dilluns"], ["tuesday", "martes", "dimarts"],
  ["wednesday", "miércoles", "dimecres"], ["thursday", "jueves", "dijous"],
  ["friday", "viernes", "divendres"], ["saturday", "sábado", "dissabte"],
  ["sunday", "domingo", "diumenge"],
] as const;
for (const [weekday, spanish, catalan] of translations) {
  test(`Spanish and Catalan weekday forms: ${weekday}`, () => {
    for (const [phrase, time] of [
      [`este ${spanish}`, "any"], [`el próximo ${spanish}`, "any"],
      [`el ${spanish} que viene`, "any"], [`a primera hora el ${spanish}`, "morning"],
      [`el ${spanish} por la tarde`, "afternoon"],
      [`aquest ${catalan}`, "any"], [`el proper ${catalan}`, "any"],
      [`${catalan} vinent`, "any"], [`a primera hora el ${catalan}`, "morning"],
      [`${catalan} al matí`, "morning"], [`${catalan} a la tarda`, "afternoon"],
    ] as const) {
      const result = resolve({ date_phrase: phrase });
      assert.equal(result.dateFrom, nextDates[weekday], phrase);
      assert.equal(result.dateTo, nextDates[weekday], phrase);
      assert.equal(result.weekday, weekday, phrase);
      assert.equal(result.timeOfDay, time, phrase);
    }
  });
}

test("the published October phrase reports closure without silently shifting the request", () => {
  const expected: ResolvedDateRequest = {
    dateFrom: "2026-10-12", dateTo: "2026-10-12", timeOfDay: "morning", weekday: "monday",
    requestedDate: "2026-10-12",
    closed: { reason: "clinic_closed", requestedDate: "2026-10-12", nextOpenDate: "2026-10-13" },
  };
  for (const phrase of [
    "first thing on Monday the twelfth of October",
    "first thing on Monday the twelfth of October 2026",
    "a primera hora el lunes doce de octubre",
    "a primera hora el dilluns dotze d’octubre",
    "  FIRST THING on Monday the 12th of October. ",
  ]) {
    assert.deepEqual(resolve({ date_phrase: phrase }, "test-weekdays"), expected, phrase);
  }
});

test("explicit permission moves a closed exact day, retains time/site, and removes the stale weekday", () => {
  assert.deepEqual(resolve({
    date_phrase: "first thing on Monday the twelfth of October",
    date_from: "2026-10-12", date_to: "2026-10-12", weekday: "monday", allow_next_open_day: true,
  }, "test-weekdays"), {
    dateFrom: "2026-10-13", dateTo: "2026-10-13", timeOfDay: "morning",
    requestedDate: "2026-10-12", adjustedFrom: "2026-10-12",
  });
  assert.equal(resolve({
    date_from: "2026-10-12", date_to: "2026-10-12", allow_next_open_day: false,
  }).dateFrom, "2026-10-12");
});

test("Saturday opening is determined by the selected site, not a hardcoded name or ID", () => {
  assert.equal(resolve({ date_phrase: "on Saturday morning" }, "test-weekend").closed, undefined);
  assert.deepEqual(resolve({ date_phrase: "on Saturday morning" }, "test-weekdays").closed, {
    reason: "location_hours", requestedDate: "2026-09-19", nextOpenDate: "2026-09-21",
  });
  assert.equal(resolve({ date_phrase: "on Saturday morning" }).closed, undefined);
  const shifted = resolve({
    date_phrase: "on Saturday morning", allow_next_open_day: true,
  }, "test-weekdays");
  assert.equal(shifted.dateFrom, "2026-09-21");
  assert.equal(shifted.timeOfDay, "morning");
  assert.equal(shifted.weekday, undefined);
});

test("Sunday and afternoon-only constraints are read from complete weekly hours", () => {
  assert.deepEqual(resolve({ date_phrase: "this coming Sunday" }).closed, {
    reason: "location_hours", requestedDate: "2026-09-20", nextOpenDate: "2026-09-21",
  });
  const friday = { date_phrase: "Friday afternoon" };
  assert.equal(resolve(friday, "test-weekend").closed, undefined);
  assert.deepEqual(resolve(friday, "test-short-friday").closed, {
    reason: "location_hours", requestedDate: "2026-09-25", nextOpenDate: "2026-09-28",
  });
  const shifted = resolve({ ...friday, allow_next_open_day: true }, "test-short-friday");
  assert.equal(shifted.dateFrom, "2026-09-28");
  assert.equal(shifted.timeOfDay, "afternoon");
  assert.equal(shifted.weekday, undefined);
  assert.equal(shifted.closed, undefined);
});

test("next-open search skips catalogue closures without changing site or part of day", () => {
  const changedCalendar = { ...calendar, closure_days: ["2026-09-21", "2026-09-22"] };
  const result = resolveDateRequest({
    date_phrase: "Saturday morning", allow_next_open_day: true,
  }, startedAt, changedCalendar, locations, "test-weekdays");
  assert.equal(result.dateFrom, "2026-09-23");
  assert.equal(result.timeOfDay, "morning");
  assert.equal(resolve({
    date_from: "2026-10-11", date_to: "2026-10-11", allow_next_open_day: true,
  }, "test-weekdays").dateFrom, "2026-10-13");
});

test("catalogue hours can explicitly open Sunday; no built-in weekday closure is imposed", () => {
  const sundaySite: SchedulingLocation = {
    id: "test-sunday", name: "Synthetic Sunday opening",
    hours: [{ weekday: "Sunday", intervals: ["10:00–12:00"] }],
  };
  const result = resolveDateRequest({ date_phrase: "Sunday morning" }, startedAt, calendar, [sundaySite]);
  assert.equal(result.closed, undefined);
  assert.equal(result.dateFrom, "2026-09-20");
});

test("next-open suggestions stop at the calendar end even when shifting is authorized", () => {
  assert.deepEqual(resolve({
    date_from: "2026-10-16", date_to: "2026-10-16",
    time_of_day: "afternoon", allow_next_open_day: true,
  }, "test-short-friday"), {
    dateFrom: "2026-10-16", dateTo: "2026-10-16", timeOfDay: "afternoon", requestedDate: "2026-10-16",
    closed: { reason: "location_hours", requestedDate: "2026-10-16" },
  });
});

test("absent hours never establish a closure or an invented next opening", () => {
  const result = resolveDateRequest({
    date_phrase: "on Saturday morning", allow_next_open_day: true,
  }, startedAt, calendar, unknownHours, "test-unknown");
  assert.equal(result.dateFrom, "2026-09-19");
  assert.equal(result.closed, undefined);
  assert.equal(result.adjustedFrom, undefined);
  const holiday = resolveDateRequest({
    date_from: "2026-10-12", date_to: "2026-10-12", allow_next_open_day: true,
  }, startedAt, calendar, [...locations, ...unknownHours], "test-unknown");
  assert.deepEqual(holiday.closed, { reason: "clinic_closed", requestedDate: "2026-10-12" });
  assert.equal(holiday.adjustedFrom, undefined);
  assert.equal(resolveDateRequest({
    date_phrase: "Sunday afternoon",
  }, startedAt, calendar, [...locations, ...unknownHours]).closed, undefined);
});

test("present hours treat omitted weekdays as closed, with permission required to move", () => {
  assert.ok(locations.every((site) => site.hours?.every((entry) => entry.weekday !== "sunday")));
  const sunday = resolve({ date_phrase: "Sunday morning" });
  assert.equal(sunday.dateFrom, "2026-09-20");
  assert.deepEqual(sunday.closed, {
    reason: "location_hours", requestedDate: "2026-09-20", nextOpenDate: "2026-09-21",
  });
  assert.deepEqual(resolve({ date_phrase: "Sunday morning", allow_next_open_day: true }), {
    dateFrom: "2026-09-21", dateTo: "2026-09-21", timeOfDay: "morning",
    requestedDate: "2026-09-20", adjustedFrom: "2026-09-20",
  });
  assert.deepEqual(resolve({ date_phrase: "Saturday afternoon" }, "test-short-friday").closed, {
    reason: "location_hours", requestedDate: "2026-09-19", nextOpenDate: "2026-09-21",
  });
  const mondayOnly: readonly SchedulingLocation[] = [{
    id: "test-monday", name: "Synthetic Monday-only site",
    hours: [{ weekday: "monday", intervals: ["16:00–20:00"] }],
  }];
  assert.deepEqual(resolveDateRequest({
    date_phrase: "Saturday afternoon", allow_next_open_day: true,
  }, startedAt, calendar, mondayOnly), {
    dateFrom: "2026-09-21", dateTo: "2026-09-21", timeOfDay: "afternoon",
    requestedDate: "2026-09-19", adjustedFrom: "2026-09-19",
  });
});

test("an empty hours array establishes no open weekdays rather than unknown hours", () => {
  const result = resolveDateRequest({
    date_phrase: "Saturday morning", allow_next_open_day: true,
  }, startedAt, calendar, [{ id: "test-empty", name: "No openings", hours: [] }]);
  assert.equal(result.dateFrom, "2026-09-19");
  assert.equal(result.adjustedFrom, undefined);
  assert.deepEqual(result.closed, { reason: "location_hours", requestedDate: "2026-09-19" });
});

test("hours use exclusive ends, a 14:00 boundary, dash variants, and the catalogue slot grid", () => {
  const exact = { date_from: "2026-09-21", date_to: "2026-09-21" };
  const withIntervals = (intervals: string[], time: TimeOfDay) => resolveDateRequest(
    { ...exact, time_of_day: time }, startedAt, calendar,
    [{ id: "test-hours", name: "Synthetic hours", hours: [{ weekday: "Mon", intervals }] }],
  );
  assert.equal(withIntervals(["09:00-14:00"], "afternoon").closed?.reason, "location_hours");
  assert.equal(withIntervals(["14:00—20:00"], "morning").closed?.reason, "location_hours");
  assert.equal(withIntervals(["13:00 – 15:00"], "morning").closed, undefined);
  assert.equal(withIntervals(["13:00 − 15:00"], "afternoon").closed, undefined);
  assert.equal(withIntervals(["13:50-14:00"], "morning").closed?.reason, "location_hours");
  assert.equal(withIntervals(["13:45-14:00"], "morning").closed, undefined);
  assert.equal(withIntervals(["23:45–24:00"], "afternoon").closed, undefined);
});

test("malformed opening intervals and weekdays are rejected rather than guessed", () => {
  for (const interval of [
    "", "closed", "09-14", "09:60-14:00", "09:00-24:01", "24:00-24:00", "20:00-09:00", "09:00-09:00",
  ]) {
    assert.throws(() => resolveDateRequest({}, startedAt, calendar, [{
      id: "test-invalid", name: "Invalid", hours: [{ weekday: "monday", intervals: [interval] }],
    }]), hasCode("invalid_location_hours"), interval);
  }
  for (const weekday of ["someday", "constructor", "__proto__"]) {
    assert.throws(() => resolveDateRequest({}, startedAt, calendar, [{
      id: "test-invalid", name: "Invalid", hours: [{ weekday, intervals: [] }],
    }]), hasCode("invalid_location_hours"));
  }
  assert.throws(() => resolve({}, "missing-site"), hasCode("unknown_catalog_id"));
});

test("Madrid midnight, not UTC midnight, establishes tomorrow", () => {
  assert.equal(madridDate(new Date("2026-09-18T21:59:59.999Z")), "2026-09-18");
  assert.equal(madridDate(new Date("2026-09-18T22:00:00.000Z")), "2026-09-19");
  assert.equal(madridDate(new Date("2026-12-31T23:30:00Z")), "2027-01-01");
  const result = resolveDateRequest(
    { date_phrase: "tomorrow" }, new Date("2026-09-18T22:30:00Z"), calendar, unknownHours,
  );
  assert.equal(result.dateFrom, "2026-09-20");
  assert.throws(() => resolveDateRequest(
    { date_from: "2026-09-19", date_to: "2026-09-19" }, new Date("2026-09-18T22:30:00Z"), calendar, locations,
  ), hasCode("same_day_booking_not_allowed"));
});

test("relative calendar dates remain stable across both Madrid DST transitions", () => {
  for (const [instant, today, tomorrow] of [
    ["2026-03-28T23:30:00Z", "2026-03-29", "2026-03-30"],
    ["2026-03-29T00:30:00Z", "2026-03-29", "2026-03-30"],
    ["2026-03-29T01:30:00Z", "2026-03-29", "2026-03-30"],
    ["2026-10-24T22:30:00Z", "2026-10-25", "2026-10-26"],
    ["2026-10-25T00:30:00Z", "2026-10-25", "2026-10-26"],
    ["2026-10-25T01:30:00Z", "2026-10-25", "2026-10-26"],
  ]) {
    const date = new Date(instant!);
    assert.equal(madridDate(date), today);
    const result = resolveDateRequest({ date_phrase: "tomorrow" }, date, {
      ...calendar, starts: "2026-01-01", ends: "2026-12-31", closure_days: [],
    }, unknownHours);
    assert.equal(result.dateFrom, tomorrow);
    assert.equal(result.dateTo, tomorrow);
  }
  assert.equal(addDays("2026-03-28", 2), "2026-03-30");
  assert.equal(addDays("2026-10-24", 2), "2026-10-26");
});

test("ISO dates and compatible explicit bounds/phrase/weekday/time are reconciled by intersection", () => {
  const expected = {
    dateFrom: "2026-09-21", dateTo: "2026-09-21", timeOfDay: "morning",
    weekday: "monday", requestedDate: "2026-09-21",
  };
  assert.deepEqual(resolve({
    date_phrase: "first thing Monday", date_from: "2026-09-19", date_to: "2026-09-25",
    weekday: "monday", time_of_day: "any",
  }), expected);
  assert.deepEqual(resolve({
    date_phrase: "2026-09-21", date_from: "2026-09-21", date_to: "2026-09-21",
    weekday: "monday", time_of_day: "morning",
  }), expected);
  assert.deepEqual(resolve({ date_from: "2026-09-22" }), {
    dateFrom: "2026-09-22", dateTo: "2026-10-16", timeOfDay: "any",
  });
  assert.deepEqual(resolve({ date_to: "2026-09-23" }), {
    dateFrom: "2026-09-19", dateTo: "2026-09-23", timeOfDay: "any",
  });
});

test("conflicting phrase, range, weekday, and time constraints require clarification", () => {
  const conflicts: DateRequest[] = [
    { date_phrase: "tomorrow", date_from: "2026-09-21", date_to: "2026-09-22" },
    { date_phrase: "this coming Monday", date_to: "2026-09-20" },
    { date_phrase: "first thing Monday", time_of_day: "afternoon" },
    { date_phrase: "first thing Monday afternoon" },
    { date_phrase: "this coming Monday", weekday: "tuesday" },
    { date_phrase: "tomorrow", weekday: "monday" },
    { date_phrase: "first thing on Tuesday the twelfth of October" },
    { date_from: "2026-09-19", date_to: "2026-09-20", weekday: "monday" },
    { date_from: "2026-09-21", date_to: "2026-09-21", weekday: "tuesday" },
  ];
  for (const input of conflicts) {
    assert.throws(() => resolve(input), hasCode("conflicting_date_request", /clarify/i), JSON.stringify(input));
  }
});

test("invalid/ambiguous dates never silently become an unconstrained search", () => {
  for (const phrase of [
    "soon", "later", "next week", "today", "yesterday", "the 12th",
    "12/10/2026", "tomorrow or Monday", "in some weeks", "in a fortnight and a day", "constructor", "__proto__",
  ]) {
    assert.throws(() => resolve({ date_phrase: phrase }), hasCode("unknown_date_phrase", /clarify/i), phrase);
  }
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-9-21", "2026-09-21T00:00:00Z"]) {
    assert.throws(() => resolve({ date_from: date }), hasCode("invalid_date_request"), date);
  }
  assert.throws(() => resolve({ date_phrase: "2026-02-30" }), hasCode("invalid_date"));
  assert.throws(() => resolve({ date_phrase: "" }), hasCode("invalid_date_request"));
  assert.throws(() => resolve({ date_phrase: " ".repeat(3) }), hasCode("invalid_date_request"));
  assert.throws(() => resolve({ time_of_day: "evening" as TimeOfDay }), hasCode("invalid_date_request"));
  assert.throws(() => resolve({ weekday: "Monday" as Weekday }), hasCode("invalid_date_request"));
  assert.throws(() => resolve({ allow_next_open_day: "yes" as unknown as boolean }), hasCode("invalid_date_request"));
});

test("no same-day/past bookings, no reversed windows, and no clamping explicit out-of-calendar dates", () => {
  for (const date of ["2026-09-18", "2026-09-17"]) {
    assert.throws(() => resolve({ date_from: date }), hasCode("same_day_booking_not_allowed"));
    assert.throws(() => resolve({ date_phrase: date }), hasCode("same_day_booking_not_allowed"));
  }
  assert.throws(() => resolve({ date_from: "2026-09-23", date_to: "2026-09-22" }), hasCode("invalid_date_window"));
  assert.throws(() => resolve({ date_to: "2026-10-17" }), hasCode("invalid_date_window"));
  assert.throws(() => resolve({ date_phrase: "2026-10-17" }), hasCode("invalid_date_window"));
  assert.throws(() => resolveDateRequest(
    { date_phrase: "tomorrow" }, new Date("2026-09-01T10:00:00Z"), calendar, locations,
  ), hasCode("invalid_date_window"));
  assert.throws(() => resolveDateRequest(
    {}, new Date("2026-10-16T10:00:00Z"), calendar, locations,
  ), hasCode("invalid_date_window"));
  assert.throws(() => resolveDateRequest(
    { date_phrase: "in a fortnight" }, new Date("2026-10-03T10:00:00Z"), calendar, locations,
  ), hasCode("invalid_date_window"));
  assert.throws(() => resolveDateRequest({
    date_from: "9999-12-31", date_to: "9999-12-31", weekday: "monday",
  }, new Date("9999-12-30T10:00:00Z"), {
    ...calendar, starts: "9999-12-01", ends: "9999-12-31", closure_days: [],
  }, unknownHours), hasCode("conflicting_date_request"));
});

test("invalid catalogue calendars are rejected", () => {
  for (const changes of [
    { starts: "2026-09-31" }, { starts: "2026-10-17" }, { max_span_days: 0 },
    { max_span_days: 1.5 }, { slot_minutes: 0 }, { slot_minutes: 1441 },
    { closure_days: ["2026-02-29"] },
  ]) {
    assert.throws(() => resolveDateRequest({}, startedAt, { ...calendar, ...changes }, locations), hasCode("invalid_calendar"));
  }
  assert.throws(() => resolveDateRequest({}, new Date(Number.NaN), calendar, locations), hasCode("invalid_date"));
});

test("full searches larger than fourteen days are accepted and split into inclusive nonoverlapping API windows", () => {
  const full = resolve({ date_from: "2026-09-19", date_to: "2026-10-16" });
  assert.equal(full.dateTo, "2026-10-16");
  assert.deepEqual(splitDateRange(full.dateFrom, full.dateTo, calendar.max_span_days), [
    { dateFrom: "2026-09-19", dateTo: "2026-10-02" },
    { dateFrom: "2026-10-03", dateTo: "2026-10-16" },
  ]);
  assert.deepEqual(splitDateRange("2026-09-07", "2026-10-16", 30), [
    { dateFrom: "2026-09-07", dateTo: "2026-09-20" },
    { dateFrom: "2026-09-21", dateTo: "2026-10-04" },
    { dateFrom: "2026-10-05", dateTo: "2026-10-16" },
  ]);
  assert.deepEqual(splitDateRange("2026-09-19", "2026-09-23", 2), [
    { dateFrom: "2026-09-19", dateTo: "2026-09-20" },
    { dateFrom: "2026-09-21", dateTo: "2026-09-22" },
    { dateFrom: "2026-09-23", dateTo: "2026-09-23" },
  ]);
  assert.deepEqual(splitDateRange("9999-12-31", "9999-12-31"), [
    { dateFrom: "9999-12-31", dateTo: "9999-12-31" },
  ]);
  for (const span of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => splitDateRange("2026-09-19", "2026-09-20", span), hasCode("invalid_calendar"));
  }
  assert.throws(() => splitDateRange("2026-09-21", "2026-09-20"), hasCode("invalid_date_window"));
  assert.throws(() => splitDateRange("2026-09-31", "2026-10-01"), hasCode("invalid_date"));
});

test("date helpers validate Gregorian dates and whole-day offsets without normalizing impossible input", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2024-02-28", 2), "2024-03-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("0099-12-31", 1), "0100-01-01");
  assert.equal(addDays("2026-09-18", 0), "2026-09-18");
  for (const invalid of ["", "2026-02-29", "2026-04-31", "2026-9-01", "0000-01-01"]) {
    assert.throws(() => addDays(invalid, 1), hasCode("invalid_date"));
  }
  for (const invalid of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => addDays("2026-09-18", invalid), hasCode("invalid_date_offset"));
  }
  assert.throws(() => addDays("9999-12-31", 1), hasCode("invalid_date_offset"));
  assert.throws(() => addDays("0001-01-01", -1), hasCode("invalid_date_offset"));
  assert.throws(() => madridDate(new Date("invalid")), hasCode("invalid_date"));
  assert.throws(() => madridDate(null as unknown as Date), hasCode("invalid_date"));
});

test("slot matching applies Madrid date/weekday and the exact 14:00 time-of-day boundary", () => {
  const morning = resolve({ date_from: "2026-09-21", date_to: "2026-09-21", time_of_day: "morning", weekday: "monday" });
  assert.equal(slotMatchesDateRequest("2026-09-21T11:59:59Z", morning), true);
  assert.equal(slotMatchesDateRequest("2026-09-21T12:00:00Z", morning), false);
  const afternoon = { ...morning, timeOfDay: "afternoon" as const };
  assert.equal(slotMatchesDateRequest("2026-09-21T12:00:00Z", afternoon), true);
  assert.equal(slotMatchesDateRequest("2026-09-21T22:00:00Z", afternoon), false);
  assert.equal(slotMatchesDateRequest("2026-09-20T22:15:00Z", morning), true);
  assert.equal(slotMatchesDateRequest(new Date("2026-09-21T11:30:00Z"), morning), true);
  assert.equal(slotMatchesDateRequest("2026-09-22T10:00:00Z", resolve({ weekday: "monday" })), false);
  assert.equal(slotMatchesDateRequest("2026-10-12T09:00:00+02:00", resolve({ date_phrase: "2026-10-12" })), false);
  const winter: ResolvedDateRequest = { dateFrom: "2026-10-26", dateTo: "2026-10-26", timeOfDay: "afternoon" };
  assert.equal(slotMatchesDateRequest("2026-10-26T12:59:00Z", winter), false);
  assert.equal(slotMatchesDateRequest("2026-10-26T13:00:00Z", winter), true);
  assert.throws(() => slotMatchesDateRequest("2026-09-21T13:00:00", morning), hasCode("invalid_date"));
  assert.throws(() => slotMatchesDateRequest("not a time", morning), hasCode("invalid_date"));
});

test("month age uses the birthday boundary and the Madrid date rather than a rounded year count", () => {
  assert.equal(ageInMonths("2012-09-19", "2026-09-18"), 167);
  assert.equal(ageInMonths("2012-09-19", "2026-09-19"), 168);
  assert.equal(ageInMonths("2012-09-19", new Date("2026-09-18T22:01:00Z")), 168);
  assert.equal(ageInMonths("2026-09-18", "2026-09-18"), 0);
  assert.equal(ageInMonths("2012-02-29", "2026-02-28"), 167);
  assert.equal(ageInMonths("2012-02-29", "2026-03-01"), 168);
  assert.throws(() => ageInMonths("2026-09-19", "2026-09-18"), hasCode("invalid_birth_date"));
  assert.throws(() => ageInMonths("2012-02-30", "2026-09-18"), hasCode("invalid_date"));
});

test("resolution does not mutate call anchors, request objects, or catalogue fixtures", () => {
  const request = Object.freeze({ date_phrase: "Saturday morning", allow_next_open_day: true });
  const snapshot = JSON.stringify({ request, calendar, locations });
  const instant = startedAt.getTime();
  resolve(request, "test-weekdays");
  assert.equal(JSON.stringify({ request, calendar, locations }), snapshot);
  assert.equal(startedAt.getTime(), instant);
});
