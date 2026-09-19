import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
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

for (const method of ["GET", "POST"] as const) {
  for (const responseDelay of [16_000, 61_000]) {
    test(`${method} ${responseDelay === 16_000 ? "can finish beyond the old eight- and fifteen-second limits" : "aborts at the 60-second request deadline"}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      syncBuiltinESMExports();
      t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
      // AbortSignal.timeout uses internal timers; route them through the mocked clock.
      const timeouts = t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
        return controller.signal;
      });
      let requestSignal: AbortSignal | undefined;
      const client = new ProsperClient(settings, async (_input, init) => {
        assert.ok(init?.signal);
        requestSignal = init.signal;
        await delay(responseDelay, undefined, { signal: init.signal });
        return method === "GET" ? Response.json(clinic) : new Response(null, { status: 409 });
      });
      const action: ProsperAction = { action: "CANCEL", appointment_id: "ATEST" };
      const caller = new AbortController();
      const pending = method === "GET"
        ? client.getClinic(ROOT_CONTEXT, caller.signal)
        : client.submit("real-call", action, ROOT_CONTEXT, caller.signal);
      if (responseDelay === 16_000) {
        t.mock.timers.tick(8_001);
        assert.equal(requestSignal?.aborted, false);
        t.mock.timers.tick(7_000);
        assert.equal(requestSignal?.aborted, false);
        t.mock.timers.tick(999);
        assert.deepEqual(await pending, method === "GET" ? clinic : { status: "duplicate", action });
      } else {
        const rejected = assert.rejects(pending, {
          code: method === "GET" ? "prosper_network_error" : "prosper_submission_unknown",
        });
        t.mock.timers.tick(59_999);
        assert.equal(requestSignal?.aborted, false);
        t.mock.timers.tick(1);
        await rejected;
        assert.equal(requestSignal?.aborted, true);
      }
      assert.deepEqual(timeouts.mock.calls.map(({ arguments: args }) => args), [[60_000]]);
      assert.equal(caller.signal.aborted, false);
    });
  }
}

test("caller cancellation immediately aborts reads and prevents new requests", async () => {
  let requestSignal: AbortSignal | undefined;
  let requests = 0;
  const client = new ProsperClient(settings, async (_input, init) => {
    requests += 1;
    assert.ok(init?.signal);
    const signal = init.signal;
    requestSignal = signal;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const caller = new AbortController();
  const pending = assert.rejects(client.getClinic(ROOT_CONTEXT, caller.signal), { code: "call_cancelled" });
  caller.abort();
  assert.equal(requestSignal?.aborted, true);
  assert.equal(requestSignal?.reason, caller.signal.reason);
  await pending;
  await assert.rejects(client.getClinic(ROOT_CONTEXT, caller.signal), { name: "AbortError" });
  assert.equal(requests, 1);
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
