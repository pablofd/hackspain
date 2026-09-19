import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { z } from "zod";
import type { CallRecordEvent } from "../src/call-records.js";
import { AppError } from "../src/errors.js";
import { ProsperClient, type Clinic } from "../src/prosper.js";
import { actionSchema, type Availability, type Patient, type ProsperAction, type Slot } from "../src/prosper-types.js";
import { Receptionist, receptionistInstructions, receptionistTools } from "../src/receptionist.js";
import { registrationFieldNames, registrationGuidance, registrationReadbackGuidance } from "../src/registration.js";

const demographics = {
  given_name: "Nueva", first_surname: "Prueba", second_surname: "Ejemplo",
  national_id: "12345678Z", date_of_birth: "1988-03-14", phone: "+34612345678",
  email: "nueva@example.test", insurer: "mapfre",
};
const existing: Patient = {
  patient_id: "PEXISTING", given_name: "Existing", first_surname: "Example", second_surname: "Test",
  national_id: "00000000T", date_of_birth: "1988-03-14", phone: "699999999",
  has_visited_before: true, insurer: "mapfre", referrals: [], note: "",
  matched_fields: ["name", "national_id", "date_of_birth"],
};
const slot: Slot = {
  provider_id: "PRTEST", provider_name: "Test Doctor", specialty_id: "general_practice",
  location_id: "centro", appointment_type_id: "review", start_time: "2026-09-19T11:00:00+02:00",
  duration_minutes: 15, payable_with: ["mapfre"],
};
const clinic: Clinic = {
  clinic_name: "Synthetic Clinic", patient_count: 1,
  calendar: { starts: "2026-09-07", ends: "2026-10-16", max_span_days: 14, slot_minutes: 15, closure_days: [] },
  locations: [{
    id: "centro", name: "Test Site", address: "Synthetic site", latitude: 40.4, longitude: -3.7,
    hours: [{ weekday: "saturday", intervals: ["09:00-14:00"] }],
  }],
  providers: [{
    id: "PRTEST", name: "Test Doctor", specialty_id: "general_practice", languages: ["en"],
    schedules: [{ location_id: "centro", location_name: "Test Site", days: [
      { weekday: "saturday", intervals: ["09:00-14:00"] },
    ] }], leave: null,
  }],
  specialties: [{ id: "general_practice", name: "General Practice", min_age_months: 168, max_age_months: null, referral_required: false }],
  appointment_types: [{ id: "review", name: "Review" }],
  plans: [{ id: "mapfre", name: "Mapfre" }], restrictions: [],
};

