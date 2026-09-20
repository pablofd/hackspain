import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { setImmediate as settle, setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { z } from "zod";
import { AppError } from "../src/errors.js";
import { ProsperClient, type Clinic } from "../src/prosper.js";
import { actionSchema, type Availability, type ProsperAction, type Slot, type Patient } from "../src/prosper-types.js";
import type { AddressResolver } from "../src/geography.js";
import { ConfirmationGate, privacyRefusalGuidance, type OutcomeReviewContext } from "../src/confirmation.js";
import { Receptionist, receptionistInstructions, receptionistTools } from "../src/receptionist.js";
import { registrationReadbackGuidance } from "../src/registration.js";

const patient: Patient = {
  patient_id: "PTEST", given_name: "Ana", first_surname: "Prueba", second_surname: "Test",
  national_id: "12345678Z", date_of_birth: "1988-03-14", phone: "612345678",
  has_visited_before: true, insurer: "mapfre", referrals: [], note: "Seen before.",
  matched_fields: ["name", "national_id", "phone", "date_of_birth"],
};
const slot: Slot = {
  provider_id: "PRTEST", provider_name: "Test Doctor", specialty_id: "general_practice",
  location_id: "centro", appointment_type_id: "review", start_time: "2026-09-19T11:00:00+02:00",
  duration_minutes: 15, payable_with: ["mapfre"],
};
const clinic: Clinic = {
  clinic_name: "Test Clinic", patient_count: 1,
  calendar: { starts: "2026-09-07", ends: "2026-10-16", max_span_days: 14, slot_minutes: 15, closure_days: ["2026-10-12"] },
  providers: [{
    id: "PRTEST", name: "Test Doctor", specialty_id: "general_practice", languages: ["en", "es", "ca"],
    schedules: [{ location_id: "centro", location_name: "Centro", days: [
      { weekday: "saturday", intervals: ["09:00-14:00"] },
      { weekday: "monday", intervals: ["09:00-18:00"] },
    ] }], leave: null,
  }],
  locations: [{ id: "centro", name: "Centro", address: "Synthetic site", latitude: 40.4, longitude: -3.7, hours: [
    { weekday: "saturday", intervals: ["09:00-14:00"] },
    { weekday: "monday", intervals: ["09:00-18:00"] },
  ] }],
  specialties: [{ id: "general_practice", name: "General Practice", min_age_months: 168, max_age_months: null, referral_required: false }],
  appointment_types: [{ id: "review", name: "Review" }], plans: [{ id: "mapfre", name: "Mapfre" }], restrictions: [],
};
const appointment = {
  appointment_id: "ATEST", patient_id: "PTEST", provider_id: "PRTEST", location_id: "centro",
  appointment_type_id: "review", start_time: "2026-09-25T10:00:00+02:00", duration_minutes: 15,
};
const laterAppointment = { ...appointment, appointment_id: "AMOVE", start_time: "2026-10-03T09:45:00+02:00" };
const laterSlot = { ...slot, start_time: "2026-10-03T10:15:00+02:00" };
const registrationDetails = {
  given_name: patient.given_name, first_surname: patient.first_surname, second_surname: patient.second_surname,
  national_id: patient.national_id, date_of_birth: patient.date_of_birth, phone: patient.phone,
  email: "synthetic.patient@example.test", insurer: patient.insurer,
};

function harness(options: {
  callId?: string;
  allowSubmissions?: boolean;
  slots?: typeof slot[];
  post?: (body: Record<string, unknown>, attempt: number, init: RequestInit) => Promise<Response>;
  patients?: typeof patient[];
  appointments?: typeof appointment[];
  clinic?: typeof clinic;
  availability?: (query: URL) => Availability | Promise<Availability>;
  directory?: (query: URL) => Patient[];
  addressResolver?: Pick<AddressResolver, "resolve">;
  startedAt?: Date;
  beforeConfirmation?: (turn: number) => Promise<void>;
  beforeOutcome?: (turn: number, reason: string, context: OutcomeReviewContext) => Promise<void>;
} = {}) {
  let turn = 1;
  const controller = new AbortController();
  const writes: Record<string, unknown>[] = [];
  const requests: URL[] = [];
  const records: unknown[] = [];
  const recorded: ProsperAction[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    if (init?.method === "POST") {
      assert.equal(new Headers(init.headers).get("X-Api-Key"), "test-key");
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body)));
      writes.push(body);
      if (options.post) return options.post(body, writes.length, init);
      const { call_id, ...fields } = body;
      const kind = url.pathname.split("/").at(-1)?.toUpperCase().replace("-", "_");
      const action = actionSchema.parse(kind === "REGISTER"
        ? { action: kind, new_patient: fields } : { action: kind, ...fields });
      recorded.push(action);
      return Response.json({ call_id, received_at: "2026-09-18T18:00:00Z", record: { actions: recorded } });
    }
    if (url.pathname.endsWith("/clinic")) return Response.json(options.clinic ?? clinic);
    if (url.pathname.endsWith("/directory")) return Response.json({ matches: options.directory ? options.directory(url) : options.patients ?? [patient] });
    if (url.pathname.endsWith("/appointments")) return Response.json({ appointments: options.appointments ?? [appointment] });
    if (url.pathname.endsWith("/availability")) return Response.json(options.availability ? await options.availability(url) : {
      providers: [{ id: "PRTEST", name: "Test Doctor", specialty_id: "general_practice", languages: ["en", "es"] }],
      appointment_type: { id: "review", name: "Review", duration_minutes: 15, guidance: "For existing patients" },
      slots: (options.slots ?? [slot]).filter((s) =>
        s.start_time.slice(0, 10) >= (url.searchParams.get("date_from") ?? "") &&
        s.start_time.slice(0, 10) <= (url.searchParams.get("date_to") ?? "")),
      blocked: [],
    });
    throw new Error("Unexpected endpoint");
  };
  const engine = new Receptionist(new ProsperClient({
    PROSPER_API_BASE_URL: "https://clinic.example", PROSPER_API_KEY: "test-key",
  }, request), {
    callId: options.callId ?? "real-call-from-start", startedAt: options.startedAt ?? new Date("2026-09-18T18:00:00Z"),
    parent: ROOT_CONTEXT, signal: controller.signal,
    allowSubmissions: options.allowSubmissions ?? true, generation: () => turn,
    record: (event) => records.push(event),
    ...(options.beforeConfirmation ? { beforeConfirmation: options.beforeConfirmation } : {}),
    ...(options.beforeOutcome ? { beforeOutcome: options.beforeOutcome } : {}),
  }, options.addressResolver);
  const execute = (name: string, args: unknown) => engine.execute(name, JSON.stringify(args), turn);
  return { engine, execute, nextTurn: () => { turn += 1; }, writes, requests, records, controller };
}

async function identify(h: ReturnType<typeof harness>): Promise<void> {
  const result = z.object({ matches: z.array(z.object({ verified: z.boolean() })) }).parse(
    await h.execute("find_patient", { name: "Ana Prueba Test", national_id: "12345678Z" }),
  );
  assert.equal(result.matches[0]?.verified, true);
}

async function proposeBooking(h: ReturnType<typeof harness>): Promise<string> {
  await identify(h);
  const result = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" }),
  );
  const proposal = z.object({ proposal_id: z.string(), action: actionSchema }).parse(
    await h.execute("prepare_action", { request: {
      action: "BOOK", patient_id: "PTEST", slot_id: result.slots[0]?.slot_id, policy_id: "mapfre",
    } }),
  );
  assert.equal(h.writes.length, 0);
  return proposal.proposal_id;
}

function mockSubmissionClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  return t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
}

async function proposeScheduling(
  h: ReturnType<typeof harness>, action: "BOOK" | "RESCHEDULE", search: Record<string, unknown> = {},
) {
  await identify(h);
  if (action === "RESCHEDULE") await h.execute("list_appointments", { patient_id: patient.patient_id });
  const result = z.object({
    request_id: z.string(), slots: z.array(z.object({ slot_id: z.string() })),
  }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id, ...search,
  }));
  const slotId = result.slots[0]?.slot_id;
  const request = action === "BOOK"
    ? { action, patient_id: patient.patient_id, slot_id: slotId, policy_id: patient.insurer }
    : { action, appointment_id: appointment.appointment_id, slot_id: slotId, policy_id: patient.insurer };
  const proposal = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", { request }));
  return { ...proposal, request_id: result.request_id, request };
}

const bookingSearchSchema = z.object({
  request_id: z.string(),
  slots: z.array(z.object({ slot_id: z.string(), start_time: z.string(), payable_with: z.array(z.string()) })),
  booking_proposal: z.object({
    proposal_id: z.string(), request_id: z.string(), slot_id: z.string(),
    action: actionSchema, submitted: z.literal(false), instruction: z.string(),
  }).passthrough().nullable(),
  submitted: z.literal(false),
  pricing_status: z.literal("not_supplied"),
  searched_from: z.string(),
  no_booking: z.object({
    reason_candidates: z.array(z.string()), submitted: z.literal(false),
    next_day_search: z.object({
      patient_id: z.string(), request_id: z.string(), advance_day: z.literal(true),
      prepare_booking: z.literal(true).optional(),
    }).optional(),
  }).nullable(),
  instruction: z.string(),
});

const nearestBookingSearchSchema = bookingSearchSchema.extend({
  booking_continuation: z.object({
    previous_offer_invalidated: z.literal(true),
    prepare_action: z.object({ request: z.object({
      action: z.literal("BOOK"), patient_id: z.string(), slot_id: z.string(), policy_id: z.string(),
    }) }).nullable(),
  }).optional(),
});
const originCandidatesSchema = z.object({
  status: z.literal("needs_clarification"), reason: z.string(), truncated: z.boolean(),
  candidates: z.array(z.object({
    candidate_id: z.string(), label: z.string(),
    selection_arguments: z.object({ address: z.string(), candidate_id: z.string() }),
  })),
  instruction: z.string(),
});
const syntheticOriginAddress = "C/ del Ejemplo, 12, Madrid";
const syntheticOriginCandidate = {
  id: "synthetic-origin", label: "CALLE DEL EJEMPLO 12, Madrid", kind: "portal" as const,
  latitude: 40.4, longitude: -3.7,
};
const syntheticOriginResolver: Pick<AddressResolver, "resolve"> = {
  async resolve() {
    return { source: "cartociudad", status: "resolved", truncated: false, candidates: [syntheticOriginCandidate] };
  },
};

async function searchBooking(h: ReturnType<typeof harness>, input: Record<string, unknown> = {}) {
  return bookingSearchSchema.parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id, prepare_booking: true, ...input,
  }));
}

const laterSearchSchema = z.object({
  request_id: z.string(), searched_from: z.string(), booking_proposal: z.null(),
  slots: z.array(z.object({
    slot_id: z.string(), start_time: z.string(), provider_id: z.string(), location_id: z.string(),
  })),
  reschedule: z.object({
    original_appointment: z.object({
      appointment_id: z.string(), patient_id: z.string(), provider_id: z.string(), location_id: z.string(), start_time: z.string(),
    }),
    original_provider_name: z.string(), original_location_name: z.string(),
    prepare_action: z.object({ request: z.object({
      action: z.literal("RESCHEDULE"), appointment_id: z.string(), slot_id: z.string(), policy_id: z.string(),
    }) }).nullable(),
  }),
  instruction: z.string(),
});

async function searchLater(h: ReturnType<typeof harness>, input: Record<string, unknown> = {}) {
  return laterSearchSchema.parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, after_appointment_id: laterAppointment.appointment_id, ...input,
  }));
}

test("a booking submits the exact API slot and callSid only after a new confirmed turn", async () => {
  const h = harness();
  const proposalId = await proposeBooking(h);
  await assert.rejects(h.execute("confirm_action", { proposal_id: proposalId, confirmed: true }),
    { message: "Read the proposal aloud and wait for the caller's explicit confirmation in a new turn." });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposalId, confirmed: true });
  assert.deepEqual(h.writes, [{
    call_id: "real-call-from-start", patient_id: "PTEST", provider_id: "PRTEST", location_id: "centro",
    appointment_type_id: "review", slot: "2026-09-19T11:00:00+02:00", policy_id: "mapfre",
  }]);
  await h.execute("confirm_action", { proposal_id: proposalId, confirmed: true });
  assert.equal(h.writes.length, 1);
  assert.ok(h.records.some((r) => typeof r === "object" && r !== null && "stage" in r && r.stage === "accepted"));
});

test("unverified identities cannot read appointments or availability and protected fields never reach the model", async () => {
  const h = harness();
  const result = await h.execute("find_patient", { name: "Ana Prueba Test" });
  assert.ok(!JSON.stringify(result).includes(patient.national_id));
  assert.ok(!JSON.stringify(result).includes(patient.phone));
  await assert.rejects(h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" }));
  await assert.rejects(h.execute("list_appointments", { patient_id: "PTEST" }));
  await h.execute("find_patient", { name: "Ana Prueba Test", national_id: "00000000T" });
  await assert.rejects(h.execute("list_appointments", { patient_id: "PTEST" }));
  assert.equal(h.writes.length, 0);
});

test("a checksum-valid national identifier misplaced in phone is looked up without losing its letter", async () => {
  const h = harness({ directory: (url) =>
    url.searchParams.get("national_id") === patient.national_id && !url.searchParams.has("phone") ? [patient] : [] });
  const raw = await h.execute("find_patient", { name: "Ana Prueba Test", phone: "1234 5678-z" });
  const matches = z.object({ matches: z.array(z.object({ verified: z.boolean() })) }).parse(raw).matches;
  assert.equal(matches[0]?.verified, true);
  const result = z.object({
    identifier_input_adjustment: z.literal("national_id_from_phone"),
    matches: z.array(z.object({ verified: z.boolean() })),
  }).parse(raw);
  assert.equal(result.matches[0]?.verified, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.searchParams.get("national_id"), patient.national_id);
  assert.equal(h.requests[0]?.searchParams.has("phone"), false);
  assert.ok(!JSON.stringify(result).includes(patient.national_id));
  assert.ok(!JSON.stringify(result).includes(patient.phone));
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  assert.equal(h.writes.length, 0);
});

test("misplaced identifier repair never removes an explicit conflicting national identifier", async () => {
  const h = harness();
  await assert.rejects(h.execute("find_patient", {
    name: "Ana Prueba Test", national_id: "00000000T", phone: patient.national_id,
  }), { code: "conflicting_lookup_identifiers" });
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.execute("list_appointments", { patient_id: patient.patient_id }), { code: "patient_unverified" });
});

test("a national-ID-shaped value with a wrong checksum is never repaired or sent as a phone", async () => {
  const h = harness();
  await assert.rejects(h.execute("find_patient", {
    name: "Ana Prueba Test", phone: "12345678A",
  }), { code: "invalid_identifier_in_phone" });
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 0);
});

test("identifier field correction supports NIE but never invents a name or counts a repeated ID twice", async () => {
  const niePatient = { ...patient, national_id: "X1234567L" };
  const h = harness({ patients: [niePatient] });
  const verified = z.object({ matches: z.array(z.object({ verified: z.boolean() })) }).parse(
    await h.execute("find_patient", { name: "Ana Prueba Test", phone: "x-1234567-l" }),
  );
  assert.equal(verified.matches[0]?.verified, true);
  assert.equal(h.requests[0]?.searchParams.get("national_id"), niePatient.national_id);
  assert.equal(h.requests[0]?.searchParams.has("phone"), false);
  const noName = harness();
  const result = z.object({
    needs_full_name: z.literal(true), matches: z.array(z.object({ verified: z.boolean() })),
  }).parse(await noName.execute("find_patient", { national_id: patient.national_id, phone: patient.national_id }));
  assert.equal(result.matches[0]?.verified, false);
  await assert.rejects(noName.execute("list_appointments", { patient_id: patient.patient_id }), { code: "patient_unverified" });
});

test("ordinary phone and explicit national-ID lookups keep their supplied field semantics", async () => {
  for (const fields of [
    { phone: "+34 612 345 678" },
    { national_id: patient.national_id, phone: "+34 612 345 678" },
    { phone: "12345678" },
  ]) {
    const h = harness();
    const result = z.object({ identifier_input_adjustment: z.string().optional() }).parse(
      await h.execute("find_patient", { name: "Ana Prueba Test", ...fields }),
    );
    assert.equal(result.identifier_input_adjustment, undefined);
    assert.equal(h.requests[0]?.searchParams.get("phone"), fields.phone);
    assert.equal(h.requests[0]?.searchParams.get("national_id"), "national_id" in fields ? fields.national_id : null);
  }
});

test("an incomplete name asks for the full name rather than cycling a matching identifier", async () => {
  const h = harness();
  const result = z.object({
    needs_full_name: z.boolean(), instruction: z.string(),
    matches: z.array(z.object({ verified: z.boolean() })),
  }).parse(await h.execute("find_patient", { name: "Ana", national_id: patient.national_id }));
  assert.equal(result.needs_full_name, true);
  assert.equal(result.matches[0]?.verified, false);
  assert.match(result.instruction, /full legal name/);
  assert.match(result.instruction, /Reuse the corroborating detail already supplied/);
  assert.match(result.instruction, /Never supply or read the stored name/);
  assert.ok(!JSON.stringify(result).includes(patient.national_id));
  assert.ok(!JSON.stringify(result).includes(patient.phone));
  await assert.rejects(h.execute("list_appointments", { patient_id: patient.patient_id }), { code: "patient_unverified" });
  const verified = z.object({
    needs_full_name: z.boolean(), matches: z.array(z.object({ verified: z.boolean() })),
  }).parse(await h.execute("find_patient", { name: "Ana Prueba Test", national_id: patient.national_id }));
  assert.equal(verified.needs_full_name, false);
  assert.equal(verified.matches[0]?.verified, true);
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const lookups = h.requests.filter((url) => url.pathname.endsWith("/directory"));
  assert.equal(lookups.length, 2);
  assert.ok(lookups.every((url) => !url.searchParams.has("phone") && !url.searchParams.has("date_of_birth")));
  assert.equal(h.writes.length, 0);
});

test("a missing name reuses a supplied birth date without asking for a different corroborator", async () => {
  const h = harness();
  const result = z.object({ needs_full_name: z.boolean(), instruction: z.string() }).parse(
    await h.execute("find_patient", { date_of_birth: patient.date_of_birth }),
  );
  assert.equal(result.needs_full_name, true);
  assert.match(result.instruction, /Ask only for the patient's full legal name/);
  await assert.rejects(h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: "general_practice",
  }), { code: "patient_unverified" });
  const verified = z.object({ matches: z.array(z.object({ verified: z.boolean() })) }).parse(
    await h.execute("find_patient", { name: "Ana Prueba Test", date_of_birth: patient.date_of_birth }),
  );
  assert.equal(verified.matches[0]?.verified, true);
  assert.equal(h.writes.length, 0);
});

test("a lone given name still requests one corroborator rather than claiming one was supplied", async () => {
  const h = harness();
  const result = z.object({ needs_full_name: z.boolean(), instruction: z.string() }).parse(
    await h.execute("find_patient", { name: "Ana" }),
  );
  assert.equal(result.needs_full_name, true);
  assert.match(result.instruction, /full legal name and one corroborating detail/);
  assert.doesNotMatch(result.instruction, /Reuse/);
  assert.equal(h.writes.length, 0);
});

test("an empty alternative search retains bounded historical options without reviving old drafts", async () => {
  const h = harness();
  await identify(h);
  const first = z.object({
    request_id: z.string(), booking_proposal: z.object({ proposal_id: z.string() }),
  }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id, prepare_booking: true,
  }));
  h.nextTurn();
  const historical = z.object({
    start_time: z.string(), requires_new_search: z.literal(true), submitted: z.literal(false),
    recheck: z.record(z.string(), z.unknown()),
  });
  const empty = z.object({ no_booking: z.object({
    previous_options: z.array(historical),
  }) }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, request_id: first.request_id, date_phrase: "Monday",
  }));
  assert.equal(empty.no_booking.previous_options[0]?.start_time, slot.start_time);
  const recheck = empty.no_booking.previous_options[0]?.recheck;
  assert.ok(recheck);
  assert.equal(recheck.date_from, "2026-09-19");
  assert.equal(recheck.date_to, "2026-09-19");
  assert.equal(recheck.weekday, "saturday");
  assert.equal(recheck.prepare_booking, undefined, "Historical lookup must not silently select a different earliest slot");
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: first.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  const state = z.object({ requests: z.array(z.object({
    request_id: z.string(), previous_options: z.array(historical),
  })) }).parse(await h.execute("get_call_state", {}));
  assert.equal(state.requests[0]?.previous_options[0]?.start_time, slot.start_time);
  h.nextTurn();
  const refreshed = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await h.execute("search_availability", recheck),
  );
  const proposal = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", {
    request: { action: "BOOK", patient_id: patient.patient_id, slot_id: refreshed.slots[0]?.slot_id, policy_id: patient.insurer },
  }));
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: proposal.proposal_id, confirmed: true,
  }), { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.slot, slot.start_time);
});

