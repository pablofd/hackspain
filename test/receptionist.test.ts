import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { z } from "zod";
import { ProsperClient, type Clinic } from "../src/prosper.js";
import { actionSchema, type Availability, type ProsperAction, type Slot, type Patient } from "../src/prosper-types.js";
import type { AddressResolver } from "../src/geography.js";
import { ConfirmationGate } from "../src/confirmation.js";
import { Receptionist, receptionistInstructions, receptionistTools } from "../src/receptionist.js";

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

function harness(options: {
  callId?: string;
  allowSubmissions?: boolean;
  slots?: typeof slot[];
  post?: (body: Record<string, unknown>, attempt: number) => Promise<Response>;
  patients?: typeof patient[];
  appointments?: typeof appointment[];
  clinic?: typeof clinic;
  availability?: (query: URL) => Availability | Promise<Availability>;
  directory?: (query: URL) => Patient[];
  addressResolver?: Pick<AddressResolver, "resolve">;
  startedAt?: Date;
  beforeConfirmation?: (turn: number) => Promise<void>;
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
      if (options.post) return options.post(body, writes.length);
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
  await proposeBooking(abandoned);
  abandoned.controller.abort();
  await abandoned.engine.close();
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