function harness(options: {
  directory?: (url: URL) => Patient[] | Promise<Patient[]>;
  beforeClinic?: () => Promise<void>;
  beforeConfirmation?: (turn: number) => Promise<void>;
  beforeOutcome?: (turn: number, reason: string) => Promise<void>;
  post?: (body: Record<string, unknown>, attempt: number) => Promise<Response | undefined>;
  slots?: Slot[];
  blocked?: Availability["blocked"];
} = {}) {
  let turn = 1;
  const requests: URL[] = [];
  const writes: Record<string, unknown>[] = [];
  const actions: ProsperAction[] = [];
  const records: CallRecordEvent[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://clinic.example.test");
    requests.push(url);
    if (init?.method === "POST") {
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body)));
      writes.push(body);
      const response = await options.post?.(body, writes.length);
      if (response) return response;
      const { call_id, ...fields } = body;
      const action = url.pathname.split("/").at(-1)?.toUpperCase().replace("-", "_");
      actions.push(actionSchema.parse(action === "REGISTER" ? { action, new_patient: fields } : { action, ...fields }));
      return Response.json({ call_id, received_at: "2026-09-18T12:00:00Z", record: { actions } });
    }
    if (url.pathname.endsWith("/directory")) return Response.json({ matches: await options.directory?.(url) ?? [] });
    if (url.pathname.endsWith("/clinic")) {
      await options.beforeClinic?.();
      return Response.json(clinic);
    }
    if (url.pathname.endsWith("/availability")) return Response.json({
      providers: [{ id: "PRTEST", name: "Test Doctor", specialty_id: "general_practice", languages: ["en"] }],
      appointment_type: { id: "review", name: "Review", duration_minutes: 15, guidance: "Synthetic returning patient" },
      slots: (options.slots ?? [slot]).filter((item) =>
        item.start_time.slice(0, 10) >= (url.searchParams.get("date_from") ?? "") &&
        item.start_time.slice(0, 10) <= (url.searchParams.get("date_to") ?? "")),
      blocked: options.blocked ?? [],
    });
    throw new Error("Unexpected synthetic endpoint");
  };
  const engine = new Receptionist(new ProsperClient({
    PROSPER_API_BASE_URL: "https://clinic.example.test", PROSPER_API_KEY: "synthetic-test-key",
  }, fetcher), {
    callId: "synthetic-registration-call", startedAt: new Date("2026-09-18T12:00:00Z"),
    parent: ROOT_CONTEXT, signal: new AbortController().signal, allowSubmissions: true,
    generation: () => turn, record: (event) => records.push(event),
    ...(options.beforeConfirmation ? { beforeConfirmation: options.beforeConfirmation } : {}),
    ...(options.beforeOutcome ? { beforeOutcome: options.beforeOutcome } : {}),
  });
  return {
    engine, records, requests, writes, actions,
    nextTurn: () => { turn += 1; },
    execute: (name: string, args: unknown) => engine.execute(name, JSON.stringify(args), turn),
  };
}
type Harness = ReturnType<typeof harness>;
const collectionSchema = z.object({
  registration_id: z.string(), revision: z.number(), ready: z.boolean(),
  missing_fields: z.array(z.string()), invalid_fields: z.array(z.string()),
  validation_issues: z.array(z.object({ path: z.string(), code: z.string() })),
  next_question: z.object({ group: z.string(), fields: z.array(z.string()), question: z.string() }).nullable(),
  remaining_groups: z.array(z.object({ group: z.string(), fields: z.array(z.string()) })),
  instruction: z.string(),
});
const proposalSchema = z.object({ proposal_id: z.string(), registration_id: z.string() });
const collect = async (h: Harness, args: unknown = {}) =>
  collectionSchema.parse(await h.execute("collect_registration", args));
const prepare = async (h: Harness, id: string) =>
  proposalSchema.parse(await h.execute("prepare_action", { request: { action: "REGISTER", registration_id: id } }));

test("registration collects three short missing-field groups, with no lookup before preparation", async () => {
  const h = harness();
  const start = await collect(h);
  assert.deepEqual(start.missing_fields, registrationFieldNames);
  assert.deepEqual(start.remaining_groups.map(({ group }) => group), ["identity", "demographics", "contact_and_plan"]);
  assert.equal(start.next_question?.fields.length, 4);
  const id = start.registration_id;
  const identity = await collect(h, { registration_id: id, fields: {
    given_name: demographics.given_name, first_surname: demographics.first_surname,
    second_surname: demographics.second_surname, national_id: demographics.national_id,
  } });
  assert.deepEqual(identity.next_question?.fields, ["date_of_birth", "phone"]);
  const contact = await collect(h, { registration_id: id, fields: {
    date_of_birth: demographics.date_of_birth, phone: demographics.phone,
  } });
  assert.deepEqual(contact.next_question?.fields, ["email", "insurer"]);
  const ready = await collect(h, { registration_id: id, fields: { email: demographics.email, insurer: demographics.insurer } });
  assert.equal(ready.ready, true);
  assert.equal(ready.next_question, null);
  assert.match(ready.instruction, /prepare_action.*before reading the final summary/i);
  assert.equal(h.requests.length, 0);
  assert.equal(h.records.some((event) => event.type === "action"), false);

  const proposal = await prepare(h, id);
  assert.equal(h.requests.filter((url) => url.pathname.endsWith("/directory")).length, 1);
  assert.equal(h.writes.length, 0);
  await assert.rejects(h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{ call_id: "synthetic-registration-call", ...demographics, phone: "612345678" }]);
  assert.equal(JSON.stringify(h.writes).includes("registration_id"), false);
});