test("outcome review receives current request evidence and cannot refuse an accepted historical offer", async () => {
  let current = 1;
  const gate = new ConfirmationGate(() => current, new AbortController().signal);
  const h = harness({ beforeOutcome: (turn, reason, context) => gate.reviewOutcome(turn, reason, context) });
  await identify(h);
  const result = z.object({ request_id: z.string() }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id, prepare_booking: true,
  }));
  h.nextTurn(); current += 1;
  await h.execute("search_availability", {
    patient_id: patient.patient_id, request_id: result.request_id, date_phrase: "Monday",
  });
  h.nextTurn(); current += 1;
  gate.observe(current, "Saturday morning then. Yes, book it.");
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "no_availability", request_id: result.request_id,
  }), { code: "outcome_request_unresolved" });
  assert.equal(h.writes.length, 0);
});

test("historical alternatives preserve current specialty, site and request isolation", async () => {
  const h = harness({ clinic: {
    ...clinic, locations: [...clinic.locations, { ...clinic.locations[0]!, id: "other-site" }],
  } });
  await identify(h);
  const first = z.object({ request_id: z.string() }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id,
  }));
  const filtered = z.object({ no_booking: z.object({ previous_options: z.array(z.unknown()) }) }).parse(
    await h.execute("search_availability", {
      patient_id: patient.patient_id, request_id: first.request_id, location_id: "other-site",
      date_phrase: "Monday",
    }),
  );
  assert.deepEqual(filtered.no_booking.previous_options, []);
  const separate = z.object({ no_booking: z.object({ previous_options: z.array(z.unknown()) }) }).parse(
    await h.execute("search_availability", {
      patient_id: patient.patient_id, specialty_id: slot.specialty_id, new_request: true, date_phrase: "Monday",
    }),
  );
  assert.deepEqual(separate.no_booking.previous_options, []);
});

test("availability recommends the earliest slot but preserves an explicitly selected later slot", async () => {
  const later = { ...slot, start_time: "2026-09-19T12:00:00+02:00" };
  const h = harness({ slots: [later, slot] });
  await identify(h);
  const result = z.object({
    recommended_slot_id: z.string(), instruction: z.string(),
    slots: z.array(z.object({ slot_id: z.string(), start_time: z.string() })),
  }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id, date_phrase: "Saturday",
  }));
  assert.equal(result.recommended_slot_id, result.slots[0]?.slot_id);
  assert.equal(result.slots[0]?.start_time, slot.start_time);
  assert.match(result.instruction, /not an unsolicited menu/);
  const selected = result.slots.find((item) => item.start_time === later.start_time);
  assert.ok(selected);
  const proposal = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", {
    request: { action: "BOOK", patient_id: patient.patient_id, slot_id: selected.slot_id, policy_id: patient.insurer },
  }));
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes[0]?.slot, later.start_time);
});

test("historical rechecks preserve a nearest-site request without adding a conflicting site filter", async () => {
  const h = harness({
    addressResolver: { async resolve() {
      return { source: "cartociudad", status: "resolved", truncated: false, candidates: [
        { id: "synthetic-origin", label: "Synthetic public street", kind: "portal", latitude: 40.4, longitude: -3.7 },
      ] };
    } },
  });
  await identify(h);
  const origin = z.object({ origin_id: z.string() }).parse(await h.execute("locate_origin", {
    address: "Synthetic public street 10, Madrid",
  }));
  const first = z.object({ request_id: z.string() }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id, nearest_origin_id: origin.origin_id,
  }));
  const empty = z.object({ no_booking: z.object({
    previous_options: z.array(z.object({ recheck: z.record(z.string(), z.unknown()) })),
  }) }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, request_id: first.request_id, date_phrase: "Monday",
  }));
  const recheck = empty.no_booking.previous_options[0]?.recheck;
  assert.ok(recheck);
  assert.equal(recheck.location_id, undefined);
  const refreshed = z.object({ slots: z.array(z.object({ location_id: z.string() })) }).parse(
    await h.execute("search_availability", recheck),
  );
  assert.equal(refreshed.slots[0]?.location_id, slot.location_id);
  assert.equal(h.writes.length, 0);
});

test("same-day slots are excluded and earliest search reaches later 14-day windows", async () => {
  const h = harness({ slots: [
    { ...slot, start_time: "2026-09-18T23:00:00+02:00" },
    { ...slot, start_time: "2026-10-03T09:00:00+02:00" },
  ] });
  await identify(h);
  const result = z.object({ slots: z.array(z.object({ start_time: z.string() })) }).parse(
    await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" }),
  );
  assert.equal(result.slots[0]?.start_time, "2026-10-03T09:00:00+02:00");
  const searches = h.requests.filter((url) => url.pathname.endsWith("/availability"));
  assert.equal(searches.length, 2);
  for (const url of searches) {
    const from = url.searchParams.get("date_from") ?? "";
    const to = url.searchParams.get("date_to") ?? "";
    assert.ok(Date.parse(to) - Date.parse(from) <= 13 * 86400000);
  }
  await assert.rejects(h.execute("search_availability", {
    patient_id: "PTEST", specialty_id: "general_practice", date_from: "2026-09-18",
  }));
});

test("new availability invalidates the old draft, and slot/policy invention is rejected", async () => {
  const h = harness();
  const old = await proposeBooking(h);
  h.nextTurn();
  const result = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" }),
  );
  await assert.rejects(h.execute("confirm_action", { proposal_id: old, confirmed: true }));
  await assert.rejects(h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: "PTEST", slot_id: "invented", policy_id: "mapfre",
  } }));
  await assert.rejects(h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: "PTEST", slot_id: result.slots[0]?.slot_id, policy_id: "privado",
  } }));
  assert.equal(h.writes.length, 0);
});

test("a second insurer is sent explicitly as repeated query parameters and used only when held", async () => {
  const h = harness({ slots: [{ ...slot, payable_with: ["sanitas"] }] });
  await identify(h);
  const result = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await h.execute("search_availability", {
      patient_id: "PTEST", specialty_id: "general_practice", additional_policy: "sanitas",
    }),
  );
  const search = h.requests.find((url) => url.pathname.endsWith("/availability"));
  assert.deepEqual(search?.searchParams.getAll("insurer"), ["mapfre", "sanitas"]);
  const proposal = z.object({ proposal_id: z.string() }).parse(
    await h.execute("prepare_action", { request: {
      action: "BOOK", patient_id: "PTEST", slot_id: result.slots[0]?.slot_id, policy_id: "sanitas",
    } }),
  );
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes[0]?.policy_id, "sanitas");
});

test("cancel and reschedule use verified upcoming appointments; historical IDs cannot be modified", async () => {
  const h = harness({ appointments: [appointment, { ...appointment, appointment_id: "PAST", start_time: "2025-01-01T10:00:00+01:00" }] });
  await identify(h);
  await h.execute("list_appointments", { patient_id: "PTEST", when: "all" });
  await assert.rejects(h.execute("prepare_action", { request: { action: "CANCEL", appointment_id: "PAST" } }));
  const proposal = z.object({ proposal_id: z.string() }).parse(
    await h.execute("prepare_action", { request: { action: "CANCEL", appointment_id: "ATEST" } }),
  );
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.deepEqual(h.writes[0], { call_id: "real-call-from-start", appointment_id: "ATEST" });

  const moving = harness();
  await identify(moving);
  await moving.execute("list_appointments", { patient_id: "PTEST" });
  const slots = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await moving.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" }),
  );
  const move = z.object({ proposal_id: z.string() }).parse(
    await moving.execute("prepare_action", { request: {
      action: "RESCHEDULE", appointment_id: "ATEST", slot_id: slots.slots[0]?.slot_id, policy_id: "mapfre",
    } }),
  );
  moving.nextTurn();
  await moving.execute("confirm_action", { proposal_id: move.proposal_id, confirmed: true });
  assert.deepEqual(moving.writes[0], {
    call_id: "real-call-from-start", appointment_id: "ATEST", provider_id: "PRTEST",
    location_id: "centro", slot: slot.start_time, policy_id: "mapfre",
  });
});

test("later rescheduling starts from the verified appointment, not tomorrow or a guessed request ID", async () => {
  const history = { ...laterAppointment, appointment_id: "AHISTORY", start_time: "2026-09-10T09:45:00+02:00" };
  const h = harness({
    appointments: [laterAppointment, history],
    slots: [slot, { ...laterSlot, start_time: "2026-10-03T09:15:00+02:00" },
      { ...laterSlot, start_time: laterAppointment.start_time },
      { ...laterSlot, start_time: "2026-10-03T07:45:00Z" }, laterSlot],
  });
  await identify(h);
  const listed = z.object({
    appointments: z.array(z.object({
      appointment_id: z.string(), can_modify: z.boolean(),
      later_search: z.object({ patient_id: z.string(), after_appointment_id: z.string() }).optional(),
    })),
    instruction: z.string(),
  }).parse(await h.execute("list_appointments", { patient_id: patient.patient_id, when: "all" }));
  const current = listed.appointments.find((item) => item.appointment_id === laterAppointment.appointment_id)!;
  assert.equal(current.can_modify, true);
  assert.deepEqual(current.later_search, {
    patient_id: patient.patient_id, after_appointment_id: laterAppointment.appointment_id,
  });
  assert.equal(listed.appointments.find((item) => item.appointment_id === history.appointment_id)?.later_search, undefined);
  assert.match(listed.instruction, /omit request_id/i);
  await assert.rejects(searchLater(h, { request_id: "INVENTED-REQUEST" }),
    { code: "request_not_found", message: /first search.*omit request_id/i });
  const result = laterSearchSchema.parse(await h.execute("search_availability", current.later_search));
  assert.equal(result.searched_from, "2026-10-03");
  assert.deepEqual(result.slots.map((value) => value.start_time), [laterSlot.start_time]);
  const query = h.requests.find((url) => url.pathname.endsWith("/availability"));
  assert.equal(query?.searchParams.get("date_from"), "2026-10-03");
  assert.equal(query?.searchParams.get("provider_id"), laterAppointment.provider_id);
  assert.equal(query?.searchParams.get("location_id"), laterAppointment.location_id);
  assert.equal(query?.searchParams.get("specialty_id"), slot.specialty_id);
  assert.equal(query?.searchParams.has("after_appointment_id"), false);
  assert.equal(result.reschedule.original_appointment.start_time, laterAppointment.start_time);
  assert.equal(result.reschedule.original_provider_name, clinic.providers[0]?.name);
  assert.equal(result.reschedule.original_location_name, clinic.locations[0]?.name);
  assert.ok(result.reschedule.prepare_action);
  const proposal = z.object({ proposal_id: z.string(), action: actionSchema, instruction: z.string() })
    .parse(await h.execute("prepare_action", result.reschedule.prepare_action));
  assert.equal(proposal.action.action, "RESCHEDULE");
  await assert.rejects(h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{
    call_id: "real-call-from-start", appointment_id: laterAppointment.appointment_id,
    provider_id: laterSlot.provider_id, location_id: laterSlot.location_id, slot: laterSlot.start_time, policy_id: patient.insurer,
  }]);
  await assert.rejects(searchLater(h, { new_request: true }), { code: "action_already_submitted" });
  assert.equal(h.writes.length, 1);
});

test("later rescheduling rejects unverified, historical and other-patient anchors and cannot turn into BOOK", async () => {
  const other = { ...patient, patient_id: "POTHER", given_name: "Bea", national_id: "00000000T" };
  const history = { ...laterAppointment, appointment_id: "AHISTORY", start_time: "2026-09-10T09:45:00+02:00" };
  const another = { ...laterAppointment, appointment_id: "AMOVESECOND" };
  const h = harness({
    appointments: [laterAppointment, history, another], slots: [laterSlot],
    directory: (query) => [query.searchParams.get("national_id") === other.national_id ? other : patient],
  });
  await assert.rejects(searchLater(h), { code: "patient_unverified" });
  await identify(h);
  await assert.rejects(searchLater(h), { code: "appointment_not_verified" });
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  await assert.rejects(searchLater(h, { after_appointment_id: history.appointment_id }), { code: "appointment_not_verified" });
  await h.execute("find_patient", { name: "Bea Prueba Test", national_id: other.national_id });
  await assert.rejects(searchLater(h, { patient_id: other.patient_id }), { code: "appointment_not_verified" });
  await assert.rejects(searchLater(h, { prepare_booking: true }), { code: "reschedule_not_booking" });
  const result = await searchLater(h);
  assert.ok(result.reschedule.prepare_action);
  assert.equal(h.records.some((event) => typeof event === "object" && event !== null && "stage" in event), false);
  await assert.rejects(h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: patient.patient_id, slot_id: result.slots[0]!.slot_id, policy_id: patient.insurer,
  } }), { code: "reschedule_not_booking" });
  await assert.rejects(h.execute("prepare_action", { request: {
    ...result.reschedule.prepare_action.request, appointment_id: another.appointment_id,
  } }), { code: "reschedule_appointment_mismatch" });
  await assert.rejects(searchLater(h, { date_from: "2026-09-28", date_to: "2026-09-28" }),
    { code: "reschedule_window_before_appointment" });
  assert.equal(h.writes.length, 0);
});

test("later rescheduling retains the original doctor/site through corrections and requires new consent", async () => {
  const correctedSlot = { ...laterSlot, start_time: "2026-10-05T11:30:00+02:00" };
  const h = harness({ appointments: [laterAppointment], slots: [laterSlot, correctedSlot] });
  await identify(h);
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const first = await searchLater(h);
  assert.ok(first.reschedule.prepare_action);
  const firstProposal = z.object({ proposal_id: z.string() }).parse(
    await h.execute("prepare_action", first.reschedule.prepare_action),
  );
  h.nextTurn();
  await h.execute("revise_request", { request_id: first.request_id });
  const state = z.object({ requests: z.array(z.object({
    request_id: z.string(), original_appointment: z.object({
      appointment_id: z.string(), provider_id: z.string(), location_id: z.string(),
    }),
  })) }).parse(await h.execute("get_call_state", {}));
  assert.equal(state.requests[0]?.original_appointment.appointment_id, laterAppointment.appointment_id);
  const corrected = laterSearchSchema.parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, request_id: first.request_id, date_from: "2026-10-05", date_to: "2026-10-05",
  }));
  assert.equal(corrected.request_id, first.request_id);
  assert.deepEqual(corrected.slots.map(({ provider_id, location_id, start_time }) => ({ provider_id, location_id, start_time })),
    [{ provider_id: laterAppointment.provider_id, location_id: laterAppointment.location_id, start_time: correctedSlot.start_time }]);
  assert.ok(corrected.reschedule.prepare_action);
  const next = z.object({ proposal_id: z.string(), instruction: z.string() }).parse(
    await h.execute("prepare_action", corrected.reschedule.prepare_action),
  );
  assert.match(next.instruction, /only.*changed/i);
  await assert.rejects(h.execute("confirm_action", { proposal_id: firstProposal.proposal_id, confirmed: true }),
    { code: "proposal_not_found" });
  await assert.rejects(h.execute("confirm_action", { proposal_id: next.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  assert.equal(h.writes.length, 0);
  assert.equal(h.requests.filter((url) => url.pathname.endsWith("/directory")).length, 1);
  assert.equal(h.requests.filter((url) => url.pathname.endsWith("/appointments")).length, 1);
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: next.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{
    call_id: "real-call-from-start", appointment_id: laterAppointment.appointment_id,
    provider_id: correctedSlot.provider_id, location_id: correctedSlot.location_id,
    slot: correctedSlot.start_time, policy_id: patient.insurer,
  }]);
});

test("later rescheduling permits caller-selected doctor/site changes without changing ordinary BOOK searches", async () => {
  const alternative = { ...laterSlot, provider_id: "ALTERNATIVE", location_id: "alternative-site" };
  const h = harness({
    appointments: [laterAppointment], slots: [slot, laterSlot, alternative],
    clinic: {
      ...clinic,
      providers: [...clinic.providers, { ...clinic.providers[0]!, id: alternative.provider_id, name: "Alternative Test Doctor" }],
      locations: [...clinic.locations, { ...clinic.locations[0]!, id: alternative.location_id, name: "Alternative Test Site" }],
    },
  });
  await identify(h);
  const booking = await searchBooking(h);
  assert.ok(booking.booking_proposal);
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const moved = await searchLater(h, { provider_id: alternative.provider_id, location_id: alternative.location_id });
  assert.notEqual(moved.request_id, booking.request_id);
  assert.equal(moved.slots[0]?.provider_id, alternative.provider_id);
  assert.equal(moved.slots[0]?.location_id, alternative.location_id);
  const repeated = laterSearchSchema.parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, request_id: moved.request_id,
  }));
  assert.equal(repeated.slots[0]?.provider_id, alternative.provider_id);
  assert.equal(repeated.reschedule.original_appointment.provider_id, laterAppointment.provider_id);
  assert.equal(repeated.reschedule.original_appointment.location_id, laterAppointment.location_id);
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: booking.booking_proposal.proposal_id, confirmed: true });
  assert.equal(h.writes[0]?.slot, slot.start_time, "Ordinary BOOK still uses its original earliest search, not the appointment anchor");
});

test("later phrases use the verified appointment's Madrid date only in the opt-in reschedule search", async () => {
  const sameInstant = { ...laterAppointment, start_time: "2026-10-02T23:45:00-08:00" };
  for (const date_phrase of ["later", "más tarde", "més tard"]) {
    const h = harness({ appointments: [sameInstant], slots: [laterSlot] });
    await identify(h);
    await h.execute("list_appointments", { patient_id: patient.patient_id });
    const result = await searchLater(h, { date_phrase });
    assert.equal(result.searched_from, "2026-10-03");
    assert.equal(result.slots[0]?.start_time, laterSlot.start_time);
    assert.equal(h.writes.length, 0);
  }
  const ordinary = harness();
  await identify(ordinary);
  await assert.rejects(searchBooking(ordinary, { date_phrase: "later" }), { code: "unknown_date_phrase" });
});

test("later rescheduling honors explicit relaxation and never picks between multiple held policies", async () => {
  const alternative: Slot = { ...laterSlot, provider_id: "ALTERNATIVE", payable_with: ["mapfre", "sanitas"] };
  const h = harness({
    appointments: [laterAppointment],
    clinic: { ...clinic, providers: [...clinic.providers, { ...clinic.providers[0]!, id: alternative.provider_id }] },
    slots: [alternative],
  });
  await identify(h);
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const unavailable = await searchLater(h);
  assert.equal(unavailable.slots.length, 0);
  const relaxed = await searchLater(h, {
    request_id: unavailable.request_id, relax_constraints: ["provider"], additional_policy: "sanitas",
  });
  assert.equal(relaxed.slots[0]?.provider_id, alternative.provider_id);
  assert.equal(relaxed.slots[0]?.location_id, laterAppointment.location_id);
  assert.equal(relaxed.reschedule.prepare_action, null);
  assert.equal(h.requests.findLast((url) => url.pathname.endsWith("/availability"))?.searchParams.get("provider_id"), null);
  const retained = await searchLater(h, { request_id: relaxed.request_id });
  assert.equal(retained.slots[0]?.provider_id, alternative.provider_id);
  assert.equal(retained.reschedule.prepare_action, null);
  assert.equal(h.writes.length, 0);
});

