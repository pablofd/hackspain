import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { ProsperClient } from "../src/prosper.js";
import type { ProsperAction } from "../src/prosper-types.js";

const clinic = {
  clinic_name: "Test clinic", patient_count: 0,
  calendar: { starts: "2026-09-07", ends: "2026-10-16", max_span_days: 14, slot_minutes: 15, closure_days: [] },
  locations: [{ id: "centro", name: "Centro", address: "Synthetic site", latitude: 40.4, longitude: -3.7, hours: [] }], providers: [], specialties: [],
  appointment_types: [], plans: [], restrictions: [],
};
const settings = { PROSPER_API_BASE_URL: "https://clinic.example", PROSPER_API_KEY: "test-only-key" };

test("clinic requests are read-only, authenticated, non-redirecting and cached", async () => {
  let count = 0;
  const request: typeof fetch = async (input, init) => {
    count += 1;
    assert.equal(String(input), "https://clinic.example/api/v1/clinic");
    assert.equal(init?.method, undefined);
    assert.equal(new Headers(init?.headers).get("X-Api-Key"), settings.PROSPER_API_KEY);
    assert.equal(init?.redirect, "error");
    return Response.json(clinic);
  };
  const client = new ProsperClient(settings, request);
  assert.equal((await client.getClinic(ROOT_CONTEXT, new AbortController().signal)).locations.length, 1);
  await client.getClinic(ROOT_CONTEXT, new AbortController().signal);
  assert.equal(count, 1);
});

test("upstream failures never become an empty successful clinic or expose response bodies", async () => {
  const failed = new ProsperClient(settings, async () => new Response("private upstream detail", { status: 403 }));
  await assert.rejects(failed.getClinic(ROOT_CONTEXT, new AbortController().signal), { message: "prosper_http_403" });
  const malformed = new ProsperClient(settings, async () => Response.json({ wrong: true }));
  await assert.rejects(malformed.getClinic(ROOT_CONTEXT, new AbortController().signal), { message: "prosper_invalid_clinic" });
});

test("a 200 with an invalid or wrong-call receipt is an unknown write outcome, never a confirmed booking", async () => {
  const action: ProsperAction = {
    action: "BOOK", patient_id: "PTEST", provider_id: "PRTEST", location_id: "centro",
    appointment_type_id: "review", slot: "2026-09-19T11:00:00+02:00", policy_id: "mapfre",
  };
  for (const response of [
    new Response("not json", { status: 200 }),
    Response.json({
      call_id: "someone-else", received_at: "2026-09-18T18:00:00Z", record: { actions: [action] },
    }),
  ]) {
    const client = new ProsperClient(settings, async () => response);
    await assert.rejects(client.submit("real-call", action, ROOT_CONTEXT, new AbortController().signal), {
      message: "prosper_submission_unknown",
    });
  }
});