test("missing insurer/email remains missing instead of becoming a private-pay or guessed plan", async () => {
  const h = harness();
  const { insurer: _insurer, email: _email, ...partial } = demographics;
  const draft = await collect(h, { fields: partial });
  assert.equal(draft.ready, false);
  assert.deepEqual(draft.missing_fields, ["email", "insurer"]);
  await assert.rejects(prepare(h, draft.registration_id), { code: "registration_incomplete" });
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 0);
  const emailOnly = await collect(h, { fields: { email: demographics.email } });
  assert.deepEqual(emailOnly.next_question?.fields, ["insurer"]);
  assert.equal(emailOnly.registration_id, draft.registration_id);
});

test("invalid demographics produce safe field paths/codes and never manufacture corrected values", async () => {
  const h = harness();
  const invalid = {
    ...demographics, national_id: "12345678A", phone: "unclear-number", email: "unclear-email",
    date_of_birth: "2026-02-30", insurer: "unknown-plan",
  };
  const draft = await collect(h, { fields: invalid });
  assert.deepEqual(draft.invalid_fields, ["national_id", "date_of_birth", "phone", "email", "insurer"]);
  assert.deepEqual(draft.next_question?.fields, ["national_id"]);
  await assert.rejects(prepare(h, draft.registration_id), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /national_id/);
    for (const value of Object.values(invalid)) assert.equal(error.message.includes(value), false);
    return true;
  });
  for (const event of h.records) {
    assert.equal(event.type === "action", false);
    for (const value of Object.values(invalid)) assert.equal(JSON.stringify(event).includes(value), false);
  }
  const ready = await collect(h, { registration_id: draft.registration_id, fields: demographics });
  assert.equal(ready.ready, true);
  assert.equal(h.requests.length, 0);
});

test("future and invalid birth dates remain rejected; partial fragments retain the other supplied fields", async () => {
  const h = harness();
  const draft = await collect(h, { fields: { ...demographics, date_of_birth: "2027-01-01", phone: "6" } });
  assert.deepEqual(draft.invalid_fields, ["date_of_birth", "phone"]);
  assert.ok(draft.validation_issues.some((issue) => issue.path === "date_of_birth" && issue.code === "invalid_birth_date"));
  const changed = await collect(h, { registration_id: draft.registration_id, fields: { phone: demographics.phone } });
  assert.deepEqual(changed.next_question?.fields, ["date_of_birth"]);
  await assert.rejects(prepare(h, draft.registration_id), { code: "invalid_birth_date" });
  assert.equal((await collect(h, { registration_id: draft.registration_id, fields: {
    date_of_birth: demographics.date_of_birth,
  } })).ready, true);
  assert.equal(h.writes.length, 0);
});

test("registration intent persists through no-match lookups and blocks patient_not_found instead of registering by default", async () => {
  const h = harness();
  const draft = await collect(h);
  const result = z.object({ registration_intent: z.literal(true), instruction: z.string() }).parse(
    await h.execute("find_patient", { name: "Nueva Prueba Ejemplo", national_id: demographics.national_id }),
  );
  assert.match(result.instruction, /continue collect_registration/i);
  await assert.rejects(h.execute("report_outcome", { action: "NO_ACTION", reason: "patient_not_found" }),
    { code: "registration_in_progress" });
  assert.equal((await collect(h, { registration_id: draft.registration_id })).ready, false);
  assert.equal(h.writes.length, 0);

  const legacy = harness();
  await assert.rejects(legacy.execute("prepare_action", { request: {
    action: "register", new_patient: { given_name: demographics.given_name },
  } }), { code: "invalid_tool_arguments" });
  await legacy.execute("find_patient", { name: "Nueva Prueba Ejemplo", national_id: demographics.national_id });
  await assert.rejects(legacy.execute("report_outcome", { action: "NO_ACTION", reason: "patient_not_found" }),
    { code: "registration_in_progress" });
  assert.equal(legacy.writes.length, 0);
});