test("cancel1 and cancel2 use one explicit approval of the complete prepared request", async () => {
  const second = { ...laterAppointment, appointment_id: "ACANCELSECOND", start_time: "2026-10-05T11:30:00+02:00" };
  const historical = { ...laterAppointment, appointment_id: "AHISTORY", start_time: "2026-09-10T09:45:00+02:00" };
  for (const count of [1, 2]) {
    let current = 1;
    let reviews = 0;
    const gate = new ConfirmationGate(() => current, new AbortController().signal);
    const h = harness({
      appointments: [laterAppointment, second, historical],
      beforeConfirmation: (turn) => { reviews += 1; return gate.review(turn); },
    });
    await identify(h);
    await h.execute("list_appointments", { patient_id: patient.patient_id, when: "all" });
    await assert.rejects(h.execute("prepare_action", { request: { action: "CANCEL", appointment_id: historical.appointment_id } }),
      { code: "appointment_not_verified" });
    const ids = [laterAppointment.appointment_id, second.appointment_id].slice(0, count);
    const proposals: string[] = [];
    for (const appointment_id of ids) {
      const proposal = z.object({ proposal_id: z.string() }).parse(
        await h.execute("prepare_action", { request: { action: "CANCEL", appointment_id } }),
      );
      proposals.push(proposal.proposal_id);
    }
    const confirm = () => count === 1
      ? h.execute("confirm_action", { proposal_id: proposals[0], confirmed: true })
      : h.execute("confirm_actions", { proposal_ids: proposals, confirmed: true });
    await assert.rejects(confirm(), { code: "confirmation_requires_new_turn" });
    assert.equal(h.writes.length, 0);
    h.nextTurn(); current += 1;
    gate.observe(current, count === 1 ? "Yes, cancel that appointment." : "Yes, cancel both appointments.");
    await confirm();
    assert.equal(reviews, 1, "The completed caller turn approves the whole request, not one turn per CANCEL");
    assert.deepEqual(h.writes, ids.map((appointment_id) => ({ call_id: "real-call-from-start", appointment_id })));
    assert.ok(h.requests.filter((url) => url.pathname.includes("/submit/")).every((url) => url.pathname.endsWith("/cancel")));
    await confirm();
    assert.equal(reviews, 1);
    assert.equal(h.writes.length, count);
  }
});

test("a jointly approved cancellation batch never starts its remaining POST after hang-up", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const h = harness({
    appointments: [laterAppointment, { ...laterAppointment, appointment_id: "ACANCELSECOND" }],
    post: async () => { started.resolve(); return response.promise; },
  });
  await identify(h);
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const proposals: string[] = [];
  for (const appointment_id of [laterAppointment.appointment_id, "ACANCELSECOND"]) {
    proposals.push(z.object({ proposal_id: z.string() }).parse(
      await h.execute("prepare_action", { request: { action: "CANCEL", appointment_id } }),
    ).proposal_id);
  }
  h.nextTurn();
  const results = Promise.allSettled([
    h.execute("confirm_actions", { proposal_ids: proposals, confirmed: true }),
  ]);
  await started.promise;
  h.controller.abort();
  const closing = h.engine.close();
  response.resolve(new Response(null, { status: 409 }));
  const [result] = await results;
  await closing;
  assert.ok(result?.status === "rejected");
  assert.equal(result.reason.code, "call_cancelled");
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", appointment_id: laterAppointment.appointment_id }]);
  await assert.rejects(h.execute("confirm_actions", { proposal_ids: proposals, confirmed: true }), { code: "call_cancelled" });
  assert.equal(h.writes.length, 1);
});

test("register validates the check letter and posts flat demographics without booking", async () => {
  const h = harness({ patients: [] });
  const demographics = {
    given_name: "Ana", first_surname: "Prueba", second_surname: "Test", national_id: "12345678Z",
    date_of_birth: "1988-03-14", phone: "+34612345678", email: "ana@example.test", insurer: "mapfre",
  };
  await assert.rejects(h.execute("prepare_action", { request: {
    action: "REGISTER", new_patient: { ...demographics, national_id: "12345678A" },
  } }));
  const proposal = z.object({ proposal_id: z.string() }).parse(
    await h.execute("prepare_action", { request: { action: "REGISTER", new_patient: demographics } }),
  );
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", ...demographics, phone: "612345678" }]);
});

test("refusals require evidence; emergencies are explicit actions, never silence", async () => {
  const h = harness({ slots: [] });
  await assert.rejects(h.execute("report_outcome", { action: "NO_ACTION", reason: "referral_required" }));
  await identify(h);
  await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" });
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "no_availability" });
  assert.deepEqual(h.writes[0], { call_id: "real-call-from-start", reason: "no_availability" });
  const emergency = harness();
  await emergency.execute("report_outcome", { action: "ESCALATE", reason: "medical_emergency" });
  assert.deepEqual(emergency.writes[0], { call_id: "real-call-from-start", reason: "medical_emergency" });
});

test("a dropped acknowledgement retries the same body and treats duplicate 409 as accepted", async () => {
  const h = harness({ post: async (_body, attempt) => {
    if (attempt === 1) throw new TypeError("socket reset after server accepted");
    return new Response(null, { status: 409 });
  } });
  const proposal = await proposeBooking(h);
  h.nextTurn();
  const result = z.object({ status: z.string() }).parse(
    await h.execute("confirm_action", { proposal_id: proposal, confirmed: true }),
  );
  assert.equal(result.status, "duplicate");
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[0], h.writes[1]);
});

for (const responseDelay of [40_000, 61_000]) {
  test(`an open call's confirmed submission ${responseDelay === 40_000 ? "can finish after forty seconds" : "expires at sixty seconds without starting another attempt"}`, async (t) => {
    let requestSignal: AbortSignal | undefined;
    const h = harness({ post: async (_body, _attempt, init) => {
      assert.ok(init.signal);
      requestSignal = init.signal;
      await delay(responseDelay, undefined, { signal: init.signal });
      return new Response(null, { status: 409 });
    } });
    const proposal = await proposeBooking(h);
    h.nextTurn();
    const timeouts = mockSubmissionClock(t);
    const settled = Promise.allSettled([h.execute("confirm_action", { proposal_id: proposal, confirmed: true })]);
    await settle();
    t.mock.timers.tick(28_001);
    assert.equal(requestSignal?.aborted, false);
    t.mock.timers.tick(Math.min(responseDelay, 60_000) - 28_002);
    assert.equal(requestSignal?.aborted, false);
    t.mock.timers.tick(1);
    const [result] = await settled;
    if (responseDelay === 40_000) {
      assert.ok(result?.status === "fulfilled");
      assert.equal(z.object({ status: z.string() }).parse(result.value).status, "duplicate");
    } else {
      assert.ok(result?.status === "rejected");
      assert.equal(result.reason.code, "prosper_submission_unknown");
      assert.equal(requestSignal?.aborted, true);
    }
    assert.deepEqual(timeouts.mock.calls.map(({ arguments: args }) => args), [[60_000], [60_000]]);
    assert.equal(h.writes.length, 1);
    assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
    await h.engine.close();
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(h.writes.length, 1);
  });
}

for (const disconnected of [false, true]) for (const outcome of ["duplicate", "unknown"] as const) {
  test(`confirmed submissions share the ${disconnected ? "28-second close grace" : "60-second operation budget"} across an identical retry (${outcome})`, async (t) => {
    const posts: RequestInit[] = [];
    const firstDelay = disconnected ? 10_000 : 20_000;
    const retryDelay = outcome === "duplicate"
      ? disconnected ? 16_000 : 38_000
      : disconnected ? 18_000 : 40_000;
    const budget = disconnected ? 28_000 : 60_000;
    const h = harness({ post: async (_body, attempt, init) => {
      assert.ok(init.signal);
      posts.push(init);
      await delay(attempt === 1 ? firstDelay : retryDelay, undefined, { signal: init.signal });
      if (attempt === 1) throw new TypeError("Synthetic connection failure");
      return new Response(null, { status: 409 });
    } });
    const proposal = await proposeBooking(h);
    h.nextTurn();
    const timeouts = mockSubmissionClock(t);
    const submitting = h.execute("confirm_action", { proposal_id: proposal, confirmed: true });
    const settled = Promise.allSettled([submitting]);
    await settle();
    assert.equal(posts.length, 1);
    if (disconnected) h.controller.abort();
    const closing = disconnected ? h.engine.close() : undefined;
    let closed = false;
    void closing?.then(() => { closed = true; });
    assert.equal(posts[0]?.signal?.aborted, false);

    t.mock.timers.tick(firstDelay);
    await settle();
    t.mock.timers.tick(249);
    await settle();
    assert.equal(posts.length, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(posts.length, 2);
    assert.equal(posts[0]?.body, posts[1]?.body);
    assert.deepEqual(h.writes[0], h.writes[1]);
    assert.deepEqual(timeouts.mock.calls.map(({ arguments: args }) => args), [[60_000], [60_000], [60_000]]);

    t.mock.timers.tick(Math.min(retryDelay, budget - firstDelay - 250) - 1);
    await settle();
    assert.equal(closed, false);
    assert.equal(posts[1]?.signal?.aborted, false);
    t.mock.timers.tick(1);
    const [result] = await settled;
    await closing;
    if (outcome === "duplicate") {
      assert.ok(result?.status === "fulfilled");
      assert.equal(z.object({ status: z.string() }).parse(result.value).status, "duplicate");
      assert.equal(posts[1]?.signal?.aborted, false);
    } else {
      assert.ok(result?.status === "rejected");
      assert.equal(result.reason.code, "prosper_submission_unknown");
      assert.equal(posts[1]?.signal?.aborted, true);
    }
    assert.equal(closed, disconnected);
    assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
    await h.engine.close();
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(posts.length, 2);
  });
}

for (const closeAt of [20_000, 45_000]) for (const trigger of ["abort", "close"] as const) {
  test(`${trigger} at ${closeAt / 1000}s caps a pending write without resetting or extending either deadline`, async (t) => {
    let requestSignal: AbortSignal | undefined;
    const h = harness({ post: async (_body, _attempt, init) => {
      assert.ok(init.signal);
      requestSignal = init.signal;
      await delay(90_000, undefined, { signal: init.signal });
      return new Response(null, { status: 409 });
    } });
    const proposal = await proposeBooking(h);
    h.nextTurn();
    mockSubmissionClock(t);
    const settled = Promise.allSettled([h.execute("confirm_action", { proposal_id: proposal, confirmed: true })]);
    await settle();
    t.mock.timers.tick(closeAt);
    let closing: Promise<void> | undefined;
    if (trigger === "abort") h.controller.abort();
    else closing = h.engine.close();
    assert.equal(requestSignal?.aborted, false);
    t.mock.timers.tick(5_000);
    if (trigger === "close") h.controller.abort();
    closing ??= h.engine.close();
    const repeatedClose = h.engine.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    t.mock.timers.tick(Math.min(60_000, closeAt + 28_000) - closeAt - 5_001);
    await settle();
    assert.equal(requestSignal?.aborted, false);
    assert.equal(closed, false);
    t.mock.timers.tick(1);
    const [result] = await settled;
    assert.ok(result?.status === "rejected");
    assert.equal(result.reason.code, "prosper_submission_unknown");
    await Promise.all([closing, repeatedClose]);
    assert.equal(requestSignal?.aborted, true);
    assert.equal(closed, true);
    assert.equal(h.writes.length, 1);
    assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
  });
}

test("a closing call's grace cannot abort another call's forty-second confirmed write", async (t) => {
  const post = async (_body: Record<string, unknown>, _attempt: number, init: RequestInit) => {
    assert.ok(init.signal);
    await delay(40_000, undefined, { signal: init.signal });
    return new Response(null, { status: 409 });
  };
  const first = harness({ callId: "first-call", post });
  const second = harness({ callId: "second-call", post });
  const proposals = await Promise.all([proposeBooking(first), proposeBooking(second)]);
  first.nextTurn();
  second.nextTurn();
  mockSubmissionClock(t);
  const firstResult = Promise.allSettled([first.execute("confirm_action", { proposal_id: proposals[0], confirmed: true })]);
  const secondResult = Promise.allSettled([second.execute("confirm_action", { proposal_id: proposals[1], confirmed: true })]);
  await settle();
  first.controller.abort();
  const closing = first.engine.close();
  t.mock.timers.tick(28_000);
  assert.equal((await firstResult)[0]?.status, "rejected");
  await closing;
  assert.equal(second.controller.signal.aborted, false);
  t.mock.timers.tick(12_000);
  assert.equal((await secondResult)[0]?.status, "fulfilled");
  await second.engine.close();
  assert.equal(first.writes.length, 1);
  assert.equal(second.writes.length, 1);
});

test("410 and 422 fail explicitly, never report success, and are not retried", async () => {
  for (const status of [410, 422]) {
    const h = harness({ post: async () => new Response("private upstream details", { status }) });
    const proposal = await proposeBooking(h);
    h.nextTurn();
    await assert.rejects(h.execute("confirm_action", { proposal_id: proposal, confirmed: true }), {
      message: `prosper_http_${status}`,
    });
    assert.equal(h.writes.length, 1);
    assert.ok(!JSON.stringify(h.records).includes("private upstream details"));
  }
});

test("uncertain writes block replacement; diagnostics and unconfirmed disconnects send nothing", async () => {
  const uncertain = harness({ post: async () => { throw new TypeError("lost"); } });
  const proposal = await proposeBooking(uncertain);
  uncertain.nextTurn();
  await assert.rejects(uncertain.execute("confirm_action", { proposal_id: proposal, confirmed: true }));
  await assert.rejects(proposeBooking(uncertain));
  assert.equal(uncertain.writes.length, 2);

  const diagnostic = harness({ allowSubmissions: false });
  const diagnosticProposal = await proposeBooking(diagnostic);
  diagnostic.nextTurn();
  await assert.rejects(diagnostic.execute("confirm_action", { proposal_id: diagnosticProposal, confirmed: true }));
  assert.equal(diagnostic.writes.length, 0);
  const abandoned = harness();
  const abandonedProposal = await proposeBooking(abandoned);
  abandoned.nextTurn();
  abandoned.controller.abort();
  await abandoned.engine.close();
  await assert.rejects(abandoned.execute("confirm_action", {
    proposal_id: abandonedProposal, confirmed: true,
  }), { code: "call_cancelled" });
  assert.equal(abandoned.writes.length, 0);
});

test("simultaneous confirmed calls retain their own authoritative call ids", async () => {
  const harnesses = Array.from({ length: 10 }, (_, index) => harness({ callId: `call-${index}` }));
  await Promise.all(harnesses.map(async (h, index) => {
    const proposal = await proposeBooking(h);
    h.nextTurn();
    await Promise.all([
      h.execute("confirm_action", { proposal_id: proposal, confirmed: true }),
      h.execute("confirm_action", { proposal_id: proposal, confirmed: true }),
    ]);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]?.call_id, `call-${index}`);
  }));
});

test("function schemas are serializable and no model-provided call_id is accepted", async () => {
  assert.ok(JSON.stringify(receptionistTools).includes("confirm_action"));
  const h = harness();
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "out_of_scope", call_id: "forged",
  }));
  assert.equal(h.writes.length, 0);
});

test("case-folds action verbs from the voice model, but not patient or slot identifiers", async () => {
  const h = harness();
  await identify(h);
  const slots = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" }),
  );
  const args = { action: "book", patient_id: "PTEST", slot_id: slots.slots[0]?.slot_id, policy_id: "mapfre" };
  await assert.rejects(h.execute("prepare_action", { request: { ...args, patient_id: "ptest" } }));
  const proposed = z.object({ action: actionSchema }).parse(await h.execute("prepare_action", { request: args }));
  assert.equal(proposed.action.action, "BOOK");
});

test("two cancellations are distinct POSTs, both linked to the same real call", async () => {
  const h = harness({ appointments: [appointment, { ...appointment, appointment_id: "ATEST2" }] });
  await identify(h);
  await h.execute("list_appointments", { patient_id: "PTEST" });
  const ids: string[] = [];
  for (const id of ["ATEST", "ATEST2"]) {
    ids.push(z.object({ proposal_id: z.string() }).parse(
      await h.execute("prepare_action", { request: { action: "CANCEL", appointment_id: id } }),
    ).proposal_id);
  }
  h.nextTurn();
  for (const id of ids) await h.execute("confirm_action", { proposal_id: id, confirmed: true });
  assert.deepEqual(h.writes, [
    { call_id: "real-call-from-start", appointment_id: "ATEST" },
    { call_id: "real-call-from-start", appointment_id: "ATEST2" },
  ]);
});

test("a confirmed POST survives a caller disconnect; pending proposals are never auto-submitted", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const h = harness({ post: async () => { started.resolve(); return response.promise; } });
  const proposal = await proposeBooking(h);
  h.nextTurn();
  const submitting = h.execute("confirm_action", { proposal_id: proposal, confirmed: true });
  await started.promise;
  h.controller.abort();
  const closing = h.engine.close();
  response.resolve(new Response(null, { status: 409 }));
  const result = z.object({ status: z.string() }).parse(await submitting);
  await closing;
  assert.equal(result.status, "duplicate");
  assert.equal(h.writes.length, 1);
});

test("an interrupted old tool turn is rejected before invoking a clinic endpoint", async () => {
  const h = harness();
  h.nextTurn();
  await assert.rejects(h.engine.execute("find_patient", JSON.stringify({
    name: "Ana Prueba Test", national_id: "12345678Z",
  }), 1));
  assert.equal(h.requests.length, 0);
});

function rulesHarness(covered = false) {
  return harness({
    patients: [{ ...patient, insurer: covered ? "sanitas" : "adeslas" }],
    clinic: {
      ...clinic,
      providers: clinic.providers.map((provider) => ({ ...provider, id: "GYNTEST", name: "Test Gynaecologist", specialty_id: "gynaecology" })),
      specialties: [{ id: "gynaecology", name: "Gynaecology", min_age_months: 168, max_age_months: null, referral_required: false }],
    },
    availability: (query) => {
      const payable = covered || query.searchParams.getAll("insurer").includes("sanitas");
      return {
        providers: [{ id: "GYNTEST", name: "Test Gynaecologist", specialty_id: "gynaecology", languages: ["en", "es"] }],
        appointment_type: { id: "gynaecology_review", name: "Review", duration_minutes: 15, guidance: "For existing patients" },
        slots: payable ? [{
          ...slot, provider_id: "GYNTEST", provider_name: "Test Gynaecologist",
          specialty_id: "gynaecology", appointment_type_id: "gynaecology_review",
          payable_with: ["sanitas"],
        }] : [],
        blocked: payable ? [] : [{ provider_id: "GYNTEST", restriction: "specialty_not_covered" }],
      };
    },
  });
}

test("The Rules: single-plan coverage refusal produces an explicit NO_ACTION, not a missing record", async () => {
  const h = rulesHarness();
  await identify(h);
  const result = z.object({
    slots: z.array(z.unknown()),
    no_booking: z.object({
      tool: z.literal("report_outcome"),
      action: z.literal("NO_ACTION"),
      reason_candidates: z.array(z.string()),
      ask_other_policy: z.boolean(),
      submitted: z.literal(false),
    }),
    instruction: z.string(),
  }).parse(await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "gynaecology" }));
  assert.equal(result.slots.length, 0);
  assert.deepEqual(result.no_booking.reason_candidates, ["specialty_not_covered"]);
  assert.equal(result.no_booking.ask_other_policy, true);
  assert.match(result.instruction, /BEFORE your final refusal or goodbye/);
  assert.equal(h.writes.length, 0);
  await assert.rejects(
    h.execute("report_outcome", { action: "NO_ACTION", reason: "specialty_not_covered" }),
    (error: unknown) => error instanceof Error && error.message.includes("no_other_policy:true"),
  );
  assert.equal(h.writes.length, 0, "Do not refuse before checking a possible second policy");
  h.nextTurn();
  const receipt = z.object({ status: z.literal("accepted"), action: actionSchema }).parse(
    await h.execute("report_outcome", {
      action: "NO_ACTION", reason: "specialty_not_covered", no_other_policy: true,
    }),
  );
  assert.deepEqual(receipt.action, { action: "NO_ACTION", reason: "specialty_not_covered" });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", reason: "specialty_not_covered" }]);
  assert.ok(h.requests.some((url) => url.pathname === "/api/v1/submit/no-action"));
  assert.ok(!h.requests.some((url) => url.pathname === "/api/v1/submit/book"));
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "specialty_not_covered" });
  assert.equal(h.writes.length, 1, "Do not send another refusal when the caller says goodbye");
});