test("duplicate detection still runs before a complete registration is proposed", async () => {
  const h = harness({ directory: (url) => {
    assert.equal(url.searchParams.get("national_id"), demographics.national_id);
    return [existing];
  } });
  const draft = await collect(h, { fields: { ...demographics, national_id: " 1234-5678-z " } });
  await assert.rejects(prepare(h, draft.registration_id), { code: "patient_already_exists" });
  assert.equal(h.requests.filter((url) => url.pathname.endsWith("/directory")).length, 1);
  assert.equal(h.records.some((event) => event.type === "action"), false);
  assert.equal(h.writes.length, 0);
});

test("changing a DNI invalidates only its registration proposal and requires fresh preparation/consent", async () => {
  const h = harness();
  const first = await collect(h, { fields: demographics });
  const firstProposal = await prepare(h, first.registration_id);
  const second = await collect(h, { new_registration: true, fields: {
    ...demographics, given_name: "Otra", national_id: "00000000T", email: "otra@example.test",
  } });
  const secondProposal = await prepare(h, second.registration_id);
  await assert.rejects(collect(h, { fields: { email: "ambiguous@example.test" } }), { code: "registration_id_required" });
  h.nextTurn();
  await collect(h, { registration_id: first.registration_id, fields: { national_id: "X0000000T" } });
  await assert.rejects(h.execute("confirm_action", { proposal_id: firstProposal.proposal_id, confirmed: true }),
    { code: "proposal_not_found" });
  await h.execute("confirm_action", { proposal_id: secondProposal.proposal_id, confirmed: true });
  const replacement = await prepare(h, first.registration_id);
  await assert.rejects(h.execute("confirm_action", { proposal_id: replacement.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: replacement.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1]?.national_id, "X0000000T");
});

test("clearing or invalidating a collected field removes stale proposals without losing other fields", async () => {
  const h = harness();
  const draft = await collect(h, { fields: demographics });
  const proposal = await prepare(h, draft.registration_id);
  const cleared = await collect(h, { registration_id: draft.registration_id, fields: { insurer: null } });
  assert.deepEqual(cleared.missing_fields, ["insurer"]);
  h.nextTurn();
  await assert.rejects(h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true }),
    { code: "proposal_not_found" });
  await collect(h, { registration_id: draft.registration_id, fields: { insurer: demographics.insurer } });
  const next = await prepare(h, draft.registration_id);
  await assert.rejects(collect(h, { registration_id: draft.registration_id, fields: { phone: 123 } }),
    { code: "invalid_tool_arguments" });
  assert.deepEqual((await collect(h, { registration_id: draft.registration_id })).missing_fields, ["phone"]);
  h.nextTurn();
  await assert.rejects(h.execute("confirm_action", { proposal_id: next.proposal_id, confirmed: true }),
    { code: "proposal_not_found" });
  assert.equal(h.writes.length, 0);
});

test("direct new_patient remains supported and returns a stable reference for identity corrections", async () => {
  const h = harness();
  const original = proposalSchema.parse(await h.execute("prepare_action", { request: {
    action: "REGISTER", new_patient: demographics,
  } }));
  const corrected = proposalSchema.parse(await h.execute("prepare_action", { request: {
    action: "REGISTER", new_patient: { ...demographics, national_id: "X0000000T" },
  } }));
  assert.equal(corrected.registration_id, original.registration_id);
  h.nextTurn();
  await assert.rejects(h.execute("confirm_action", { proposal_id: original.proposal_id, confirmed: true }),
    { code: "proposal_not_found" });
  await h.execute("confirm_action", { proposal_id: corrected.proposal_id, confirmed: true });
  assert.deepEqual(h.writes, [{
    call_id: "synthetic-registration-call", ...demographics, national_id: "X0000000T", phone: "612345678",
  }]);
  await assert.rejects(collect(h, { registration_id: corrected.registration_id, fields: { email: "changed@example.test" } }),
    { code: "action_already_submitted" });
  await assert.rejects(h.execute("prepare_action", { request: {
    action: "REGISTER", new_patient: { ...demographics, national_id: "00000000T" },
  } }), { code: "registration_id_required" });
  assert.equal(h.writes.length, 1);
  const state = await collect(h, { registration_id: corrected.registration_id });
  assert.equal(state.ready, true);
  const nextPatient = await collect(h, { new_registration: true });
  assert.notEqual(nextPatient.registration_id, state.registration_id);
});

test("in-flight and uncertain submissions cannot be edited; only identical delivery can be retried", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = harness({ post: async (_body, attempt) => {
    if (attempt === 1) { entered.resolve(); await release.promise; }
    return attempt < 3 ? new Response(null, { status: 503 }) : undefined;
  } });
  const draft = await collect(h, { fields: demographics });
  const proposal = await prepare(h, draft.registration_id);
  h.nextTurn();
  const submitting = h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  await entered.promise;
  await assert.rejects(collect(h, { registration_id: draft.registration_id, fields: { email: "changed@example.test" } }),
    { code: "action_already_submitted" });
  release.resolve();
  await assert.rejects(submitting, { code: "prosper_submission_unknown" });
  await assert.rejects(collect(h, { registration_id: draft.registration_id, fields: { insurer: null } }),
    { code: "action_already_submitted" });
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 3);
  assert.deepEqual(h.writes[0], h.writes[1]);
  assert.deepEqual(h.writes[0], h.writes[2]);
});

test("a correction during async preparation cannot produce a stale registration proposal", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = harness({ beforeClinic: async () => { entered.resolve(); await release.promise; } });
  const draft = await collect(h, { fields: demographics });
  const preparing = prepare(h, draft.registration_id);
  await entered.promise;
  await collect(h, { registration_id: draft.registration_id, fields: { email: "corrected@example.test" } });
  release.resolve();
  await assert.rejects(preparing, { code: "registration_changed" });
  assert.equal(h.records.some((event) => event.type === "action"), false);
  assert.equal(h.writes.length, 0);
});

test("a correction during confirmation review cannot submit the captured old proposal", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = harness({ beforeConfirmation: async () => { entered.resolve(); await release.promise; } });
  const draft = await collect(h, { fields: demographics });
  const proposal = await prepare(h, draft.registration_id);
  h.nextTurn();
  const confirming = h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  await entered.promise;
  await collect(h, { registration_id: draft.registration_id, fields: { email: "corrected@example.test" } });
  release.resolve();
  await assert.rejects(confirming, { code: "registration_changed" });
  assert.equal(h.writes.length, 0);
});

test("a registration neither blocks nor invalidates another verified patient's booking", async () => {
  const h = harness({ directory: (url) => url.searchParams.get("name") ? [existing] : [] });
  const draft = await collect(h, { fields: demographics });
  await h.execute("find_patient", { name: "Existing Example Test", national_id: existing.national_id });
  const available = z.object({ slots: z.array(z.object({ slot_id: z.string() })) }).parse(
    await h.execute("search_availability", { patient_id: existing.patient_id, specialty_id: "general_practice" }),
  );
  const booking = z.object({ proposal_id: z.string() }).parse(await h.execute("prepare_action", { request: {
    action: "BOOK", patient_id: existing.patient_id, slot_id: available.slots[0]!.slot_id, policy_id: "mapfre",
  } }));
  await collect(h, { registration_id: draft.registration_id, fields: { phone: null } });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: booking.proposal_id, confirmed: true });
  assert.equal(h.actions[0]?.action, "BOOK");
  assert.deepEqual((await collect(h, { registration_id: draft.registration_id })).missing_fields, ["phone"]);
});

test("a separate verified-patient refusal can coexist with a pending registration", async () => {
  const h = harness({ directory: (url) => url.searchParams.get("name") ? [existing] : [], slots: [] });
  const draft = await collect(h, { fields: demographics });
  await h.execute("find_patient", { name: "Existing Example Test", national_id: existing.national_id });
  const result = z.object({ request_id: z.string() }).parse(
    await h.execute("search_availability", { patient_id: existing.patient_id, specialty_id: "general_practice" }),
  );
  await h.execute("report_outcome", { action: "NO_ACTION", reason: "no_availability", request_id: result.request_id });
  const proposal = await prepare(h, draft.registration_id);
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.deepEqual(h.actions.map((action) => action.action), ["NO_ACTION", "REGISTER"]);
});