test("The Second Policy: a usable second plan clears obsolete refusal evidence and allows a booking", async () => {
  const h = rulesHarness();
  await identify(h);
  await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "gynaecology" });
  h.nextTurn();
  const result = z.object({
    slots: z.array(z.object({ slot_id: z.string() })),
    no_booking: z.null(),
  }).parse(await h.execute("search_availability", {
    patient_id: "PTEST", specialty_id: "gynaecology", additional_policy: "sanitas",
  }));
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "specialty_not_covered", no_other_policy: true,
  }), /Read the relevant clinic/);
  const proposal = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", {
    request: { action: "BOOK", patient_id: "PTEST", slot_id: result.slots[0]?.slot_id, policy_id: "sanitas" },
  }));
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.policy_id, "sanitas");
  assert.equal(h.writes[0]?.appointment_type_id, "gynaecology_review");
  assert.equal(h.writes[0]?.reason, undefined);
});

test("The Rules: an eligible control case must book, not refuse merely because of its label", async () => {
  const h = rulesHarness(true);
  await identify(h);
  const result = z.object({
    slots: z.array(z.object({ slot_id: z.string() })), no_booking: z.null(),
  }).parse(await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "gynaecology" }));
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "specialty_not_covered", no_other_policy: true,
  }));
  const proposal = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", {
    request: { action: "BOOK", patient_id: "PTEST", slot_id: result.slots[0]?.slot_id, policy_id: "sanitas" },
  }));
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes[0]?.policy_id, "sanitas");
  assert.equal(h.writes[0]?.reason, undefined);
});

test("The Rules: checking both held plans does not require asking for a third plan", async () => {
  const h = rulesHarness();
  await identify(h);
  const result = z.object({
    no_booking: z.object({ ask_other_policy: z.literal(false) }),
  }).parse(await h.execute("search_availability", {
    patient_id: "PTEST", specialty_id: "gynaecology", additional_policy: "mapfre",
  }));
  assert.equal(result.no_booking.ask_other_policy, false);
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "specialty_not_covered" });
  assert.deepEqual(h.writes[0], { call_id: "real-call-from-start", reason: "specialty_not_covered" });
});

test("The Rules: a disconnected or failed lookup never submits a guessed refusal", async () => {
  const h = rulesHarness();
  await identify(h);
  await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "gynaecology" });
  await assert.rejects(h.execute("search_availability", {
    patient_id: "PTEST", specialty_id: "not-in-catalogue",
  }));
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "specialty_not_covered", no_other_policy: true,
  }));
  h.controller.abort();
  await h.engine.close();
  assert.equal(h.writes.length, 0);
});

test("one blocked doctor cannot justify a refusal when the requested search offers an eligible slot", async () => {
  const h = harness({
    availability: () => ({
      providers: [
        { id: "PRTEST", name: "Available doctor", specialty_id: "general_practice", languages: ["en"] },
        { id: "BLOCKED", name: "Unavailable doctor", specialty_id: "general_practice", languages: ["en"] },
      ],
      appointment_type: { id: "review", name: "Review", duration_minutes: 15, guidance: "Existing patient" },
      slots: [slot],
      blocked: [{ provider_id: "BLOCKED", restriction: "provider_not_in_network" }],
    }),
  });
  await identify(h);
  await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" });
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "provider_not_in_network", no_other_policy: true,
  }));
  assert.equal(h.writes.length, 0);
});

test("refusal instructions require recording before goodbye and forbid invented private-payment fallbacks", () => {
  const instructions = receptionistInstructions(new Date("2026-09-18T18:00:00Z"), true);
  assert.match(instructions, /Speaking a refusal.*does NOT submit anything/);
  assert.match(instructions, /Complete report_outcome before your final explanation or goodbye/);
  assert.match(instructions, /Never offer or recommend private payment to bypass coverage/);
  assert.match(instructions, /no_other_policy:true/);
});

test("voice instructions allow restrained natural fillers without weakening critical readbacks", () => {
  const instructions = receptionistInstructions(new Date("2026-09-18T18:00:00Z"), true);
  assert.match(instructions, /very occasional brief acknowledgement or hesitation/);
  assert.match(instructions, /never during names, identifiers, dates, times, prices, consent, readbacks or action status/);
  assert.match(instructions, /Never repeat fillers, delay a tool call or sacrifice clarity/);
});

function offered(slots: Slot[], blocked: Availability["blocked"] = []): Availability {
  return {
    providers: [{ id: "PRTEST", name: "Test Doctor", specialty_id: "general_practice", languages: ["en", "es", "ca"] }],
    appointment_type: { id: "review", name: "Review", duration_minutes: 15, guidance: "Existing patient" },
    slots, blocked,
  };
}

test("When Exactly resolves spoken dates and requires agreement before moving a closed day", async () => {
  const h = harness({
    clinic: {
      ...clinic,
      locations: clinic.locations.map((location) => ({
        ...location, hours: [
          { weekday: "monday", intervals: ["09:00-17:00"] },
          { weekday: "tuesday", intervals: ["09:00-17:00"] },
        ],
      })),
    },
    availability: (query) => {
      const date = query.searchParams.get("date_from");
      return offered(date === "2026-10-13" ? [{ ...slot, start_time: "2026-10-13T09:00:00+02:00" }] : []);
    },
  });
  await identify(h);
  const closed = z.object({
    request_id: z.string(), slots: z.array(z.unknown()),
    no_booking: z.object({ closed_date: z.object({ nextOpenDate: z.string() }) }),
  }).parse(await h.execute("search_availability", {
    patient_id: "PTEST", specialty_id: "general_practice", location_id: "centro",
    date_phrase: "first thing on Monday the twelfth of October",
  }));
  assert.equal(closed.slots.length, 0);
  assert.equal(closed.no_booking.closed_date.nextOpenDate, "2026-10-13");
  assert.equal(h.writes.length, 0);
  h.nextTurn();
  const alternative = z.object({
    slots: z.array(z.object({ start_time: z.string() })), adjusted_from_closed_date: z.string(),
  }).parse(await h.execute("search_availability", {
    patient_id: "PTEST", request_id: closed.request_id, allow_next_open_day: true,
  }));
  assert.equal(alternative.adjusted_from_closed_date, "2026-10-12");
  assert.equal(alternative.slots[0]?.start_time, "2026-10-13T09:00:00+02:00");
});

test("No Slot Free preserves site/time constraints when searching an agreed later window", async () => {
  const h = harness({
    availability: (query) => offered(query.searchParams.get("date_from") === "2026-09-21"
      ? [{ ...slot, start_time: "2026-09-21T15:00:00+02:00" }] : []),
  });
  await identify(h);
  const first = z.object({ request_id: z.string() }).parse(await h.execute("search_availability", {
    patient_id: "PTEST", specialty_id: "general_practice", location_id: "centro",
    date_from: "2026-09-19", date_to: "2026-09-19", time_of_day: "afternoon",
  }));
  h.nextTurn();
  const alternative = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await h.execute("search_availability", {
      patient_id: "PTEST", request_id: first.request_id, date_from: "2026-09-21", date_to: "2026-09-21",
    }),
  );
  const query = h.requests.filter((url) => url.pathname.endsWith("/availability")).at(-1);
  assert.equal(query?.searchParams.get("location_id"), "centro");
  assert.equal(query?.searchParams.get("specialty_id"), "general_practice");
  assert.equal(alternative.slots.length, 1);
});

test("No Slot Free keeps explicit replacement constraints when the caller also relaxes the old ones", async () => {
  const replacement = {
    ...slot, provider_id: "PRALTERNATIVE", provider_name: "Alternative Doctor", location_id: "alternative",
    start_time: "2026-10-05T15:00:00+02:00",
  };
  const providers = [
    { ...clinic.providers[0]!, languages: ["en"] },
    { ...clinic.providers[0]!, id: replacement.provider_id, name: replacement.provider_name, languages: ["ca"],
      schedules: [{ location_id: "alternative", location_name: "Alternative", days: [
        { weekday: "monday", intervals: ["09:00-18:00"] },
      ] }] },
  ];
  const h = harness({
    clinic: {
      ...clinic, providers,
      locations: [...clinic.locations, { ...clinic.locations[0]!, id: "alternative", name: "Alternative" }],
    },
    availability: (query) => ({
      ...offered(query.searchParams.get("date_from") === "2026-10-03" ? [] : [
        slot,
        { ...replacement, start_time: "2026-10-05T09:30:00+02:00" },
        { ...replacement, provider_id: slot.provider_id, location_id: slot.location_id,
          start_time: "2026-10-05T14:00:00+02:00" },
        replacement,
      ]),
      providers,
    }),
  });
  await identify(h);
  const empty = await searchBooking(h, {
    provider_id: slot.provider_id, location_id: slot.location_id,
    date_from: "2026-10-03", date_to: "2026-10-03",
    time_of_day: "morning", weekday: "saturday", language: "en",
  });
  assert.equal(empty.slots.length, 0);
  h.nextTurn();
  const changed = await searchBooking(h, {
    request_id: empty.request_id,
    provider_id: replacement.provider_id, location_id: replacement.location_id,
    date_from: "2026-10-05", date_to: "2026-10-05",
    time_of_day: "afternoon", weekday: "monday", language: "ca",
    relax_constraints: ["provider", "location", "date", "time", "weekday", "language"],
  });
  const query = h.requests.findLast((url) => url.pathname.endsWith("/availability"));
  assert.equal(query?.searchParams.get("provider_id"), replacement.provider_id);
  assert.equal(query?.searchParams.get("location_id"), replacement.location_id);
  assert.equal(query?.searchParams.get("date_from"), "2026-10-05");
  assert.equal(query?.searchParams.get("date_to"), "2026-10-05");
  assert.deepEqual(changed.slots.map((value) => value.start_time), [replacement.start_time]);
  assert.ok(changed.booking_proposal);
  assert.equal(h.writes.length, 0);
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: changed.booking_proposal.proposal_id, confirmed: true,
  }), { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: changed.booking_proposal.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{
    call_id: "real-call-from-start", patient_id: patient.patient_id, provider_id: replacement.provider_id,
    location_id: replacement.location_id, appointment_type_id: replacement.appointment_type_id,
    slot: replacement.start_time, policy_id: patient.insurer,
  }]);
});

test("No Slot Free honors a replacement date phrase but can remove an old date when no replacement is supplied", async () => {
  const alternative = { ...slot, start_time: "2026-10-05T11:00:00+02:00" };
  for (const datePhrase of [undefined, "Monday October 5, 2026"]) {
    const h = harness({ slots: [slot, alternative] });
    await identify(h);
    const empty = await searchBooking(h, {
      provider_id: slot.provider_id, location_id: slot.location_id,
      date_from: "2026-10-03", date_to: "2026-10-03", time_of_day: "morning",
    });
    assert.equal(empty.slots.length, 0);
    h.nextTurn();
    const changed = await searchBooking(h, {
      request_id: empty.request_id, relax_constraints: ["date"],
      ...(datePhrase ? { date_phrase: datePhrase } : {}),
    });
    assert.equal(changed.slots[0]?.start_time, datePhrase ? alternative.start_time : slot.start_time);
    const query = h.requests.findLast((url) => url.pathname.endsWith("/availability"));
    assert.equal(query?.searchParams.get("provider_id"), slot.provider_id);
    assert.equal(query?.searchParams.get("location_id"), slot.location_id);
    assert.equal(h.writes.length, 0);
  }
});

test("No Slot Free supplies a caller-approved broader-window search without dropping site, day, time or language", async () => {
  const alternative = { ...slot, start_time: "2026-09-28T15:00:00+02:00" };
  const h = harness({ availability: () => offered([
    { ...alternative, start_time: "2026-09-28T09:00:00+02:00" }, alternative,
  ]) });
  await identify(h);
  const empty = z.object({
    request_id: z.string(), instruction: z.string(),
    no_booking: z.object({
      calendar_status: z.literal("no_slots_in_requested_window"),
      ask_other_policy: z.literal(false),
      next_window_search: z.object({
        patient_id: z.string(), request_id: z.string(),
        date_from: z.string(), date_to: z.string(), prepare_booking: z.literal(true),
      }),
    }),
  }).parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id, prepare_booking: true,
    provider_id: slot.provider_id, location_id: slot.location_id,
    date_from: "2026-09-21", date_to: "2026-09-21",
    weekday: "monday", time_of_day: "afternoon", language: "ca",
  }));
  assert.match(empty.instruction, /Only after permission/);
  assert.match(empty.instruction, /Do not add a booking-style confirmation/);
  assert.deepEqual(empty.no_booking.next_window_search, {
    patient_id: patient.patient_id, request_id: empty.request_id,
    date_from: "2026-09-22", date_to: clinic.calendar.ends, prepare_booking: true,
  });
  assert.equal(h.writes.length, 0);
  h.nextTurn();
  const later = await searchBooking(h, empty.no_booking.next_window_search);
  assert.deepEqual(later.slots.map((value) => value.start_time), [alternative.start_time]);
  assert.ok(later.booking_proposal);
  const query = h.requests.findLast((url) => url.pathname.endsWith("/availability"));
  assert.equal(query?.searchParams.get("provider_id"), slot.provider_id);
  assert.equal(query?.searchParams.get("location_id"), slot.location_id);
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "no_availability", request_id: empty.request_id,
  }), { code: "outcome_requires_evidence" }, "A found alternative must not reuse the earlier empty-window reason");
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: later.booking_proposal.proposal_id, confirmed: true,
  }), { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: later.booking_proposal.proposal_id, confirmed: true });
  assert.equal(h.writes[0]?.slot, alternative.start_time);
});

test("No Slot Free guidance does not relabel eligibility, closure or anchored rescheduling as a full calendar", async () => {
  const cases = [
    { h: harness({ availability: () => offered([], [{ provider_id: slot.provider_id, restriction: "specialty_not_covered" }]) }),
      input: { date_from: "2026-09-21", date_to: "2026-09-21" }, reason: "specialty_not_covered" },
    { h: harness({ slots: [] }),
      input: { date_from: "2026-10-12", date_to: "2026-10-12" }, reason: "clinic_closed" },
  ];
  for (const { h, input, reason } of cases) {
    await identify(h);
    const result = z.object({ no_booking: z.record(z.string(), z.unknown()) }).parse(
      await h.execute("search_availability", {
        patient_id: patient.patient_id, specialty_id: slot.specialty_id, location_id: slot.location_id, ...input,
      }),
    );
    assert.deepEqual(result.no_booking.reason_candidates, [reason]);
    assert.equal(result.no_booking.calendar_status, undefined);
    assert.equal(result.no_booking.next_window_search, undefined);
  }
  const moving = harness({ appointments: [laterAppointment], slots: [] });
  await identify(moving);
  await moving.execute("list_appointments", { patient_id: patient.patient_id });
  const result = z.object({ no_booking: z.record(z.string(), z.unknown()) }).parse(
    await moving.execute("search_availability", {
      patient_id: patient.patient_id, after_appointment_id: laterAppointment.appointment_id,
    }),
  );
  assert.equal(result.no_booking.calendar_status, undefined);
  assert.equal(result.no_booking.next_window_search, undefined);
});

test("No Slot Free never suggests a later window beyond the clinic calendar", async () => {
  const h = harness({ slots: [] });
  await identify(h);
  const result = z.object({ no_booking: z.record(z.string(), z.unknown()) }).parse(
    await h.execute("search_availability", { patient_id: patient.patient_id, specialty_id: slot.specialty_id }),
  );
  assert.equal(result.no_booking.calendar_status, "no_slots_in_requested_window");
  assert.equal(result.no_booking.next_window_search, undefined);
  assert.equal(h.writes.length, 0);
});

test("No Slot Free distinguishes an empty window from coverage and needs new consent for an allowed alternative", async () => {
  const alternative = { ...slot, start_time: "2026-10-05T09:30:00+02:00" };
  const h = harness({ slots: [alternative, { ...alternative, start_time: "2026-10-05T15:30:00+02:00" }] });
  await identify(h);
  const empty = await searchBooking(h, {
    provider_id: slot.provider_id, location_id: slot.location_id,
    date_from: "2026-10-03", date_to: "2026-10-03", time_of_day: "morning",
  });
  assert.deepEqual(empty.no_booking?.reason_candidates, ["no_availability"]);
  assert.equal(empty.booking_proposal, null);
  assert.equal(h.writes.length, 0);
  h.nextTurn();
  const revised = await searchBooking(h, {
    request_id: empty.request_id, date_from: "2026-10-05", date_to: "2026-10-05",
  });
  assert.deepEqual(revised.slots.map((value) => value.start_time), [alternative.start_time]);
  const query = h.requests.findLast((url) => url.pathname.endsWith("/availability"));
  assert.equal(query?.searchParams.get("provider_id"), slot.provider_id);
  assert.equal(query?.searchParams.get("location_id"), slot.location_id);
  assert.ok(revised.booking_proposal);
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: revised.booking_proposal.proposal_id, confirmed: true,
  }), { code: "confirmation_requires_new_turn" }, "Agreement to check another day is not consent to its new offer");
  h.controller.abort();
  await h.engine.close();
  assert.equal(h.writes.length, 0, "Neither the deadline nor hang-up confirms the revised offer");
});

test("No Slot Free records a declined window change using current no_availability evidence without extra consent", async () => {
  let current = 1;
  const gate = new ConfirmationGate(() => current, new AbortController().signal);
  const h = harness({
    slots: [],
    beforeOutcome: (turn, reason, context) => gate.reviewOutcome(turn, reason, context),
  });
  await identify(h);
  const empty = await searchBooking(h, {
    provider_id: slot.provider_id, location_id: slot.location_id,
    date_from: "2026-10-03", date_to: "2026-10-03", time_of_day: "morning",
  });
  assert.deepEqual(empty.no_booking?.reason_candidates, ["no_availability"]);
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "specialty_not_covered", request_id: empty.request_id, no_other_policy: true,
  }), { code: "outcome_requires_evidence" });
  h.nextTurn(); current += 1;
  gate.observe(current, "No, only that day works. I do not want another date or another site.");
  await h.execute("report_outcome", {
    action: "NO_ACTION", reason: "no_availability", request_id: empty.request_id,
  });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", reason: "no_availability" }]);
  assert.equal(h.requests.filter((url) => url.pathname.endsWith("/availability")).length, 1);
});