test("registration state is call-local and tool diagnostics never include rejected values or unknown keys", async () => {
  const first = harness();
  const known = await collect(first, { fields: demographics });
  const second = harness();
  await assert.rejects(prepare(second, known.registration_id), { code: "registration_not_found" });
  const empty = await collect(second);
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.missing_fields, registrationFieldNames);

  const h = harness();
  const invalid = { request: { action: "REGISTER", new_patient: { ...demographics, email: "sensitive-invalid-value" } } };
  await assert.rejects(h.execute("prepare_action", invalid), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /request\.new_patient\.email.*invalid_format/);
    assert.equal(error.message.includes("sensitive-invalid-value"), false);
    return true;
  });
  await assert.rejects(h.execute("collect_registration", { fields: { "sensitive-unknown-property": "sensitive-content" } }),
    { code: "invalid_tool_arguments" });
  await assert.rejects(h.engine.execute("collect_registration", "sensitive-invalid-json", 1),
    { code: "invalid_tool_arguments" });
  const errors = h.records.filter((event) => event.type === "tool" && event.status === "error");
  assert.equal(errors.length, 3);
  assert.ok(errors.every((event) => "details" in event && JSON.stringify(event.details).includes("validation_issues")));
  assert.equal(JSON.stringify(errors).includes("sensitive"), false);
});

test("registration tools and runtime instructions preserve explicit intent, short groups, pauses and consent", () => {
  const tool = receptionistTools.find(({ name }) => name === "collect_registration");
  assert.ok(tool);
  assert.doesNotThrow(() => JSON.stringify(tool.parameters));
  const instructions = receptionistInstructions(new Date("2026-09-18T12:00:00Z"), true);
  assert.match(instructions, /three short collection exchanges/);
  assert.match(instructions, /Allow long pauses and fragmented dictation/);
  assert.match(instructions, /Never invent an insurer or default to privado/);
  assert.match(instructions, /BEFORE the final readback/);
  assert.match(instructions, /new caller turn explicitly confirming/);
});

test("runtime guidance preserves alternatives, concise identity, explicit specialties and pricing uncertainty", () => {
  const instructions = receptionistInstructions(new Date("2026-09-18T12:00:00Z"), true);
  assert.match(instructions, /one concise question.*full name plus ONE identifier/);
  assert.match(instructions, /already volunteered phone or birth date/);
  assert.match(instructions, /Do not recite a menu/);
  assert.match(instructions, /explicitly requested specialty outranks routine symptom routing/);
  assert.match(instructions, /Emergency red flags still override scheduling/);
  assert.match(instructions, /answers only the policy question.*revise_request and search_availability/);
  assert.doesNotMatch(instructions, /only have this plan.*immediately call report_outcome/);
  assert.match(instructions, /exact copay amounts are not published/);
  assert.match(instructions, /Never promise zero cost/);
  assert.match(instructions, /deferring over an unknown price is not caller_not_authorised/);
});

test("outcome review waits before creating a refusal proposal and needs no extra confirmation turn", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reviews: { turn: number; reason: string }[] = [];
  const h = harness({ beforeOutcome: async (turn, reason) => {
    reviews.push({ turn, reason }); entered.resolve(); await release.promise;
  } });
  await h.execute("find_patient", { name: "Missing Synthetic Patient", national_id: demographics.national_id });
  const input = { action: "NO_ACTION", reason: "patient_not_found" };
  const reporting = h.execute("report_outcome", input);
  await entered.promise;
  assert.equal(h.writes.length, 0);
  assert.equal(h.records.some((event) => event.type === "action"), false);
  release.resolve();
  await reporting;
  await h.execute("report_outcome", input);
  assert.deepEqual(reviews, [{ turn: 1, reason: "patient_not_found" }]);
  assert.equal(h.writes.length, 1);
  assert.equal(h.actions[0]?.action, "NO_ACTION");
});

test("rejected outcome review leaves no refusal draft that could block registration preparation", async () => {
  const h = harness({ beforeOutcome: async () => { throw new AppError("outcome_requires_latest_turn"); } });
  await h.execute("find_patient", { name: "Missing Synthetic Patient", national_id: demographics.national_id });
  await assert.rejects(h.execute("report_outcome", { action: "NO_ACTION", reason: "patient_not_found" }),
    { code: "outcome_requires_latest_turn" });
  assert.equal(h.records.some((event) => event.type === "action"), false);
  const draft = await collect(h, { fields: demographics });
  await prepare(h, draft.registration_id);
  assert.equal(h.writes.length, 0);
});

test("a caller turn arriving during outcome review prevents the old refusal", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = harness({ beforeOutcome: async () => { entered.resolve(); await release.promise; } });
  await h.execute("find_patient", { name: "Missing Synthetic Patient", national_id: demographics.national_id });
  const reporting = h.execute("report_outcome", { action: "NO_ACTION", reason: "patient_not_found" });
  await entered.promise;
  h.nextTurn();
  release.resolve();
  await assert.rejects(reporting, { code: "stale_turn" });
  assert.equal(h.writes.length, 0);
  assert.equal(h.records.some((event) => event.type === "action"), false);
});

test("registration intent declared during outcome review is rechecked before submitting patient_not_found", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = harness({ beforeOutcome: async () => { entered.resolve(); await release.promise; } });
  await h.execute("find_patient", { name: "Missing Synthetic Patient", national_id: demographics.national_id });
  const reporting = h.execute("report_outcome", { action: "NO_ACTION", reason: "patient_not_found" });
  await entered.promise;
  await collect(h);
  release.resolve();
  await assert.rejects(reporting, { code: "registration_in_progress" });
  assert.equal(h.writes.length, 0);
  assert.equal(h.records.some((event) => event.type === "action"), false);
});

test("outcome review rechecks invalidated clinic evidence before submitting", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = harness({
    directory: () => [existing], slots: [],
    beforeOutcome: async () => { entered.resolve(); await release.promise; },
  });
  await h.execute("find_patient", { name: "Existing Example Test", national_id: existing.national_id });
  const request = z.object({ request_id: z.string() }).parse(
    await h.execute("search_availability", { patient_id: existing.patient_id, specialty_id: "general_practice" }),
  );
  const reporting = h.execute("report_outcome", { action: "NO_ACTION", reason: "no_availability", request_id: request.request_id });
  await entered.promise;
  await h.execute("revise_request", { request_id: request.request_id });
  release.resolve();
  await assert.rejects(reporting, { code: "outcome_requires_evidence" });
  assert.equal(h.writes.length, 0);
});

test("an unscoped refusal cannot switch to another request while awaiting outcome review", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = harness({
    directory: () => [existing], slots: [],
    beforeOutcome: async () => { entered.resolve(); await release.promise; },
  });
  await h.execute("find_patient", { name: "Existing Example Test", national_id: existing.national_id });
  const query = { patient_id: existing.patient_id, specialty_id: "general_practice" };
  await h.execute("search_availability", query);
  const reporting = h.execute("report_outcome", { action: "NO_ACTION", reason: "no_availability" });
  await entered.promise;
  await h.execute("search_availability", { ...query, new_request: true });
  release.resolve();
  await assert.rejects(reporting, { code: "outcome_context_changed" });
  assert.equal(h.writes.length, 0);
});

test("emergencies bypass outcome review even if the callback would reject", async () => {
  let reviewed = false;
  const h = harness({ beforeOutcome: async () => {
    reviewed = true;
    throw new AppError("unexpected_outcome_review");
  } });
  await h.execute("report_outcome", { action: "ESCALATE", reason: "medical_emergency" });
  assert.equal(reviewed, false);
  assert.equal(h.actions[0]?.action, "ESCALATE");
  assert.equal(h.writes.length, 1);
});

test("registration intent does not itself block privacy or caller-authorisation refusals", async () => {
  for (const reason of ["out_of_scope", "caller_not_authorised"]) {
    const reviews: string[] = [];
    const h = harness({ beforeOutcome: async (_turn, observedReason) => { reviews.push(observedReason); } });
    await collect(h);
    await h.execute("report_outcome", { action: "NO_ACTION", reason });
    assert.deepEqual(reviews, [reason]);
    assert.deepEqual(h.actions, [{ action: "NO_ACTION", reason }]);
  }
});