for (const action of ["BOOK", "RESCHEDULE"] as const) {
  test(`a late explicit ${action} approval starts its POST before close and finishes within existing grace`, async (t) => {
    let current = 1;
    let elapsed = 0;
    let postedAt: number | undefined;
    const startedAt = new Date("2026-09-18T18:00:00Z");
    t.mock.method(Date, "now", () => startedAt.getTime() + elapsed);
    const gate = new ConfirmationGate(() => current, new AbortController().signal);
    const postStarted = Promise.withResolvers<void>();
    const firstSlot = action === "BOOK" ? slot : laterSlot;
    const secondSlot = { ...firstSlot, start_time: action === "BOOK"
      ? "2026-09-19T12:15:00+02:00" : "2026-10-03T10:45:00+02:00" };
    const h = harness({
      startedAt, appointments: [laterAppointment], slots: [firstSlot, secondSlot],
      beforeConfirmation: (turn) => gate.review(turn),
      post: async (body, _attempt, init) => {
        assert.ok(init.signal);
        postedAt = elapsed;
        postStarted.resolve();
        await delay(9000, undefined, { signal: init.signal });
        const { call_id, ...fields } = body;
        return Response.json({
          call_id, received_at: new Date(Date.now()).toISOString(),
          record: { actions: [{ action, ...fields }] },
        });
      },
    });
    await identify(h);
    let firstProposal: string;
    let selectedSlotId: string;
    if (action === "BOOK") {
      const result = await searchBooking(h);
      assert.ok(result.booking_proposal);
      firstProposal = result.booking_proposal.proposal_id;
      selectedSlotId = result.slots[1]!.slot_id;
    } else {
      await h.execute("list_appointments", { patient_id: patient.patient_id });
      const result = await searchLater(h);
      assert.ok(result.reschedule.prepare_action);
      firstProposal = z.object({ proposal_id: z.string() }).parse(
        await h.execute("prepare_action", result.reschedule.prepare_action),
      ).proposal_id;
      selectedSlotId = result.slots[1]!.slot_id;
    }
    h.nextTurn(); current += 1;
    const request = action === "BOOK"
      ? { action, patient_id: patient.patient_id, slot_id: selectedSlotId, policy_id: patient.insurer }
      : { action, appointment_id: laterAppointment.appointment_id, slot_id: selectedSlotId, policy_id: patient.insurer };
    const finalProposal = z.object({ proposal_id: z.string(), instruction: z.string() }).parse(
      await h.execute("prepare_action", { request }),
    );
    assert.match(finalProposal.instruction, /confirm_action before.*(?:explanation|question)/);
    await assert.rejects(h.execute("confirm_action", { proposal_id: firstProposal, confirmed: true }),
      { code: "proposal_not_found" });
    await assert.rejects(h.execute("confirm_action", { proposal_id: finalProposal.proposal_id, confirmed: true }),
      { code: "confirmation_requires_new_turn" });
    assert.equal(h.writes.length, 0);
    h.nextTurn(); current += 1;
    elapsed = 174_700;
    mockSubmissionClock(t);
    t.mock.method(performance, "now", () => elapsed);
    gate.observe(current, action === "BOOK" ? "Yes, please book that appointment." : "Yes, please move my appointment to that time.");
    const requestsBefore = h.requests.length;
    const submitting = h.execute("confirm_action", { proposal_id: finalProposal.proposal_id, confirmed: true });
    await settle();
    elapsed = 175_199;
    t.mock.timers.tick(499);
    await settle();
    assert.equal(h.writes.length, 0, "The existing completed-turn stability guard must still run");
    elapsed = 175_200;
    t.mock.timers.tick(1);
    await postStarted.promise;
    assert.equal(postedAt, 175_200);
    assert.equal(h.requests.length, requestsBefore + 1, "Only the POST follows consent, not another lookup/preparation");
    assert.equal(h.writes.length, 1);
    elapsed = 180_000;
    t.mock.timers.tick(4800);
    await settle();
    h.controller.abort();
    const closing = h.engine.close();
    elapsed = 184_200;
    t.mock.timers.tick(4200);
    const receipt = z.object({ status: z.literal("accepted") }).parse(await submitting);
    await closing;
    assert.equal(receipt.status, "accepted");
    assert.deepEqual(h.writes, [{
      call_id: "real-call-from-start",
      ...(action === "BOOK" ? { patient_id: patient.patient_id, appointment_type_id: secondSlot.appointment_type_id }
        : { appointment_id: laterAppointment.appointment_id }),
      provider_id: secondSlot.provider_id, location_id: secondSlot.location_id,
      slot: secondSlot.start_time, policy_id: patient.insurer,
    }]);
  });
}

test("The Third Party keeps caller and patient charts independent and books only the requested patient", async () => {
  const other: Patient = { ...patient, patient_id: "POTHER", given_name: "Bea", national_id: "00000000T", phone: "699999999" };
  const h = harness({
    directory: (query) => [query.searchParams.get("national_id") === other.national_id ? other : patient],
    availability: () => offered([slot]),
  });
  await identify(h);
  const found = z.object({ matches: z.array(z.object({ verified: z.boolean() })) }).parse(await h.execute("find_patient", {
    name: "Bea Prueba Test", national_id: other.national_id,
  }));
  assert.equal(found.matches[0]?.verified, true);
  const result = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(await h.execute("search_availability", {
    patient_id: "POTHER", specialty_id: "general_practice",
  }));
  const proposal = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: "POTHER", slot_id: result.slots[0]?.slot_id, policy_id: "mapfre",
  } }));
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes[0]?.patient_id, "POTHER");
});

test("The Real Call prepares two patient intents without one search invalidating the other's draft", async () => {
  const other: Patient = { ...patient, patient_id: "POTHER", given_name: "Bea", national_id: "00000000T" };
  const h = harness({
    directory: (query) => [query.searchParams.get("national_id") === other.national_id ? other : patient],
    availability: () => offered([slot]),
  });
  const first = await proposeBooking(h);
  await h.execute("find_patient", { name: "Bea Prueba Test", national_id: other.national_id });
  const choices = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(await h.execute("search_availability", {
    patient_id: "POTHER", specialty_id: "general_practice",
  }));
  const second = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: "POTHER", slot_id: choices.slots[0]?.slot_id, policy_id: "mapfre",
  } }));
  h.nextTurn();
  await h.execute("confirm_actions", { proposal_ids: [first, second.proposal_id], confirmed: true });
  assert.deepEqual(h.writes.map((body) => body.patient_id), ["PTEST", "POTHER"]);
});

test("a multi-action confirmation rejects a stale member before sending any of the group", async () => {
  const h = harness();
  const first = await proposeBooking(h);
  h.nextTurn();
  await assert.rejects(h.execute("confirm_actions", { proposal_ids: [first, "missing-proposal"], confirmed: true }));
  assert.equal(h.writes.length, 0);
});

test("Difficult Caller corrections invalidate unsubmitted slots and force a fresh proposal", async () => {
  const h = harness();
  const first = await proposeBooking(h);
  const state = z.object({ requests: z.array(z.object({ request_id: z.string() })) }).parse(
    await h.execute("get_call_state", {}),
  );
  h.nextTurn();
  await h.execute("revise_request", { request_id: state.requests[0]?.request_id });
  await assert.rejects(h.execute("confirm_action", { proposal_id: first, confirmed: true }));
  assert.equal(h.writes.length, 0);
});

test("a corrected identity revokes unconfirmed drafts instead of booking the stale patient", async () => {
  const h = harness();
  const first = await proposeBooking(h);
  h.nextTurn();
  await h.execute("find_patient", { replaces_patient_id: "PTEST", name: "Ana Prueba Test", national_id: "00000000T" });
  await assert.rejects(h.execute("confirm_action", { proposal_id: first, confirmed: true }));
  await assert.rejects(h.execute("list_appointments", { patient_id: "PTEST" }));
  assert.equal(h.writes.length, 0);
});

test("Languages applies the requested Catalan provider constraint, not the conversation's default language", async () => {
  const h = harness({
    availability: () => ({
      ...offered([]),
      providers: [
        { id: "PRTEST", name: "Spanish doctor", specialty_id: "general_practice", languages: ["es"] },
        { id: "PCAT", name: "Catalan doctor", specialty_id: "general_practice", languages: ["ca", "es"] },
      ],
      slots: [slot, { ...slot, provider_id: "PCAT", provider_name: "Catalan doctor" }],
    }),
  });
  await identify(h);
  const result = z.object({ slots: z.array(z.object({ provider_id: z.string() })) }).parse(
    await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice", language: "ca" }),
  );
  assert.deepEqual(result.slots.map((value) => value.provider_id), ["PCAT"]);
});

test("Adversarial: lookup and call state never expose stored DNI or phone even inside chart notes", async () => {
  const h = harness({ patients: [{ ...patient, note: `Useful context. ID ${patient.national_id}; phone 612 345 678.` }] });
  const found = await h.execute("find_patient", { name: "Ana Prueba Test", national_id: patient.national_id });
  const state = await h.execute("get_call_state", {});
  const serialized = JSON.stringify([found, state]);
  assert.ok(!serialized.includes(patient.national_id));
  assert.ok(!serialized.includes("612 345 678"));
  assert.ok(!serialized.includes(patient.phone));
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "out_of_scope" });
  assert.deepEqual(h.writes[0], { call_id: "real-call-from-start", reason: "out_of_scope" });
});

test("privacy-only requests cannot submit caller_not_authorised before the correct out_of_scope refusal", async () => {
  const gate = new ConfirmationGate(() => 1, new AbortController().signal);
  const h = harness({ beforeOutcome: (turn, reason, context) => gate.reviewOutcome(turn, reason, context) });
  gate.observe(1, "Can you tell me which clinician my neighbour is seeing next? I do not have her identifiers.");
  await assert.rejects(h.execute("report_outcome", { action: "NO_ACTION", reason: "caller_not_authorised" }), {
    code: "privacy_outcome_requires_out_of_scope",
  });
  assert.equal(h.writes.length, 0);
  assert.equal(h.requests.length, 0);
  const result = await h.execute("report_outcome", { action: "NO_ACTION", reason: "out_of_scope" });
  assert.equal(z.object({ status: z.literal("accepted") }).parse(result).status, "accepted");
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "out_of_scope" });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", reason: "out_of_scope" }]);
  assert.deepEqual(h.requests.map((url) => url.pathname), ["/api/v1/submit/no-action"]);
});

test("privacy refusal guidance is shared by the runtime prompt and the reason schema", () => {
  const tool = receptionistTools.find((tool) => tool.name === "report_outcome")!;
  const parameters = z.object({
    properties: z.object({ reason: z.object({ description: z.string() }) }),
  }).parse(tool.parameters);
  assert.equal(parameters.properties.reason.description, privacyRefusalGuidance);
  assert.ok(receptionistInstructions(new Date("2026-09-19T12:00:00Z"), true).includes(privacyRefusalGuidance));
});

test("privacy review never rewrites an already accepted authorization refusal", async () => {
  let turn = 1;
  const gate = new ConfirmationGate(() => turn, new AbortController().signal);
  const h = harness({ beforeOutcome: (turn, reason, context) => gate.reviewOutcome(turn, reason, context) });
  gate.observe(1, "I want to cancel my mother's appointment, but she has not given me permission.");
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "caller_not_authorised" });
  h.nextTurn();
  turn = 2;
  gate.observe(2, "Can you read the phone number you have on file for her?");
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "caller_not_authorised" });
  await assert.rejects(h.execute("report_outcome", { action: "NO_ACTION", reason: "out_of_scope" }), {
    code: "outcome_already_submitted",
  });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", reason: "caller_not_authorised" }]);
});

test("an accepted cancellation is not polluted by an out-of-scope farewell after a declined offer", async () => {
  let turn = 1;
  const gate = new ConfirmationGate(() => turn, new AbortController().signal);
  const h = harness({
    beforeConfirmation: (turn) => gate.review(turn),
    beforeOutcome: (turn, reason, context) => gate.reviewOutcome(turn, reason, context),
  });
  await identify(h);
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const proposal = z.object({ proposal_id: z.string() }).parse(
    await h.execute("prepare_action", { request: { action: "CANCEL", appointment_id: appointment.appointment_id } }),
  );
  h.nextTurn();
  turn = 2;
  gate.observe(2, "Yes, please cancel that appointment.");
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  h.nextTurn();
  turn = 3;
  const availability = z.object({ request_id: z.string() }).parse(
    await h.execute("search_availability", { patient_id: patient.patient_id, specialty_id: "general_practice" }),
  );
  gate.observe(3, "I'll leave it for now, thanks.");
  await assert.rejects(h.execute("report_outcome", {
    action: "NO_ACTION", reason: "out_of_scope", request_id: availability.request_id,
  }), { code: "outcome_reason_not_supported" });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", appointment_id: appointment.appointment_id }]);
  assert.deepEqual(h.requests.filter((url) => url.pathname.startsWith("/api/v1/submit/")).map((url) => url.pathname),
    ["/api/v1/submit/cancel"]);
});

test("Nearest Site skips a closer site that cannot serve the request and uses the next viable one", async () => {
  const h = harness({
    clinic: {
      ...clinic,
      locations: [
        ...clinic.locations.map((site) => ({ ...site, id: "closest", latitude: 40.4, longitude: -3.7 })),
        ...clinic.locations.map((site) => ({ ...site, id: "next", latitude: 40.5, longitude: -3.7 })),
        ...clinic.locations.map((site) => ({ ...site, id: "far", latitude: 40.8, longitude: -3.7 })),
      ],
    },
    addressResolver: { async resolve() {
      return { source: "cartociudad", status: "resolved", truncated: false, candidates: [
        { id: "test", label: "Synthetic public street", kind: "portal", latitude: 40.4, longitude: -3.7 },
      ] };
    } },
    availability: (query) => query.searchParams.get("location_id") === "closest"
      ? offered([], [{ provider_id: "PRTEST", restriction: "type_not_offered" }])
      : offered([{ ...slot, location_id: query.searchParams.get("location_id") ?? "invalid" }]),
  });
  await identify(h);
  const origin = z.object({ origin_id: z.string() }).parse(await h.execute("locate_origin", {
    address: "Synthetic public street 10, Madrid",
  }));
  const result = z.object({ slots: z.array(z.object({ location_id: z.string() })) }).parse(
    await h.execute("search_availability", {
      patient_id: "PTEST", specialty_id: "general_practice", nearest_origin_id: origin.origin_id,
    }),
  );
  assert.equal(result.slots[0]?.location_id, "next");
  assert.ok(!h.requests.some((url) => url.searchParams.get("location_id") === "far"));
});

test("origin selection arguments preserve the original query and distinguish edited addresses from missing candidates", async () => {
  const queries: string[] = [];
  const h = harness({ addressResolver: { async resolve(address) {
    queries.push(address);
    return { source: "cartociudad", status: "needs_clarification", reason: "ambiguous", truncated: true,
      candidates: [syntheticOriginCandidate, {
        ...syntheticOriginCandidate, id: "synthetic-other", label: "CALLE DEL EJEMPLO 14, Madrid",
      }] };
  } } });
  const result = originCandidatesSchema.parse(await h.execute("locate_origin", { address: syntheticOriginAddress }));
  const selected = result.candidates[0]!;
  assert.deepEqual(selected.selection_arguments, {
    address: syntheticOriginAddress, candidate_id: selected.candidate_id,
  });
  assert.notEqual(selected.label, syntheticOriginAddress);
  assert.equal(result.reason, "ambiguous");
  assert.equal(result.truncated, true);
  assert.match(result.instruction, /selection_arguments.*unchanged/i);
  assert.deepEqual(h.records.at(-1), {
    type: "tool", name: "locate_origin", status: "ok",
    details: { origin_resolved: false, candidate_count: 2, candidates_truncated: true },
  });
  await assert.rejects(h.execute("locate_origin", {
    ...selected.selection_arguments, address: selected.label,
  }), { code: "address_candidate_address_mismatch", message: /selection_arguments.*omit candidate_id/i });
  assert.deepEqual(z.object({ details: z.unknown() }).parse(h.records.at(-1)).details, {
    candidate_supplied: true, candidate_available: true, address_matches_candidate: false, candidate_count: 2,
  });
  const origin = z.object({ origin_id: z.string() }).parse(
    await h.execute("locate_origin", selected.selection_arguments),
  );
  assert.ok(origin.origin_id);
  assert.deepEqual(h.records.at(-1), {
    type: "tool", name: "locate_origin", status: "ok",
    details: { origin_resolved: true, candidate_count: 1, candidates_truncated: false },
  });
  for (const candidate_id of [selected.candidate_id, "address-never-issued"]) {
    await assert.rejects(h.execute("locate_origin", { address: syntheticOriginAddress, candidate_id }), {
      code: "address_candidate_not_found", message: /omit candidate_id.*fresh candidates/i,
    });
    assert.deepEqual(z.object({ details: z.unknown() }).parse(h.records.at(-1)).details, {
      candidate_supplied: true, candidate_available: false, address_matches_candidate: false, candidate_count: 0,
    });
  }
  assert.deepEqual(queries, [syntheticOriginAddress]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 0);
  for (const value of [syntheticOriginAddress, selected.label, selected.candidate_id, origin.origin_id]) {
    assert.ok(!JSON.stringify(h.records).includes(value));
  }
});

test("origin selection cannot reuse an earlier shortlist after the public address is corrected", async () => {
  const h = harness({ addressResolver: { async resolve() {
    return { source: "cartociudad", status: "needs_clarification", reason: "address_mismatch",
      truncated: false, candidates: [syntheticOriginCandidate] };
  } } });
  const first = originCandidatesSchema.parse(await h.execute("locate_origin", { address: syntheticOriginAddress }));
  const oldSelection = first.candidates[0]!.selection_arguments;
  const correctedAddress = "Calle del Segundo Ejemplo 8, Madrid";
  await assert.rejects(h.execute("locate_origin", { ...oldSelection, address: correctedAddress }),
    { code: "address_candidate_address_mismatch" });
  const corrected = originCandidatesSchema.parse(await h.execute("locate_origin", { address: correctedAddress }));
  await assert.rejects(h.execute("locate_origin", oldSelection), { code: "address_candidate_not_found" });
  assert.deepEqual(z.object({ details: z.unknown() }).parse(h.records.at(-1)).details, {
    candidate_supplied: true, candidate_available: false, address_matches_candidate: false, candidate_count: 1,
  });
  const current = corrected.candidates[0]!.selection_arguments;
  assert.equal(current.address, correctedAddress);
  assert.notEqual(current.candidate_id, oldSelection.candidate_id);
  await h.execute("locate_origin", current);
  assert.equal(h.writes.length, 0);
});

test("address validation errors distinguish local formatting from an unavailable or nonexistent location", async () => {
  const h = harness({ addressResolver: {
    async resolve() { throw new AppError("invalid_public_address"); },
  } });
  await assert.rejects(h.execute("locate_origin", { address: syntheticOriginAddress }), {
    code: "invalid_public_address",
    message: /No geocoder request was made.*not proof that the street does not exist/,
  });
  assert.equal(h.writes.length, 0);
});

test("an unmatched origin never offers a different street or portal as a substitute", async () => {
  const h = harness({ addressResolver: {
    async resolve() {
      return { source: "cartociudad", status: "needs_clarification", reason: "address_mismatch",
        truncated: true, candidates: [] };
    },
  } });
  const result = z.object({ candidates: z.array(z.unknown()), instruction: z.string() })
    .parse(await h.execute("locate_origin", { address: syntheticOriginAddress }));
  assert.equal(result.candidates.length, 0);
  assert.match(result.instruction, /Do not suggest a different street or portal/);
  assert.match(result.instruction, /do not claim a closest site/);
  assert.equal(h.writes.length, 0);
});
test("origin error diagnostics contain only selection booleans and counts, never raw query or argument values", async () => {
  const h = harness({ addressResolver: { async resolve() {
    throw new AppError("geocoder_timeout", "UPSTREAM_PRIVATE_SENTINEL");
  } } });
  await assert.rejects(h.execute("locate_origin", { address: syntheticOriginAddress }), {
    code: "geocoder_timeout", message: /temporarily unavailable/,
  });
  assert.deepEqual(z.object({ details: z.unknown() }).parse(h.records.at(-1)).details, {
    candidate_supplied: false, candidate_available: false, address_matches_candidate: false, candidate_count: 0,
  });
  for (const args of [
    '{"BROKEN_JSON_SENTINEL"', "null", '["ARRAY_SENTINEL"]',
    JSON.stringify({ address: { name: "OBJECT_SENTINEL" }, candidate_id: 1 }),
    JSON.stringify({
      address: "ADDRESS_SENTINEL", candidate_id: "CANDIDATE_SENTINEL",
      name: "NAME_SENTINEL", national_id: "NATIONAL_ID_SENTINEL", phone: "PHONE_SENTINEL",
    }),
  ]) {
    await assert.rejects(h.engine.execute("locate_origin", args, 1), { code: "invalid_tool_arguments" });
    const { validation_issues, ...diagnostics } = z.object({
      details: z.object({ validation_issues: z.array(z.unknown()) }).passthrough(),
    }).parse(h.records.at(-1)).details;
    assert.ok(validation_issues.length);
    assert.ok(Object.values(diagnostics).every((value) => typeof value === "boolean" || typeof value === "number"));
  }
  assert.ok(!JSON.stringify(h.records).includes("SENTINEL"));
  assert.ok(!JSON.stringify(h.records).includes(syntheticOriginAddress));
  assert.equal(h.writes.length, 0);
});

test("nearest BOOK continuation supplies a fresh preparation after invalidating the old offer, never old consent", async () => {
  const h = harness({ addressResolver: syntheticOriginResolver });
  await identify(h);
  const first = await searchBooking(h);
  assert.ok(first.booking_proposal);
  h.nextTurn();
  const origin = z.object({ origin_id: z.string() }).parse(
    await h.execute("locate_origin", { address: syntheticOriginAddress }),
  );
  const nearest = nearestBookingSearchSchema.parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, request_id: first.request_id, nearest_origin_id: origin.origin_id,
  }));
  assert.equal(nearest.booking_proposal, null);
  assert.ok(nearest.booking_continuation?.previous_offer_invalidated);
  const preparation = nearest.booking_continuation.prepare_action;
  assert.deepEqual(preparation, { request: {
    action: "BOOK", patient_id: patient.patient_id, slot_id: nearest.slots[0]!.slot_id, policy_id: patient.insurer,
  } });
  assert.match(nearest.instruction, /earlier BOOK offer.*invalid/i);
  assert.match(nearest.instruction, /location\/direction questions.*clinic facts/i);
  assert.match(nearest.instruction, /do not invent.*routes/i);
  assert.match(nearest.instruction, /booking_continuation\.prepare_action/);
  assert.match(nearest.instruction, /new.*confirming caller turn/i);
  assert.equal(z.object({ actions: z.array(z.unknown()) }).parse(await h.execute("get_call_state", {})).actions.length, 0);
  assert.equal(h.writes.length, 0);
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: first.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  const fresh = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", preparation));
  assert.notEqual(fresh.proposal_id, first.booking_proposal.proposal_id);
  await assert.rejects(h.execute("confirm_action", { proposal_id: fresh.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  assert.equal(h.writes.length, 0);
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: fresh.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{
    call_id: "real-call-from-start", patient_id: patient.patient_id,
    provider_id: slot.provider_id, location_id: slot.location_id,
    appointment_type_id: slot.appointment_type_id, slot: slot.start_time, policy_id: patient.insurer,
  }]);
});

test("nearest BOOK continuation reuses explicit prepare_booking and never selects among multiple held policies", async () => {
  for (const multiplePolicies of [false, true]) {
    const h = harness({ addressResolver: syntheticOriginResolver,
      slots: [{ ...slot, payable_with: ["mapfre", "sanitas"] }] });
    await identify(h);
    const first = await searchBooking(h);
    assert.ok(first.booking_proposal);
    h.nextTurn();
    const origin = z.object({ origin_id: z.string() }).parse(
      await h.execute("locate_origin", { address: syntheticOriginAddress }),
    );
    const nearest = nearestBookingSearchSchema.parse(await h.execute("search_availability", {
      patient_id: patient.patient_id, request_id: first.request_id, nearest_origin_id: origin.origin_id,
      prepare_booking: true, ...(multiplePolicies ? { additional_policy: "sanitas" } : {}),
    }));
    assert.ok(nearest.booking_continuation);
    assert.equal(nearest.booking_continuation.prepare_action, null);
    if (multiplePolicies) {
      assert.equal(nearest.booking_proposal, null);
      assert.match(nearest.instruction, /Multiple eligible held policies require explicit selection/);
    } else {
      assert.ok(nearest.booking_proposal);
      assert.notEqual(nearest.booking_proposal.proposal_id, first.booking_proposal.proposal_id);
      assert.match(nearest.instruction, /already prepared, NOT submitted/);
      await assert.rejects(h.execute("confirm_action", {
        proposal_id: nearest.booking_proposal.proposal_id, confirmed: true,
      }), { code: "confirmation_requires_new_turn" });
    }
    await assert.rejects(h.execute("confirm_action", {
      proposal_id: first.booking_proposal.proposal_id, confirmed: true,
    }), { code: "proposal_not_found" });
    assert.equal(h.writes.length, 0);
  }
});

test("nearest continuation does not invent booking intent for read-only, independent or RESCHEDULE searches", async () => {
  for (const mode of ["read_only", "independent", "reschedule", "later_reschedule"] as const) {
    const h = harness({
      addressResolver: syntheticOriginResolver,
      ...(mode === "later_reschedule" ? { appointments: [laterAppointment], slots: [laterSlot] } : {}),
    });
    await identify(h);
    let requestId: string | undefined;
    if (mode === "independent") await searchBooking(h);
    if (mode === "reschedule") requestId = (await proposeScheduling(h, "RESCHEDULE")).request_id;
    if (mode === "later_reschedule") {
      await h.execute("list_appointments", { patient_id: patient.patient_id });
      const first = await searchLater(h);
      requestId = first.request_id;
      assert.ok(first.reschedule.prepare_action);
      await h.execute("prepare_action", first.reschedule.prepare_action);
    }
    h.nextTurn();
    const origin = z.object({ origin_id: z.string() }).parse(
      await h.execute("locate_origin", { address: syntheticOriginAddress }),
    );
    const raw = await h.execute("search_availability", {
      patient_id: patient.patient_id, specialty_id: slot.specialty_id, nearest_origin_id: origin.origin_id,
      ...(requestId ? { request_id: requestId } : {}),
      ...(mode === "independent" ? { new_request: true } : {}),
      ...(mode === "later_reschedule" ? { relax_constraints: ["location"] } : {}),
    });
    const result = nearestBookingSearchSchema.parse(raw);
    assert.ok(result.slots.length);
    assert.equal(result.booking_continuation, undefined);
    assert.equal(result.booking_proposal, null);
    if (mode === "later_reschedule") assert.equal(laterSearchSchema.parse(raw).reschedule.prepare_action?.request.action, "RESCHEDULE");
    const state = z.object({ actions: z.array(z.object({ action: z.string() })) }).parse(await h.execute("get_call_state", {}));
    assert.equal(state.actions.length, mode === "independent" ? 1 : 0);
    await h.engine.close();
    assert.equal(h.writes.length, 0);
  }
});

test("empty nearest re-search invalidates a BOOK draft without preparing or forcing a terminal action", async () => {
  let searches = 0;
  const h = harness({ addressResolver: syntheticOriginResolver,
    availability: () => offered(++searches === 1 ? [slot] : []) });
  await identify(h);
  const first = await searchBooking(h, { date_from: "2026-09-19", date_to: "2026-09-19" });
  assert.ok(first.booking_proposal);
  h.nextTurn();
  const origin = z.object({ origin_id: z.string() }).parse(
    await h.execute("locate_origin", { address: syntheticOriginAddress }),
  );
  const nearest = nearestBookingSearchSchema.parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, request_id: first.request_id, nearest_origin_id: origin.origin_id,
  }));
  assert.equal(nearest.slots.length, 0);
  assert.equal(nearest.booking_continuation, undefined);
  assert.equal(nearest.booking_proposal, null);
  assert.deepEqual(nearest.no_booking?.reason_candidates, ["no_availability"]);
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: first.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  await h.engine.close();
  assert.equal(h.writes.length, 0);
});

test("clinic access questions preserve the nearest offer without re-geocoding or implying confirmation", async () => {
  let originLookups = 0;
  const h = harness({ addressResolver: {
    async resolve() {
      originLookups += 1;
      return { source: "cartociudad", status: "resolved", truncated: false, candidates: [syntheticOriginCandidate] };
    },
  } });
  await identify(h);
  const origin = z.object({ origin_id: z.string() }).parse(
    await h.execute("locate_origin", { address: syntheticOriginAddress }),
  );
  const availability = await searchBooking(h, { nearest_origin_id: origin.origin_id });
  assert.ok(availability.booking_proposal);
  h.nextTurn();
  const information = z.object({
    locations: z.array(z.object({ id: z.string(), address: z.string() })),
  }).parse(await h.execute("get_clinic", { section: "locations" }));
  assert.equal(information.locations[0]?.address, clinic.locations[0]?.address);
  const state = z.object({ actions: z.array(z.object({ proposal_id: z.string(), status: z.string() })) })
    .parse(await h.execute("get_call_state", {}));
  assert.ok(state.actions.some((action) =>
    action.proposal_id === availability.booking_proposal!.proposal_id && action.status === "proposed"));
  assert.equal(originLookups, 1);
  assert.equal(h.writes.length, 0);
  const instructions = receptionistInstructions(new Date("2026-09-19T12:00:00Z"), true);
  assert.match(instructions, /does not publish entrances, floors or turn-by-turn directions/);
  assert.match(instructions, /agreement about a location is not booking consent/);
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: availability.booking_proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
});
test("Questions are answered from the catalogue without losing published hours or provider titles", async () => {
  const h = harness();
  const result = z.object({
    locations: z.array(z.object({ hours: z.array(z.object({ weekday: z.string() })) })),
  }).parse(await h.execute("get_clinic", { section: "locations" }));
  assert.ok(result.locations[0]?.hours.some((day) => day.weekday === "saturday"));
  assert.equal(h.writes.length, 0);
});

test("Doctor and Site resolves ambiguity before scheduling and records a nonexistent doctor explicitly", async () => {
  const primary = clinic.providers[0];
  assert.ok(primary);
  const h = harness({ clinic: {
    ...clinic,
    providers: [
      { ...primary, id: "PSAEZ", name: "Dr. Martin Saez" },
      { ...primary, id: "PSAENZ", name: "Dra. Marta Saenz", specialty_id: "paediatrics" },
    ],
  } });
  const ambiguous = z.object({ kind: z.literal("ambiguous"), candidates: z.array(z.object({ id: z.string() })) }).parse(
    await h.execute("resolve_request", { provider_name: "Saez" }),
  );
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(h.writes.length, 0);
  const found = z.object({ kind: z.literal("resolved"), provider: z.object({ id: z.string() }) }).parse(
    await h.execute("resolve_request", { provider_name: "Martin Saez" }),
  );
  assert.equal(found.provider.id, "PSAEZ");
  const unknown = z.object({ kind: z.literal("not_found") }).parse(
    await h.execute("resolve_request", { provider_name: "Doctor Never Exists" }),
  );
  assert.equal(unknown.kind, "not_found");
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "provider_not_found" });
  assert.deepEqual(h.writes[0], { call_id: "real-call-from-start", reason: "provider_not_found" });
});

test("a leave redirect preserves specialty and site until the caller accepts a different provider", async () => {
  const primary = clinic.providers[0];
  assert.ok(primary);
  const h = harness({
    clinic: {
      ...clinic,
      providers: [
        { ...primary, id: "LEAVE", name: "Dr. Leon Test", leave: { start: "2026-09-14", end: "2026-09-30", reason: "leave" } },
        { ...primary, id: "SAME", name: "Dra. Rita Test" },
        { ...primary, id: "OTHER", name: "Dr. Other Site", schedules: [{ location_id: "elsewhere", location_name: "Other site", days: [] }] },
      ],
    },
    availability: (query) => query.searchParams.get("provider_id") === "LEAVE"
      ? offered([], [{ provider_id: "LEAVE", restriction: "provider_on_leave" }])
      : offered([{ ...slot, provider_id: "SAME", provider_name: "Dra. Rita Test" }]),
  });
  await identify(h);
  const leave = z.object({ on_leave: z.literal(true) }).parse(await h.execute("resolve_request", { provider_name: "Leon Test" }));
  assert.equal(leave.on_leave, true);
  const noBooking = z.object({
    request_id: z.string(), slots: z.array(z.unknown()),
    no_booking: z.object({ alternative_providers_same_specialty_and_site: z.array(z.object({ id: z.string() })) }),
  }).parse(await h.execute("search_availability", { patient_id: "PTEST", provider_id: "LEAVE", location_id: "centro" }));
  assert.equal(noBooking.slots.length, 0);
  assert.deepEqual(noBooking.no_booking.alternative_providers_same_specialty_and_site.map((p) => p.id), ["SAME"]);
  h.nextTurn();
  const result = z.object({ slots: z.array(z.object({ location_id: z.string(), specialty_id: z.string() })) }).parse(
    await h.execute("search_availability", { patient_id: "PTEST", request_id: noBooking.request_id, relax_constraints: ["provider"] }),
  );
  assert.equal(result.slots[0]?.location_id, "centro");
  assert.equal(result.slots[0]?.specialty_id, "general_practice");
  const query = h.requests.filter((url) => url.pathname.endsWith("/availability")).at(-1);
  assert.equal(query?.searchParams.get("provider_id"), null);
  assert.equal(query?.searchParams.get("location_id"), "centro");
});

test("Triage: reported emergency prevents an old booking proposal from being submitted", async () => {
  const h = harness();
  const proposal = await proposeBooking(h);
  h.nextTurn();
  const result = z.object({ kind: z.literal("emergency"), action: z.literal("ESCALATE") }).parse(
    await h.execute("resolve_request", { complaint: "Tight pain across my chest and I am struggling to catch my breath." }),
  );
  assert.equal(result.action, "ESCALATE");
  await assert.rejects(h.execute("confirm_action", { proposal_id: proposal, confirmed: true }));
  await assert.rejects(h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" }));
  await h.execute("report_outcome", { action: "ESCALATE", reason: "medical_emergency" });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", reason: "medical_emergency" }]);
});

test("Triage: symptoms route using the verified age and available catalogue, without giving medical advice", async () => {
  const h = harness({
    patients: [{ ...patient, date_of_birth: "2015-01-01" }],
    clinic: {
      ...clinic,
      specialties: [
        ...clinic.specialties,
        { id: "paediatrics", name: "Paediatrics", min_age_months: 0, max_age_months: 167, referral_required: false },
      ],
    },
  });
  await identify(h);
  const result = z.object({ kind: z.literal("resolved"), specialty_id: z.string() }).parse(
    await h.execute("resolve_request", {
      patient_id: "PTEST", complaint: "My child has had a temperature for two days and is off their food.",
    }),
  );
  assert.equal(result.specialty_id, "paediatrics");
  assert.equal(h.writes.length, 0);
});

test("a separate refusal and an accepted booking can coexist without mixing patient-specific evidence", async () => {
  const other: Patient = { ...patient, patient_id: "POTHER", given_name: "Bea", national_id: "00000000T" };
  const h = harness({
    directory: (query) => [query.searchParams.get("national_id") === other.national_id ? other : patient],
    availability: (query) => query.searchParams.get("patient_id") === "POTHER" ? offered([]) : offered([slot]),
  });
  const proposal = await proposeBooking(h);
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal, confirmed: true });
  await h.execute("find_patient", { name: "Bea Prueba Test", national_id: other.national_id });
  const unavailable = z.object({ request_id: z.string() }).parse(await h.execute("search_availability", {
    patient_id: "POTHER", specialty_id: "general_practice",
  }));
  await h.execute("report_outcome", { request_id: unavailable.request_id, action: "NO_ACTION", reason: "no_availability" });
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[0]?.patient_id, "PTEST");
  assert.deepEqual(h.writes[1], { call_id: "real-call-from-start", reason: "no_availability" });
});

test("a remembered second policy is reused for the same patient but never inherited by another patient", async () => {
  const other: Patient = { ...patient, patient_id: "POTHER", given_name: "Bea", national_id: "00000000T" };
  const h = harness({
    directory: (query) => [query.searchParams.get("national_id") === other.national_id ? other : patient],
    availability: (query) => offered(query.searchParams.getAll("insurer").includes("sanitas")
      ? [{ ...slot, payable_with: ["sanitas"] }] : []),
  });
  await identify(h);
  await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice", additional_policy: "sanitas" });
  await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" });
  assert.deepEqual(h.requests.filter((url) => url.pathname.endsWith("/availability")).at(-1)?.searchParams.getAll("insurer"), ["mapfre", "sanitas"]);
  await h.execute("find_patient", { name: "Bea Prueba Test", national_id: other.national_id });
  await h.execute("search_availability", { patient_id: "POTHER", specialty_id: "general_practice" });
  assert.deepEqual(h.requests.filter((url) => url.pathname.endsWith("/availability")).at(-1)?.searchParams.getAll("insurer"), []);
});

test("a correction to a single held policy removes a previously supplied secondary plan", async () => {
  const h = harness({ availability: (query) => offered(query.searchParams.getAll("insurer").includes("sanitas")
    ? [{ ...slot, payable_with: ["sanitas"] }] : [], [{ provider_id: "PRTEST", restriction: "specialty_not_covered" }]) });
  await identify(h);
  const first = z.object({ request_id: z.string() }).parse(await h.execute("search_availability", {
    patient_id: "PTEST", specialty_id: "general_practice", additional_policy: "sanitas",
  }));
  h.nextTurn();
  await h.execute("search_availability", { patient_id: "PTEST", request_id: first.request_id, no_other_policy: true });
  assert.deepEqual(h.requests.filter((url) => url.pathname.endsWith("/availability")).at(-1)?.searchParams.getAll("insurer"), []);
  await h.execute("report_outcome", {
    request_id: first.request_id, action: "NO_ACTION", reason: "specialty_not_covered",
  });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.reason, "specialty_not_covered");
});

test("a corrected date phrase replaces an old weekday and part of day without losing the chosen site", async () => {
  const h = harness({
    clinic: {
      ...clinic,
      locations: clinic.locations.map((location) => ({
        ...location, hours: ["monday", "thursday"].map((weekday) => ({ weekday, intervals: ["09:00-18:00"] })),
      })),
    },
    availability: (query) => offered(["09:00", "15:00"].map((time) => ({
      ...slot, start_time: `${query.searchParams.get("date_from")}T${time}:00+02:00`,
    }))),
  });
  await identify(h);
  const original = z.object({ request_id: z.string() }).parse(await h.execute("search_availability", {
    patient_id: "PTEST", specialty_id: "general_practice", location_id: "centro",
    date_phrase: "this coming Monday", weekday: "monday", time_of_day: "morning",
  }));
  const corrected = z.object({ slots: z.array(z.object({ start_time: z.string(), location_id: z.string() })) }).parse(
    await h.execute("search_availability", {
      patient_id: "PTEST", request_id: original.request_id, date_phrase: "Thursday afternoon",
    }),
  );
  assert.deepEqual(corrected.slots.map((value) => value.start_time), ["2026-09-24T15:00:00+02:00"]);
  assert.equal(corrected.slots[0]?.location_id, "centro");
});

test("an unsupported routine complaint does not block an explicit scheduling request", async () => {
  for (const complaint of ["A routine ongoing sleep concern.", "A routine skin follow-up.", "A routine back check-up."]) {
    const h = harness();
    await identify(h);
    const routing = z.object({ kind: z.literal("clarify") }).parse(await h.execute("resolve_request", {
      patient_id: "PTEST", complaint,
    }));
    assert.equal(routing.kind, "clarify");
    const result = z.object({ slots: z.array(z.unknown()) }).parse(await h.execute("search_availability", {
      patient_id: "PTEST", specialty_id: "general_practice",
    }));
    assert.ok(result.slots.length > 0);
  }
});

test("explicit catalogue requests are resolved even when the accompanying complaint is outside the triage table", async () => {
  const h = harness();
  await identify(h);
  const provider = z.object({ kind: z.literal("resolved"), provider: z.object({ id: z.string() }) }).parse(
    await h.execute("resolve_request", {
      patient_id: "PTEST", provider_name: "Test Doctor", complaint: "A routine follow-up for an ongoing concern.",
    }),
  );
  assert.equal(provider.provider.id, "PRTEST");
  const specialty = z.object({ kind: z.literal("resolved"), specialty_id: z.string() }).parse(
    await h.execute("resolve_request", {
      patient_id: "PTEST", specialty: "General Practice", complaint: "A routine follow-up for an ongoing concern.",
    }),
  );
  assert.equal(specialty.specialty_id, "general_practice");
});

test("an absent named provider supplies refusal evidence without an unwanted alternative search", async () => {
  const h = harness();
  await identify(h);
  const result = z.object({ kind: z.literal("not_found") }).parse(await h.execute("resolve_request", {
    patient_id: "PTEST", provider_name: "Doctor Completely Absent", complaint: "A routine skin check-up.",
  }));
  assert.equal(result.kind, "not_found");
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "provider_not_found" });
  assert.deepEqual(h.writes[0], { call_id: "real-call-from-start", reason: "provider_not_found" });
  assert.ok(!h.requests.some((url) => url.pathname.endsWith("/availability")));
});