test("valid single-plan refusals need outcome review but no additional approval question", async () => {
  let reviews = 0;
  const h = harness({
    directory: () => [existing], slots: [],
    blocked: [{ provider_id: "PRTEST", restriction: "specialty_not_covered" }],
    beforeOutcome: async (_turn, reason) => { assert.equal(reason, "specialty_not_covered"); reviews += 1; },
  });
  await h.execute("find_patient", { name: "Existing Example Test", national_id: existing.national_id });
  const request = z.object({ request_id: z.string() }).parse(
    await h.execute("search_availability", { patient_id: existing.patient_id, specialty_id: "general_practice" }),
  );
  const input = { action: "NO_ACTION", reason: "specialty_not_covered", request_id: request.request_id };
  await assert.rejects(h.execute("report_outcome", input), { code: "other_policy_not_resolved" });
  assert.equal(reviews, 0);
  await h.execute("report_outcome", { ...input, no_other_policy: true });
  assert.equal(reviews, 1);
  assert.equal(h.writes.length, 1);
});

test("ready registrations supply concise readback and correction guidance without patient values", () => {
  const result = registrationGuidance({
    id: "registration-synthetic", revision: 3, fields: demographics,
  }, "2026-09-18");
  assert.equal(result.ready, true);
  assert.equal(result.next_question, null);
  assert.deepEqual(result.readback_guidance, registrationReadbackGuidance);
  assert.match(registrationReadbackGuidance.scope, /unsubmitted, prepared/);
  assert.match(registrationReadbackGuidance.correction, /Prepare again if any field changed/);
  assert.match(registrationReadbackGuidance.correction, /other details stay unchanged/);
  assert.match(registrationReadbackGuidance.clarification, /Let a fragmented correction finish/);
  assert.match(registrationReadbackGuidance.clarification, /do not restart a menu/);
  assert.match(registrationReadbackGuidance.email, /underscore, hyphen, dot and at/);
  assert.match(registrationReadbackGuidance.consent, /fresh explicit consent/);
  assert.match(registrationReadbackGuidance.consent, /alone is not permission to submit/);
  for (const value of Object.values(demographics)) {
    assert.equal(JSON.stringify(result.readback_guidance).includes(value), false);
  }
});

test("a surname-only correction does not reopen complete fields or weaken registration validation", () => {
  const corrected = { ...demographics, first_surname: "Corregida" };
  const draft = { id: "registration-synthetic", revision: 4, fields: corrected };
  const result = registrationGuidance(draft, "2026-09-18");
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing_fields, []);
  assert.deepEqual(result.invalid_fields, []);
  assert.deepEqual(result.remaining_groups, []);
  assert.deepEqual(draft.fields, corrected);
  const invalid = registrationGuidance({
    ...draft, fields: { ...corrected, national_id: "12345678A" },
  }, "2026-09-18");
  assert.equal(invalid.ready, false);
  assert.deepEqual(invalid.invalid_fields, ["national_id"]);
  assert.equal(invalid.readback_guidance, undefined);
  assert.equal(invalid.prepare_action, undefined);
});

test("repeating an unchanged value retains the proposal and readback guidance without skipping fresh consent", async () => {
  const h = harness();
  const draft = await collect(h, { fields: demographics });
  const proposal = await prepare(h, draft.registration_id);
  const result = z.object({
    ready: z.literal(true), proposal_id: z.string(), readback_guidance: z.object({ consent: z.string() }),
  }).parse(await h.execute("collect_registration", {
    registration_id: draft.registration_id, fields: { email: demographics.email },
  }));
  assert.equal(result.proposal_id, proposal.proposal_id);
  assert.equal(result.readback_guidance.consent, registrationReadbackGuidance.consent);
  assert.equal(h.records.filter((event) => event.type === "action" && event.stage === "proposed").length, 1);
  await assert.rejects(h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true }),
    { code: "confirmation_requires_new_turn" });
  h.nextTurn();
  await h.execute("confirm_action", { proposal_id: proposal.proposal_id, confirmed: true });
  assert.equal(h.writes.length, 1);
});