test("possible emergency concerns remain a safety block, unlike unsupported routine complaints", async () => {
  const h = harness();
  await identify(h);
  await h.execute("resolve_request", {
    patient_id: "PTEST", specialty: "General Practice", complaint: "I might have chest pain and struggle to breathe.",
    complaint_context: "uncertain",
  });
  await assert.rejects(h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" }), /possible emergency symptoms/);
  const unresolved = z.object({ kind: z.literal("clarify") }).parse(
    await h.execute("resolve_request", { patient_id: "PTEST", specialty: "General Practice" }),
  );
  assert.equal(unresolved.kind, "clarify");
  assert.equal(h.writes.length, 0);
});

test("advancing an empty open day searches the next date instead of silently repeating it", async () => {
  for (const nextFlag of [{ advance_day: true }, { allow_next_open_day: true }]) {
    const h = harness({
      clinic: {
        ...clinic,
        locations: clinic.locations.map((location) => ({
          ...location, hours: ["monday", "tuesday"].map((weekday) => ({ weekday, intervals: ["09:00-18:00"] })),
        })),
      },
      availability: (query) => offered(query.searchParams.get("date_from") === "2026-09-22"
        ? [{ ...slot, start_time: "2026-09-22T09:00:00+02:00" }] : []),
    });
    await identify(h);
    const first = z.object({ request_id: z.string() }).parse(await h.execute("search_availability", {
      patient_id: "PTEST", specialty_id: "general_practice", location_id: "centro", date_phrase: "this coming Monday",
    }));
    h.nextTurn();
    const second = z.object({ slots: z.array(z.object({ start_time: z.string() })), searched_from: z.string() }).parse(
      await h.execute("search_availability", { patient_id: "PTEST", request_id: first.request_id, ...nextFlag }),
    );
    assert.equal(second.searched_from, "2026-09-22");
    assert.equal(second.slots[0]?.start_time, "2026-09-22T09:00:00+02:00");
    await assert.rejects(h.execute("report_outcome", { action: "NO_ACTION", request_id: first.request_id, reason: "no_availability" }));
  }
});

test("a qualified confirmation cannot send a booking before the caller's extra request is resolved", async () => {
  const gate = new ConfirmationGate(() => 2, new AbortController().signal);
  const h = harness({ beforeConfirmation: (turn) => gate.review(turn) });
  const proposal = await proposeBooking(h);
  h.nextTurn();
  gate.observe(2, "Yes, that looks fine, but could you check another time first?");
  await assert.rejects(h.execute("confirm_action", { proposal_id: proposal, confirmed: true }),
    { code: "confirmation_needs_clarification" });
  assert.equal(h.writes.length, 0);
});

test("private tool diagnostics record resolved query dates and decisions without identity values", async () => {
  const h = harness();
  await identify(h);
  await h.execute("resolve_request", { patient_id: "PTEST", specialty: "General Practice" });
  await h.execute("search_availability", { patient_id: "PTEST", specialty_id: "general_practice" });
  const tools = z.array(z.object({
    type: z.literal("tool"), name: z.string(), details: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()).parse(h.records.filter((record) => typeof record === "object" && record !== null && "type" in record && record.type === "tool"));
  assert.equal(tools.find((tool) => tool.name === "resolve_request")?.details?.kind, "resolved");
  assert.equal(tools.find((tool) => tool.name === "search_availability")?.details?.dateFrom, "2026-09-19");
  const serialized = JSON.stringify(tools);
  assert.ok(!serialized.includes(patient.national_id));
  assert.ok(!serialized.includes(patient.phone));
});

test("fresh appointment proposals cannot bypass a patient's possible-emergency block", async () => {
  for (const action of ["BOOK", "RESCHEDULE"] as const) {
    for (const failed of [false, true]) {
      const h = harness({ post: async () => new Response(null, { status: 422 }) });
      const draft = await proposeScheduling(h, action);
      h.nextTurn();
      if (failed) {
        await assert.rejects(h.execute("confirm_action", { proposal_id: draft.proposal_id, confirmed: true }),
          { code: "prosper_http_422" });
        h.nextTurn();
      }
      await h.execute("resolve_request", {
        patient_id: patient.patient_id, complaint: "I might have chest pain and struggle to breathe.",
        complaint_context: "uncertain",
      });
      await assert.rejects(h.execute("confirm_action", { proposal_id: draft.proposal_id, confirmed: true }),
        { code: "request_needs_clarification" });
      await assert.rejects(h.execute("prepare_action", { request: draft.request }),
        { code: "request_needs_clarification" });
      assert.equal(h.writes.length, failed ? 1 : 0);
    }
  }
});

test("a terminal request outcome removes only its unconfirmed scheduling drafts", async () => {
  for (const action of ["BOOK", "RESCHEDULE"] as const) {
    const h = harness();
    const refused = await proposeScheduling(h, action);
    const independent = await proposeScheduling(h, "BOOK", { new_request: true });
    h.nextTurn();
    const outcome = { request_id: refused.request_id, action: "NO_ACTION", reason: "out_of_scope" };
    await h.execute("report_outcome", outcome);
    const state = z.object({
      actions: z.array(z.object({ proposal_id: z.string(), action: z.string() })),
    }).parse(await h.execute("get_call_state", {}));
    assert.ok(!state.actions.some((entry) => entry.proposal_id === refused.proposal_id));
    assert.ok(state.actions.some((entry) => entry.proposal_id === independent.proposal_id));
    await assert.rejects(h.execute("confirm_action", { proposal_id: refused.proposal_id, confirmed: true }),
      { code: "proposal_not_found" });
    await assert.rejects(h.execute("prepare_action", { request: refused.request }),
      { code: "slot_not_verified" });
    await h.execute("confirm_action", { proposal_id: independent.proposal_id, confirmed: true });
    await h.execute("report_outcome", outcome);
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes[0]?.reason, "out_of_scope");
    assert.equal(h.writes[1]?.patient_id, patient.patient_id);
  }
});

test("a scheduling proposal invalidated during confirmation review cannot be submitted", async () => {
  let requestId = "";
  const h = harness({ beforeConfirmation: async () => {
    await h.execute("report_outcome", { request_id: requestId, action: "NO_ACTION", reason: "out_of_scope" });
  } });
  const draft = await proposeScheduling(h, "BOOK");
  requestId = draft.request_id;
  h.nextTurn();
  await assert.rejects(h.execute("confirm_action", { proposal_id: draft.proposal_id, confirmed: true }),
    { code: "proposal_not_found" });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", reason: "out_of_scope" }]);
});

test("a patient safety block preserves other patients and cancellations and preflights grouped writes", async () => {
  const other: Patient = { ...patient, patient_id: "POTHER", given_name: "Bea", national_id: "00000000T" };
  const h = harness({
    directory: (query) => [query.searchParams.get("national_id") === other.national_id ? other : patient],
    appointments: [appointment, { ...appointment, appointment_id: "ATEST2" }],
  });
  const blocked = await proposeScheduling(h, "BOOK");
  await h.execute("find_patient", { name: "Bea Prueba Test", national_id: other.national_id });
  const options = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await h.execute("search_availability", { patient_id: other.patient_id, specialty_id: slot.specialty_id }),
  );
  const independent = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: other.patient_id, slot_id: options.slots[0]?.slot_id, policy_id: other.insurer,
  } }));
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const cancellations: string[] = [];
  for (const appointmentId of ["ATEST", "ATEST2"]) {
    const proposal = z.object({ proposal_id: z.string() }).parse(
      await h.execute("prepare_action", { request: { action: "CANCEL", appointment_id: appointmentId } }),
    );
    cancellations.push(proposal.proposal_id);
  }
  h.nextTurn();
  await h.execute("resolve_request", {
    patient_id: patient.patient_id, complaint: "I might have chest pain and struggle to breathe.",
    complaint_context: "uncertain",
  });
  await assert.rejects(h.execute("confirm_actions", {
    proposal_ids: [independent.proposal_id, blocked.proposal_id], confirmed: true,
  }), { code: "request_needs_clarification" });
  assert.equal(h.writes.length, 0);
  await h.execute("confirm_actions", {
    proposal_ids: [independent.proposal_id, ...cancellations], confirmed: true,
  });
  assert.equal(h.writes.length, 3);
  assert.equal(h.writes[0]?.patient_id, other.patient_id);
  assert.deepEqual(h.writes.slice(1).map((body) => body.appointment_id), ["ATEST", "ATEST2"]);
});

test("accepted pending and uncertain scheduling retries remain identical after new safety concerns", async () => {
  for (const state of ["accepted", "pending", "unknown"] as const) {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const h = harness({ post: async (_body, attempt) => {
      started.resolve();
      if (state === "unknown" && attempt <= 2) throw new TypeError("uncertain delivery");
      return state === "pending" ? response.promise : new Response(null, { status: 409 });
    } });
    const draft = await proposeScheduling(h, "BOOK");
    h.nextTurn();
    const submitting = h.execute("confirm_action", { proposal_id: draft.proposal_id, confirmed: true });
    if (state === "pending") await started.promise;
    else if (state === "unknown") await assert.rejects(submitting, { code: "prosper_submission_unknown" });
    else await submitting;
    await h.execute("resolve_request", {
      patient_id: patient.patient_id, complaint: "I might have chest pain and struggle to breathe.",
      complaint_context: "uncertain",
    });
    const retried = h.execute("confirm_action", { proposal_id: draft.proposal_id, confirmed: true });
    response.resolve(new Response(null, { status: 409 }));
    assert.equal(z.object({ status: z.string() }).parse(await retried).status, "duplicate");
    if (state === "pending") await submitting;
    assert.equal(h.writes.length, state === "unknown" ? 3 : 1);
    for (const body of h.writes) assert.deepEqual(body, h.writes[0]);
  }
});

test("an opt-in BOOK search prepares the first eligible slot without posting and requires a new confirming turn", async () => {
  const earliest = { ...slot, appointment_type_id: "specialty_review", start_time: "2026-09-19T09:30:00+02:00" };
  const h = harness({ availability: () => offered([
    { ...slot, start_time: "2026-09-19T15:00:00+02:00" },
    { ...slot, start_time: "2026-09-18T08:00:00+02:00" },
    { ...slot, start_time: "2026-09-19T09:00:00+02:00", payable_with: ["privado"] },
    earliest, slot,
  ]) });
  await identify(h);
  const result = await searchBooking(h, { time_of_day: "morning" });
  const proposal = result.booking_proposal;
  assert.ok(proposal);
  assert.equal(proposal.request_id, result.request_id);
  assert.equal(proposal.slot_id, result.slots[0]?.slot_id);
  assert.equal(result.slots[0]?.start_time, earliest.start_time);
  assert.equal(proposal.patient_name, `${patient.given_name} ${patient.first_surname} ${patient.second_surname}`);
  assert.equal(proposal.provider_name, clinic.providers[0]?.name);
  assert.equal(proposal.location_name, clinic.locations[0]?.name);
  assert.match(result.instruction, /already prepared, NOT submitted/);
  assert.equal(h.writes.length, 0);
  assert.ok(h.requests.every((query) => !query.searchParams.has("prepare_booking")));
  await assert.rejects(h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{
    call_id: "real-call-from-start", patient_id: patient.patient_id,
    provider_id: earliest.provider_id, location_id: earliest.location_id,
    appointment_type_id: earliest.appointment_type_id, slot: earliest.start_time, policy_id: patient.insurer,
  }]);
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
});

test("prepare_booking is invocation-only and ordinary or reschedule searches do not create BOOK drafts", async () => {
  const h = harness();
  await identify(h);
  const ordinary = bookingSearchSchema.parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, specialty_id: slot.specialty_id,
  }));
  assert.equal(ordinary.booking_proposal, null);
  const first = await searchBooking(h, { request_id: ordinary.request_id });
  assert.ok(first.booking_proposal);
  h.nextTurn();
  const readOnly = bookingSearchSchema.parse(await h.execute("search_availability", {
    patient_id: patient.patient_id, request_id: first.request_id,
  }));
  assert.equal(readOnly.booking_proposal, null);
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: first.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  const state = z.object({ actions: z.array(z.unknown()) }).parse(await h.execute("get_call_state", {}));
  assert.equal(state.actions.length, 0);
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const move = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", { request: {
    action: "RESCHEDULE", appointment_id: appointment.appointment_id,
    slot_id: readOnly.slots[0]?.slot_id, policy_id: patient.insurer,
  } }));
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: move.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.appointment_id, appointment.appointment_id);
  assert.ok(!Object.hasOwn(h.writes[0]!, "patient_id"));
});

test("auto-book preparation selects only the unique eligible held policy", async () => {
  for (const scenario of [
    { insurer: "mapfre", payable: ["mapfre", "privado"], expected: "mapfre" },
    { insurer: "mapfre", payable: ["sanitas"], additional: "sanitas", expected: "sanitas" },
    { insurer: "privado", payable: ["privado"], expected: "privado" },
  ] as const) {
    const h = harness({
      patients: [{ ...patient, insurer: scenario.insurer }],
      slots: [{ ...slot, payable_with: [...scenario.payable] }],
    });
    await identify(h);
    const result = await searchBooking(h, "additional" in scenario ? { additional_policy: scenario.additional } : {});
    const proposal = result.booking_proposal;
    assert.ok(proposal?.action.action === "BOOK");
    assert.equal(proposal.action.policy_id, scenario.expected);
    assert.equal(h.writes.length, 0);
    if ("additional" in scenario) {
      const query = h.requests.find((url) => url.pathname.endsWith("/availability"));
      assert.deepEqual(query?.searchParams.getAll("insurer"), ["mapfre", "sanitas"]);
    }
    h.nextTurn();
    await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
    assert.equal(h.writes[0]?.policy_id, scenario.expected);
  }
});

test("ambiguous held policies leave the earliest slot unprepared for manual policy selection", async () => {
  const h = harness({ slots: [
    { ...slot, payable_with: ["mapfre", "sanitas"] },
    { ...slot, start_time: "2026-09-19T12:00:00+02:00" },
  ] });
  await identify(h);
  const result = await searchBooking(h, { additional_policy: "sanitas" });
  assert.equal(result.booking_proposal, null);
  assert.equal(result.slots.length, 2);
  const state = z.object({ actions: z.array(z.unknown()) }).parse(await h.execute("get_call_state", {}));
  assert.equal(state.actions.length, 0);
  const manual = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: patient.patient_id, slot_id: result.slots[0]?.slot_id, policy_id: "sanitas",
  } }));
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: manual.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.slot, slot.start_time);
  assert.equal(h.writes[0]?.policy_id, "sanitas");
});

test("manual alternative selection replaces an auto-book draft without reusing its confirmation turn", async () => {
  const later = { ...slot, start_time: "2026-09-19T12:00:00+02:00" };
  const h = harness({ slots: [slot, later] });
  await identify(h);
  const original = await searchBooking(h);
  assert.ok(original.booking_proposal);
  h.nextTurn();
  const replacement = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: patient.patient_id, slot_id: original.slots[1]?.slot_id, policy_id: patient.insurer,
  } }));
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: original.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  await assert.rejects(h.execute("confirm_action", { proposal_id: replacement.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  assert.equal(h.writes.length, 0);
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: replacement.proposal_id, confirmed: true });
  assert.equal(h.writes[0]?.slot, later.start_time);
});

test("a corrected auto-book search replaces its draft and preserves other caller constraints", async () => {
  const h = harness({ slots: [
    { ...slot, start_time: "2026-09-21T09:00:00+02:00" },
    { ...slot, start_time: "2026-09-21T15:00:00+02:00" },
  ] });
  await identify(h);
  const original = await searchBooking(h, {
    location_id: "centro", date_phrase: "this coming Monday", time_of_day: "morning",
  });
  assert.ok(original.booking_proposal);
  h.nextTurn();
  await h.execute("revise_request", { request_id: original.request_id });
  const corrected = await searchBooking(h, { request_id: original.request_id, time_of_day: "afternoon" });
  assert.ok(corrected.booking_proposal?.action.action === "BOOK");
  assert.equal(corrected.booking_proposal.action.slot, "2026-09-21T15:00:00+02:00");
  assert.equal(corrected.booking_proposal.action.location_id, "centro");
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: original.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: corrected.booking_proposal.proposal_id, confirmed: true,
  }), { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: corrected.booking_proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
});

test("corrected patient identity revokes the auto-book draft before preparing for the new patient", async () => {
  const other: Patient = { ...patient, patient_id: "POTHER", given_name: "Bea", national_id: "00000000T" };
  const h = harness({
    directory: (query) => [query.searchParams.get("national_id") === other.national_id ? other : patient],
  });
  await identify(h);
  const original = await searchBooking(h);
  assert.ok(original.booking_proposal);
  h.nextTurn();
  await h.execute("find_patient", {
    replaces_patient_id: patient.patient_id, name: "Bea Prueba Test", national_id: other.national_id,
  });
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: original.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  const corrected = await searchBooking(h, { patient_id: other.patient_id });
  assert.ok(corrected.booking_proposal);
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: corrected.booking_proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.patient_id, other.patient_id);
});

test("auto-book drafts for independent requests and patients survive another request's re-search", async () => {
  const other: Patient = { ...patient, patient_id: "POTHER", given_name: "Bea", national_id: "00000000T" };
  const h = harness({
    directory: (query) => [query.searchParams.get("national_id") === other.national_id ? other : patient],
  });
  await identify(h);
  const original = await searchBooking(h);
  const independent = await searchBooking(h, { new_request: true });
  await h.execute("find_patient", { name: "Bea Prueba Test", national_id: other.national_id });
  const otherDraft = await searchBooking(h, { patient_id: other.patient_id });
  assert.ok(original.booking_proposal && independent.booking_proposal && otherDraft.booking_proposal);
  h.nextTurn();
  const empty = await searchBooking(h, {
    request_id: original.request_id, date_from: "2026-09-20", date_to: "2026-09-20",
  });
  assert.equal(empty.booking_proposal, null);
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: original.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  await h.execute("confirm_actions", {
    proposal_ids: [independent.booking_proposal.proposal_id, otherDraft.booking_proposal.proposal_id], confirmed: true,
  });
  assert.deepEqual(h.writes.map((body) => body.patient_id), [patient.patient_id, other.patient_id]);
});

test("empty blocked and unheld-private searches never auto-prepare or submit an outcome", async () => {
  for (const availability of [
    offered([]),
    offered([], [{ provider_id: slot.provider_id, restriction: "specialty_not_covered" }]),
    offered([{ ...slot, payable_with: ["privado"] }]),
  ]) {
    const h = harness({ availability: () => availability });
    await identify(h);
    const result = await searchBooking(h);
    assert.equal(result.booking_proposal, null);
    assert.equal(result.slots.length, 0);
    assert.ok(result.no_booking);
    const state = z.object({ actions: z.array(z.unknown()) }).parse(await h.execute("get_call_state", {}));
    assert.equal(state.actions.length, 0);
    assert.equal(h.writes.length, 0);
  }
});

test("stale or disconnected opt-in searches cannot finish creating an automatic proposal", async () => {
  for (const stop of ["new_turn", "disconnect"] as const) {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Availability>();
    const h = harness({ availability: async () => { started.resolve(); return response.promise; } });
    await identify(h);
    const searching = searchBooking(h);
    await started.promise;
    if (stop === "new_turn") h.nextTurn();
    else {
      h.controller.abort();
      await h.engine.close();
    }
    response.resolve(offered([slot]));
    await assert.rejects(searching, { code: stop === "new_turn" ? "stale_turn" : "call_cancelled" });
    assert.equal(h.writes.length, 0);
    assert.ok(!h.records.some((record) => typeof record === "object" && record !== null && "stage" in record));
  }
});

test("diagnostic and abandoned auto-book drafts never POST", async () => {
  for (const diagnostic of [false, true]) {
    const h = harness({ allowSubmissions: !diagnostic });
    await identify(h);
    const result = await searchBooking(h);
    assert.ok(result.booking_proposal);
    h.nextTurn();
    if (diagnostic) {
      await assert.rejects(h.execute("confirm_action", {
        proposal_id: result.booking_proposal.proposal_id, confirmed: true,
      }), { code: "submissions_disabled" });
    } else h.controller.abort();
    await h.engine.close();
    assert.equal(h.writes.length, 0);
  }
});

test("both next-day forms retain opt-in preparation without treating it as a date constraint", async () => {
  for (const useReturned of [false, true]) {
    const h = harness({
      clinic: {
        ...clinic,
        locations: clinic.locations.map((location) => ({
          ...location, hours: ["monday", "tuesday"].map((weekday) => ({ weekday, intervals: ["09:00-18:00"] })),
        })),
      },
      availability: (query) => offered(query.searchParams.get("date_from") === "2026-09-22"
        ? [{ ...slot, start_time: "2026-09-22T09:00:00+02:00" }] : []),
    });
    await identify(h);
    const first = await searchBooking(h, { location_id: "centro", date_phrase: "this coming Monday" });
    assert.deepEqual(first.no_booking?.next_day_search, {
      patient_id: patient.patient_id, request_id: first.request_id, advance_day: true, prepare_booking: true,
    });
    h.nextTurn();
    const next = bookingSearchSchema.parse(await h.execute("search_availability", useReturned
      ? first.no_booking?.next_day_search
      : { patient_id: patient.patient_id, request_id: first.request_id, allow_next_open_day: true, prepare_booking: true }));
    assert.equal(next.searched_from, "2026-09-22");
    assert.ok(next.booking_proposal?.action.action === "BOOK");
    assert.equal(next.booking_proposal.action.slot, "2026-09-22T09:00:00+02:00");
    assert.equal(next.booking_proposal.action.location_id, "centro");
    await assert.rejects(h.execute("confirm_action", {
      proposal_id: next.booking_proposal.proposal_id, confirmed: true,
    }), { code: "confirmation_requires_new_turn" });
    assert.equal(h.writes.length, 0);
  }
});

test("auto-book proposals retain the existing cost-condition and deferral confirmation guards", async () => {
  for (const transcript of ["Before I agree, what would that cost?", "I will wait until I check the price."]) {
    const gate = new ConfirmationGate(() => 2, new AbortController().signal);
    const h = harness({
      beforeConfirmation: (turn) => gate.review(turn),
      beforeOutcome: (turn, reason) => gate.reviewOutcome(turn, reason),
    });
    await identify(h);
    const result = await searchBooking(h);
    assert.ok(result.booking_proposal);
    h.nextTurn();
    gate.observe(2, transcript);
    const repeated = z.object({ proposal_id: z.string(), unchanged: z.literal(true) }).parse(
      await h.execute("prepare_action", { request: {
        action: "BOOK", patient_id: patient.patient_id,
        slot_id: result.booking_proposal.slot_id, policy_id: patient.insurer,
      } }),
    );
    assert.equal(repeated.proposal_id, result.booking_proposal.proposal_id);
    await assert.rejects(h.execute("confirm_action", {
      proposal_id: result.booking_proposal.proposal_id, confirmed: true,
    }), { code: "confirmation_needs_clarification" });
    if (transcript.startsWith("I will wait")) {
      await assert.rejects(h.execute("report_outcome", {
        request_id: result.request_id, action: "NO_ACTION", reason: "caller_not_authorised",
      }), { code: "outcome_reason_not_supported" });
    }
    assert.equal(h.writes.length, 0);
  }
});

test("auto-book drafts remain subject to patient safety and terminal request outcomes", async () => {
  for (const guard of ["emergency", "outcome"] as const) {
    const h = harness();
    await identify(h);
    const result = await searchBooking(h);
    assert.ok(result.booking_proposal);
    h.nextTurn();
    if (guard === "emergency") {
      await h.execute("resolve_request", {
        patient_id: patient.patient_id, complaint: "I might have chest pain and struggle to breathe.",
        complaint_context: "uncertain",
      });
    } else {
      await h.execute("report_outcome", {
        request_id: result.request_id, action: "NO_ACTION", reason: "out_of_scope",
      });
    }
    await assert.rejects(h.execute("confirm_action", {
      proposal_id: result.booking_proposal.proposal_id, confirmed: true,
    }), { code: guard === "emergency" ? "request_needs_clarification" : "proposal_not_found" });
    assert.equal(h.writes.length, guard === "emergency" ? 0 : 1);
    assert.ok(h.writes.every((body) => !Object.hasOwn(body, "slot")));
  }
});

test("opt-in preparation cannot manufacture a verified patient from a registration draft", async () => {
  const h = harness();
  await assert.rejects(searchBooking(h), { code: "patient_unverified" });
  await h.execute("collect_registration", {});
  await assert.rejects(searchBooking(h), { code: "patient_unverified" });
  const state = z.object({ actions: z.array(z.unknown()) }).parse(await h.execute("get_call_state", {}));
  assert.equal(state.actions.length, 0);
  assert.equal(h.writes.length, 0);
});

test("correcting held policies invalidates an auto-book draft and prevents stale-policy writes in other intents", async () => {
  const h = harness({ availability: (query) => offered(query.searchParams.getAll("insurer").includes("sanitas")
    ? [{ ...slot, payable_with: ["sanitas"] }] : [],
  [{ provider_id: slot.provider_id, restriction: "specialty_not_covered" }]) });
  await identify(h);
  const first = await searchBooking(h, { additional_policy: "sanitas" });
  const independent = await searchBooking(h, { new_request: true });
  assert.ok(first.booking_proposal && independent.booking_proposal);
  h.nextTurn();
  const corrected = await searchBooking(h, { request_id: first.request_id, no_other_policy: true });
  assert.equal(corrected.booking_proposal, null);
  assert.ok(corrected.no_booking);
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: first.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  const state = z.object({ actions: z.array(z.object({ proposal_id: z.string() })) }).parse(
    await h.execute("get_call_state", {}),
  );
  assert.ok(state.actions.some((draft) => draft.proposal_id === independent.booking_proposal?.proposal_id));
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: independent.booking_proposal.proposal_id, confirmed: true,
  }), { code: "policy_not_eligible" });
  assert.equal(h.writes.length, 0);
});

test("accepted and uncertain auto-book requests cannot be replaced but retain identical retries", async () => {
  for (const status of ["accepted", "unknown"] as const) {
    const h = harness(status === "unknown" ? { post: async (_body, attempt) => {
      if (attempt <= 2) throw new TypeError("uncertain delivery");
      return new Response(null, { status: 409 });
    } } : {});
    await identify(h);
    const result = await searchBooking(h);
    const proposal = result.booking_proposal;
    assert.ok(proposal);
    h.nextTurn();
    const confirming = h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
    if (status === "unknown") await assert.rejects(confirming, { code: "prosper_submission_unknown" });
    else await confirming;
    await assert.rejects(searchBooking(h, { request_id: result.request_id }), { code: "action_already_submitted" });
    await assert.rejects(h.execute("revise_request", { request_id: result.request_id }),
      { code: "action_already_submitted" });
    await assert.rejects(h.execute("prepare_action", { request: {
      action: "BOOK", patient_id: patient.patient_id, slot_id: proposal.slot_id, policy_id: patient.insurer,
    } }), { code: "action_already_submitted" });
    await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
    assert.equal(h.writes.length, status === "unknown" ? 3 : 1);
    for (const body of h.writes) assert.deepEqual(body, h.writes[0]);
  }
});

test("REGISTER preparation includes concise readback guidance and corrections still require fresh consent", async () => {
  const h = harness({ patients: [] });
  const draft = z.object({ registration_id: z.string() }).parse(await h.execute("collect_registration", {
    fields: registrationDetails,
  }));
  const input = { request: { action: "REGISTER", registration_id: draft.registration_id } };
  const prepared = z.object({
    proposal_id: z.string(), instruction: z.string(), readback_guidance: z.record(z.string(), z.string()),
  }).parse(await h.execute("prepare_action", input));
  assert.deepEqual(prepared.readback_guidance, registrationReadbackGuidance);
  assert.match(prepared.instruction, /concise initial summary/);
  assert.match(prepared.instruction, /repeat only changed or unclear fields/);
  assert.match(prepared.instruction, /rest unchanged/);
  assert.match(prepared.instruction, /fragmented correction finish/);
  for (const value of Object.values(registrationDetails)) {
    assert.ok(!JSON.stringify(prepared.readback_guidance).includes(value));
  }
  h.nextTurn();
  await h.execute("collect_registration", {
    registration_id: draft.registration_id, fields: { email: "corrected.fragment@example.test" },
  });
  const corrected = z.object({
    proposal_id: z.string(), readback_guidance: z.record(z.string(), z.string()),
  }).parse(await h.execute("prepare_action", input));
  assert.notEqual(corrected.proposal_id, prepared.proposal_id);
  assert.deepEqual(corrected.readback_guidance, registrationReadbackGuidance);
  await assert.rejects(h.execute("confirm_action", { proposal_id: prepared.proposal_id, confirmed: true }),
    { code: "proposal_not_found" });
  await assert.rejects(h.execute("confirm_action", { proposal_id: corrected.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: corrected.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{
    call_id: "real-call-from-start", ...registrationDetails, email: "corrected.fragment@example.test",
  }]);
});

test("registration readback guidance does not leak into other prepared action returns", async () => {
  for (const action of ["BOOK", "RESCHEDULE"] as const) {
    const h = harness();
    const draft = await proposeScheduling(h, action);
    const repeated = z.record(z.string(), z.unknown()).parse(
      await h.execute("prepare_action", { request: draft.request }),
    );
    assert.ok(!Object.hasOwn(repeated, "readback_guidance"));
  }
  const h = harness();
  await identify(h);
  await h.execute("list_appointments", { patient_id: patient.patient_id });
  const cancelled = z.record(z.string(), z.unknown()).parse(await h.execute("prepare_action", {
    request: { action: "CANCEL", appointment_id: appointment.appointment_id },
  }));
  assert.ok(!Object.hasOwn(cancelled, "readback_guidance"));
});

test("identical BOOK preparation reuses the unsubmitted proposal and original prepared turn", async () => {
  const h = harness();
  await identify(h);
  const result = await searchBooking(h);
  assert.ok(result.booking_proposal);
  const input = { request: {
    action: "BOOK", patient_id: patient.patient_id,
    slot_id: result.booking_proposal.slot_id, policy_id: patient.insurer,
  } };
  for (const laterTurn of [false, true]) {
    if (laterTurn) h.nextTurn();
    const repeated = z.object({
      proposal_id: z.string(), unchanged: z.literal(true), instruction: z.string(),
    }).parse(await h.execute("prepare_action", input));
    assert.equal(repeated.proposal_id, result.booking_proposal.proposal_id);
    assert.match(repeated.instruction, /original preparation turn/);
    if (!laterTurn) {
      await assert.rejects(h.execute("confirm_action", { proposal_id: repeated.proposal_id, confirmed: true }),
        { code: "confirmation_requires_new_turn" });
    }
  }
  assert.equal(h.records.filter((event) =>
    typeof event === "object" && event !== null && "stage" in event && event.stage === "proposed").length, 1);
  assert.equal(h.writes.length, 0);
  await h.execute("confirm_action", { proposal_id: result.booking_proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
});

test("identical REGISTER preparation in the same revision preserves its original consent boundary", async () => {
  const h = harness({ patients: [] });
  const draft = z.object({ registration_id: z.string() }).parse(await h.execute("collect_registration", {
    fields: registrationDetails,
  }));
  const input = { request: { action: "REGISTER", registration_id: draft.registration_id } };
  const original = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", input));
  await h.execute("collect_registration", {
    registration_id: draft.registration_id, fields: { email: registrationDetails.email },
  });
  const repeated = z.object({
    proposal_id: z.string(), unchanged: z.literal(true), readback_guidance: z.record(z.string(), z.string()),
  }).parse(await h.execute("prepare_action", input));
  assert.equal(repeated.proposal_id, original.proposal_id);
  assert.deepEqual(repeated.readback_guidance, registrationReadbackGuidance);
  await assert.rejects(h.execute("confirm_action", { proposal_id: repeated.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  const afterConsent = z.object({ proposal_id: z.string(), unchanged: z.literal(true) }).parse(
    await h.execute("prepare_action", input),
  );
  assert.equal(afterConsent.proposal_id, original.proposal_id);
  assert.equal(h.records.filter((event) =>
    typeof event === "object" && event !== null && "stage" in event && event.stage === "proposed").length, 1);
  await h.execute("confirm_action", { proposal_id: afterConsent.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{ call_id: "real-call-from-start", ...registrationDetails }]);
});

test("restoring an earlier registration payload after corrections cannot reuse its old revision or turn", async () => {
  const h = harness({ patients: [] });
  const draft = z.object({ registration_id: z.string() }).parse(await h.execute("collect_registration", {
    fields: registrationDetails,
  }));
  const input = { request: { action: "REGISTER", registration_id: draft.registration_id } };
  const original = z.object({ proposal_id: z.string(), action: z.unknown() }).parse(
    await h.execute("prepare_action", input),
  );
  h.nextTurn();
  for (const email of ["changed.fragment@example.test", registrationDetails.email]) {
    await h.execute("collect_registration", { registration_id: draft.registration_id, fields: { email } });
  }
  const restored = z.object({
    proposal_id: z.string(), action: z.unknown(), unchanged: z.boolean().optional(),
  }).parse(await h.execute("prepare_action", input));
  assert.deepEqual(restored.action, original.action);
  assert.notEqual(restored.proposal_id, original.proposal_id);
  assert.equal(restored.unchanged, undefined);
  await assert.rejects(h.execute("confirm_action", { proposal_id: restored.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  assert.equal(h.writes.length, 0);
});

test("identical appointment payloads in different requests never reuse a prepared turn", async () => {
  for (const action of ["BOOK", "RESCHEDULE"] as const) {
    const h = harness();
    const first = await proposeScheduling(h, action);
    h.nextTurn();
    const separate = await proposeScheduling(h, action, { new_request: true });
    assert.notEqual(separate.request_id, first.request_id);
    assert.notEqual(separate.proposal_id, first.proposal_id);
    await assert.rejects(h.execute("confirm_action", { proposal_id: separate.proposal_id, confirmed: true }),
      { code: "confirmation_requires_new_turn" });
    assert.equal(h.writes.length, 0);
  }
});

test("re-searching an identical BOOK request still invalidates its old proposal and needs new consent", async () => {
  const h = harness();
  await identify(h);
  const first = await searchBooking(h);
  assert.ok(first.booking_proposal);
  h.nextTurn();
  const second = await searchBooking(h, { request_id: first.request_id });
  assert.ok(second.booking_proposal);
  assert.deepEqual(second.booking_proposal.action, first.booking_proposal.action);
  assert.notEqual(second.booking_proposal.proposal_id, first.booking_proposal.proposal_id);
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: first.booking_proposal.proposal_id, confirmed: true,
  }), { code: "proposal_not_found" });
  await assert.rejects(h.execute("confirm_action", {
    proposal_id: second.booking_proposal.proposal_id, confirmed: true,
  }), { code: "confirmation_requires_new_turn" });
  assert.equal(h.writes.length, 0);
});

test("late first preparation and failed proposals never inherit an earlier confirmation turn", async () => {
  for (const failed of [false, true]) {
    const h = harness({ post: async () => new Response(null, { status: 422 }) });
    await identify(h);
    const choices = bookingSearchSchema.parse(await h.execute("search_availability", {
      patient_id: patient.patient_id, specialty_id: slot.specialty_id,
    }));
    const input = { request: {
      action: "BOOK", patient_id: patient.patient_id, slot_id: choices.slots[0]?.slot_id, policy_id: patient.insurer,
    } };
    let previous: string | undefined;
    if (failed) previous = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", input)).proposal_id;
    h.nextTurn();
    if (previous) {
      await assert.rejects(h.execute("confirm_action", { proposal_id: previous, confirmed: true }),
        { code: "prosper_http_422" });
    }
    const prepared = z.object({ proposal_id: z.string(), unchanged: z.boolean().optional() }).parse(
      await h.execute("prepare_action", input),
    );
    assert.notEqual(prepared.proposal_id, previous);
    assert.equal(prepared.unchanged, undefined);
    await assert.rejects(h.execute("confirm_action", { proposal_id: prepared.proposal_id, confirmed: true }),
      { code: "confirmation_requires_new_turn" });
    assert.equal(h.writes.length, failed ? 1 : 0);
  }
});

test("failed date resolution records only private whitelisted search context, not the caller phrase in errors", async () => {
  const h = harness();
  await identify(h);
  const first = await searchBooking(h);
  const phrase = "when the lunar calendar feels lucky";
  const selected = {
    request_id: first.request_id, date_phrase: phrase,
    specialty_id: slot.specialty_id, provider_id: slot.provider_id, location_id: slot.location_id,
    time_of_day: "morning", weekday: "monday", language: "en",
  };
  await assert.rejects(h.execute("search_availability", {
    ...selected, patient_id: patient.patient_id, prepare_booking: true,
  }), (error: unknown) => error instanceof Error && "code" in error &&
    error.code === "unknown_date_phrase" && !error.message.includes(phrase));
  const failure = z.object({
    type: z.literal("tool"), name: z.literal("search_availability"), status: z.literal("error"),
    details: z.object({ search: z.record(z.string(), z.string()) }),
  }).parse(h.records.at(-1));
  assert.deepEqual(failure.details.search, selected);
  assert.equal(h.writes.length, 0);
});

test("failed search diagnostics bound whitelisted strings and omit demographics secrets and control values", async () => {
  const h = harness();
  const args = {
    patient_id: "PATIENT_VALUE_NOT_FOR_DIAGNOSTICS",
    date_phrase: "p".repeat(2_000), date_from: "f".repeat(2_000), date_to: { secret: "DATE_OBJECT_SENTINEL" },
    request_id: "r".repeat(2_000), specialty_id: "s".repeat(2_000),
    provider_id: "d".repeat(2_000), location_id: "l".repeat(2_000),
    time_of_day: "t".repeat(2_000), weekday: ["WEEKDAY_ARRAY_SENTINEL"], language: "e".repeat(2_000),
    name: "NAME_SENTINEL", national_id: "NATIONAL_ID_SENTINEL", phone: "PHONE_SENTINEL",
    date_of_birth: "BIRTH_DATE_SENTINEL", email: "EMAIL_SENTINEL",
    authorization: "AUTH_SENTINEL", headers: { authorization: "HEADER_SENTINEL" },
    additional_policy: "privado", no_other_policy: true, prepare_booking: true, new_request: true,
    nearest_origin_id: "ORIGIN_SENTINEL", relax_constraints: ["provider"], call_id: "CALL_OVERRIDE_SENTINEL",
  };
  await assert.rejects(h.execute("search_availability", args), { code: "invalid_tool_arguments" });
  const failure = z.object({
    details: z.object({
      search: z.record(z.string(), z.string()), truncated_fields: z.array(z.string()),
      validation_issues: z.array(z.object({ path: z.string(), code: z.string() })),
    }),
  }).parse(h.records.at(-1));
  assert.deepEqual(failure.details.search, {
    date_phrase: "p".repeat(150), date_from: "f".repeat(32), request_id: "r".repeat(128),
    specialty_id: "s".repeat(128), provider_id: "d".repeat(128), location_id: "l".repeat(128),
    time_of_day: "t".repeat(16), language: "e".repeat(16),
  });
  assert.deepEqual(failure.details.truncated_fields, Object.keys(failure.details.search));
  assert.ok(failure.details.validation_issues.length > 0);
  const serialized = JSON.stringify(h.records.at(-1));
  for (const excluded of [
    args.patient_id, args.name, args.national_id, args.phone, args.date_of_birth, args.email,
    args.authorization, args.headers.authorization, args.nearest_origin_id, args.call_id,
    "DATE_OBJECT_SENTINEL", "WEEKDAY_ARRAY_SENTINEL", "privado",
  ]) assert.ok(!serialized.includes(excluded));
  assert.ok(!Object.hasOwn(failure.details, "arguments"));
  assert.ok(!Object.hasOwn(failure.details, "raw_arguments"));
  assert.ok(JSON.stringify(failure.details.search).length < 1_100);
  assert.equal(h.writes.length, 0);
});

test("malformed non-object or non-string failed-search inputs never become raw private argument dumps", async () => {
  for (const input of [
    "{ BROKEN_JSON_SENTINEL", JSON.stringify(["ARRAY_SENTINEL"]),
    JSON.stringify({ date_phrase: { name: "OBJECT_SENTINEL" }, date_from: 20260922 }),
  ]) {
    const h = harness();
    await assert.rejects(h.engine.execute("search_availability", input, 1), { code: "invalid_tool_arguments" });
    const record = z.object({
      details: z.object({ validation_issues: z.array(z.unknown()), search: z.unknown().optional() }),
    }).parse(h.records.at(-1));
    assert.equal(record.details.search, undefined);
    assert.ok(!JSON.stringify(h.records).includes("SENTINEL"));
  }
  const h = harness();
  await assert.rejects(h.execute("find_patient", {
    name: "NAME_SENTINEL", date_of_birth: "INVALID_DATE_SENTINEL",
  }), { code: "invalid_tool_arguments" });
  const other = z.object({ details: z.object({ search: z.unknown().optional() }) }).parse(h.records.at(-1));
  assert.equal(other.details.search, undefined);
  assert.ok(!JSON.stringify(h.records).includes("SENTINEL"));
});
