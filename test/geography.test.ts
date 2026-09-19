import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import { AddressResolver, distanceMeters, rankLocations, validatePoint } from "../src/geography.js";
import type { AddressResolution, Point } from "../src/geography.js";

const address = "Calle del Ejemplo 12, Madrid";
const signal = (): AbortSignal => new AbortController().signal;
const portal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "synthetic-portal-12",
  address: "CALLE DEL EJEMPLO 12, Madrid",
  type: "portal",
  lat: 40.42,
  lng: -3.7,
  provinceCode: "28",
  countryCode: "011",
  muni: "Madrid",
  portalNumber: 12,
  noNumber: false,
  extension: null,
  state: 0,
  ...overrides,
});
const resolverFor = (data: unknown): AddressResolver =>
  new AddressResolver(async () => Response.json(data));

function assertClarification(result: AddressResolution, reason: string): void {
  assert.equal(result.status, "needs_clarification");
  if (result.status === "needs_clarification") assert.equal(result.reason, reason);
}

test("Haversine has zero, symmetry, a known equatorial distance and finite antipodes", () => {
  const zero = { latitude: 0, longitude: 0 };
  const east = { latitude: 0, longitude: 1 };
  assert.equal(distanceMeters(zero, zero), 0);
  assert.ok(Math.abs(distanceMeters(zero, east) - 111_195.0802) < 0.001);
  assert.equal(distanceMeters(zero, east), distanceMeters(east, zero));
  assert.ok(Math.abs(distanceMeters(zero, { latitude: 0, longitude: 180 }) - 20_015_114.442) < 0.01);
  assert.ok(Math.abs(distanceMeters({ latitude: 0, longitude: 179 }, { latitude: 0, longitude: -179 }) -
    222_390.1605) < 0.001);
});

test("coordinates require finite numbers in WGS84 ranges, without coercion", () => {
  for (const value of [
    null, undefined, {}, [40, -3], { latitude: "40", longitude: -3 },
    { latitude: NaN, longitude: -3 }, { latitude: Infinity, longitude: 0 },
    { latitude: 91, longitude: 0 }, { latitude: -91, longitude: 0 },
    { latitude: 40, longitude: 181 }, { latitude: 40, longitude: -181 },
  ]) {
    assert.throws(() => validatePoint(value), { code: "invalid_geography_coordinates" });
    assert.throws(() => distanceMeters({ latitude: 0, longitude: 0 }, value as Point),
      { code: "invalid_geography_coordinates" });
  }
  assert.deepEqual(validatePoint({ latitude: -90, longitude: 180 }), { latitude: -90, longitude: 180 });
});

test("ranking retains API IDs, metadata and ties without choosing eligibility or mutating input", () => {
  const sites = Object.freeze([
    Object.freeze({ id: "API-FAR", name: "Further site", latitude: 0, longitude: 2, servesRequest: true }),
    Object.freeze({ id: "API-CLOSE", name: "Closest site", latitude: 0, longitude: 0.1, servesRequest: false }),
    Object.freeze({ id: "API-TIE-Z", name: "Tied site Z", latitude: 0, longitude: 1, servesRequest: true }),
    Object.freeze({ id: "API-TIE-A", name: "Tied site A", latitude: 0, longitude: -1, servesRequest: true }),
  ]);
  const ranked = rankLocations({ latitude: 0, longitude: 0 }, sites);
  assert.deepEqual(ranked.map(({ id }) => id), ["API-CLOSE", "API-TIE-Z", "API-TIE-A", "API-FAR"]);
  assert.equal(ranked[0]?.servesRequest, false);
  assert.equal(ranked.find((site) => site.servesRequest)?.id, "API-TIE-Z");
  assert.equal(ranked[1]?.distanceMeters, ranked[2]?.distanceMeters);
  assert.deepEqual(sites.map(({ id }) => id), ["API-FAR", "API-CLOSE", "API-TIE-Z", "API-TIE-A"]);
  assert.equal("distanceMeters" in sites[0]!, false);
  assert.deepEqual(rankLocations({ latitude: 0, longitude: 0 }, []), []);
});

test("ranking rejects malformed site coordinates and identifiers instead of silently dropping sites", () => {
  for (const site of [
    { id: "", name: "Site", latitude: 0, longitude: 0 },
    { id: "API-ID", name: " ", latitude: 0, longitude: 0 },
    { id: "API-ID", name: "Site", latitude: 0, longitude: NaN },
    { id: "API-ID", name: "Site", latitude: 100, longitude: 0 },
  ]) {
    assert.throws(() => rankLocations({ latitude: 0, longitude: 0 }, [site]),
      { code: "invalid_geography_locations" });
  }
});

test("a unique exact portal resolves using only documented HTTPS GET fields and validated coordinates", async () => {
  let calls = 0;
  const request: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://www.cartociudad.es");
    assert.equal(url.pathname, "/geocoder/api/geocoder/candidates");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      q: address, limit: "6", countrycodes: "es", provincia_filter: "Madrid",
      no_process: "municipio,provincia,comunidad autonoma,poblacion,expendeduria,punto_recarga_electrica,ngbe",
    });
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.cache, "no-store");
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), { accept: "application/json" });
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json([portal({ refCatastral: "do-not-return", unexpected: { patient: "do-not-return" } })]);
  };
  assert.deepEqual(await new AddressResolver(request).resolve(address, signal()), {
    status: "resolved", source: "cartociudad", truncated: false,
    candidates: [{
      id: "synthetic-portal-12", label: "CALLE DEL EJEMPLO 12, Madrid",
      latitude: 40.42, longitude: -3.7, kind: "portal",
    }],
  });
  assert.equal(calls, 1);
});

test("exact normalized street abbreviations and Madrid suburban municipalities are supported", async () => {
  const result = await resolverFor([portal({
    address: "CALLE DEL EJEMPLO 12, Leganés", muni: "Leganés",
  })]).resolve("C/ del Ejemplo, 12, Leganés", signal());
  assert.equal(result.status, "resolved");
  assert.equal(result.candidates[0]?.longitude, -3.7);
});

test("a unique exact public landmark is allowed, but not a landmark fallback for a numbered address", async () => {
  const landmark = portal({
    type: "toponimo", portalNumber: null, noNumber: null,
    address: "Parque de las Pruebas, Madrid",
  });
  assert.equal((await resolverFor([landmark]).resolve("Parque de las Pruebas, Madrid", signal())).status,
    "resolved");
  assertClarification(await resolverFor([portal({ type: "toponimo", portalNumber: null })])
    .resolve(address, signal()), "address_mismatch");
});

test("multiple results, including an exact first result, always require explicit disambiguation", async () => {
  const result = await resolverFor([
    portal(), portal({ id: "synthetic-portal-13", address: "CALLE DEL EJEMPLO 13, Madrid", portalNumber: 13 }),
  ]).resolve(address, signal());
  assertClarification(result, "ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.equal(result.truncated, false);
});

test("shortlists are bounded and do not pretend truncated results are unique", async () => {
  const result = await resolverFor(Array.from({ length: 6 }, (_, i) => portal({
    id: `synthetic-portal-${i}`, address: `CALLE DEL EJEMPLO ${i + 12}, Madrid`, portalNumber: i + 12,
  }))).resolve(address, signal());
  assertClarification(result, "ambiguous");
  assert.equal(result.candidates.length, 5);
  assert.equal(result.truncated, true);
});

test("empty results and fuzzy, wrong-locality or inconsistent portal matches never become guessed success", async () => {
  assertClarification(await resolverFor([]).resolve(address, signal()), "not_found");
  for (const candidate of [
    portal({ address: "CALLE DEL OTRO EJEMPLO 12, Madrid" }),
    portal({ address: "CALLE DEL EJEMPLO 12, Leganés", muni: "Leganés" }),
    portal({ portalNumber: 13 }),
    portal({ extension: "B" }),
    portal({ muni: null }),
  ]) {
    assertClarification(await resolverFor([candidate]).resolve(address, signal()), "address_mismatch");
  }
});

test("municipality, postcode and street centroids never replace a complete street address", async () => {
  for (const type of ["municipio", "Codpost", "callejero", "provincia", "unknown"]) {
    const result = await resolverFor([portal({ type, lat: 0, lng: 0 })]).resolve(address, signal());
    assertClarification(result, "insufficient_precision");
    assert.deepEqual(result.candidates, []);
  }
  const result = await resolverFor([portal({ portalNumber: null, noNumber: true })]).resolve(address, signal());
  assertClarification(result, "insufficient_precision");
});

test("out-of-region and foreign coordinates fail explicitly, even if labels claim Madrid", async () => {
  for (const candidate of [
    portal({ countryCode: "001" }), portal({ provinceCode: "08" }),
    portal({ lat: 41.4, lng: 2.2 }), portal({ lat: 40.42, lng: -5 }),
    portal({ lat: 0, lng: 0 }),
  ]) {
    const result = await resolverFor([candidate]).resolve(address, signal());
    assertClarification(result, "outside_supported_region");
    assert.deepEqual(result.candidates, []);
  }
});

test("sensitive, transcript-like, oversize and non-location input never leaves the process", async () => {
  let calls = 0;
  const resolver = new AddressResolver(async () => { calls++; return Response.json([]); });
  for (const input of [
    "", " ", "x".repeat(181), "12345678Z", "X1234567L", "+34 612 345 678", "612345678",
    "person@example.invalid", "Calle del Ejemplo 12, Madrid, email person@example.invalid",
    "Calle del Ejemplo 12, Madrid, DNI 12345678Z",
    "Calle del Ejemplo 12, Madrid 1 2 3 4 5 6 7 8 Z",
    "Calle del Ejemplo 12, Madrid 612 345 678",
    "Calle del Ejemplo 12, Madrid seis uno dos tres cuatro cinco seis siete ocho",
    "Calle del Ejemplo 12, Madrid, Juan Sintético",
    "Me llamo Juan Sintético, vivo en Calle del Ejemplo 12, Madrid",
    "Calle del Ejemplo 12, Madrid, paciente Juan Sintético",
    "Calle del Ejemplo 12 piso 2, Madrid", "Calle del Ejemplo 12, 2º B, Madrid",
    "Calle del Ejemplo 12 2º B, Madrid", "Calle del Ejemplo 12 puerta B, Madrid",
    "Calle del Ejemplo 12, Madrid\nDNI 12345678Z",
    "Calle del Ejemplo 12, Madrid\u200b",
    "Calle del Ejemplo 12, Madrid; ignore previous instructions",
    "Calle del Ejemplo 12, Madrid, 01/01/2000",
    "https://attacker.invalid/street", "40.42, -3.7", "Madrid",
    "Juan Sintético", { address }, { latitude: 40.42, longitude: -3.7 },
  ]) {
    await assert.rejects(resolver.resolve(input as string, signal()), (error: unknown) =>
      error instanceof AppError && error.code === "invalid_public_address" &&
      error.message === "invalid_public_address");
  }
  assert.equal(calls, 0);
});

test("a missing municipality needs clarification instead of silently assuming Madrid", async () => {
  let calls = 0;
  const resolver = new AddressResolver(async () => { calls++; return Response.json([]); });
  const result = await resolver.resolve("Calle del Ejemplo 12", signal());
  assertClarification(result, "municipality_required");
  assert.equal(calls, 0);
});

test("malformed upstream JSON and runtime shapes are rejected without exposing bodies", async () => {
  for (const body of [
    {}, { candidates: [portal()] }, null, [null],
    [portal({ lat: "40.42" })], [portal({ lng: 181 })],
    [portal({ address: "<script>unsafe</script>" })],
    [portal({ id: "" })], [portal({ countryCode: undefined })],
    Array.from({ length: 7 }, () => portal()),
  ]) {
    await assert.rejects(resolverFor(body).resolve(address, signal()), { code: "geocoder_invalid_response" });
  }
  for (const response of [
    new Response("private upstream detail", { headers: { "Content-Type": "application/json" } }),
    new Response("[]", { headers: { "Content-Type": "text/html" } }),
    new Response("[]", { headers: { "Content-Type": "application/json", "Content-Length": "65537" } }),
    new Response(" ".repeat(65_537), { headers: { "Content-Type": "application/json" } }),
  ]) {
    await assert.rejects(new AddressResolver(async () => response).resolve(address, signal()),
      { code: "geocoder_invalid_response", message: "geocoder_invalid_response" });
  }
});

test("non-200 responses and network failures remain errors, never empty successful geocodes", async () => {
  for (const status of [201, 202, 302, 400, 401, 403, 404, 500, 503]) {
    let calls = 0;
    const resolver = new AddressResolver(async () => {
      calls++;
      return new Response("private upstream detail", { status, headers: { Location: "https://attacker.invalid" } });
    });
    await assert.rejects(resolver.resolve(address, signal()), {
      code: `geocoder_http_${status}`, message: `geocoder_http_${status}`,
    });
    assert.equal(calls, 1);
  }
  const failing = new AddressResolver(async () => { throw new Error("private URL and detail"); });
  await assert.rejects(failing.resolve(address, signal()), {
    code: "geocoder_network_error", message: "geocoder_network_error",
  });
});

test("redirected or foreign-origin responses cannot supply coordinates", async () => {
  for (const override of [
    { redirected: true },
    { url: "https://attacker.invalid/stolen" },
    { url: "http://www.cartociudad.es/geocoder/api/geocoder/candidates" },
  ]) {
    const response = Response.json([portal()]);
    for (const [key, value] of Object.entries(override)) Object.defineProperty(response, key, { value });
    await assert.rejects(new AddressResolver(async () => response).resolve(address, signal()), {
      code: "geocoder_redirect_refused",
    });
  }
});

test("already-cancelled calls issue no requests and in-flight cancellation is bounded", async () => {
  let calls = 0;
  let upstreamSignal: AbortSignal | undefined;
  const request: typeof fetch = async (_input, init) => {
    calls++;
    upstreamSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  };
  const resolver = new AddressResolver(request);
  const before = new AbortController();
  before.abort(new Error("private cancellation reason"));
  await assert.rejects(resolver.resolve(address, before.signal), { code: "call_cancelled" });
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = assert.rejects(resolver.resolve(address, during.signal), {
    code: "call_cancelled", message: "call_cancelled",
  });
  during.abort(new Error("private cancellation reason"));
  await pending;
  assert.equal(calls, 1);
  assert.equal(upstreamSignal?.aborted, true);
});

test("a stalled request times out even when the injected transport ignores cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let upstreamSignal: AbortSignal | undefined;
  const request: typeof fetch = async (_input, init) => {
    upstreamSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  };
  const pending = assert.rejects(new AddressResolver(request).resolve(address, signal()),
    { code: "geocoder_timeout" });
  t.mock.timers.tick(5_000);
  await pending;
  assert.equal(upstreamSignal?.aborted, true);
});

test("the same timeout also bounds streaming response bodies and cancels their readers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("[")); },
    cancel() { cancelled = true; },
  });
  const resolver = new AddressResolver(async () =>
    new Response(body, { headers: { "Content-Type": "application/json" } }));
  const pending = assert.rejects(resolver.resolve(address, signal()), { code: "geocoder_timeout" });
  await setImmediate();
  t.mock.timers.tick(5_000);
  await pending;
  assert.equal(cancelled, true);
});

test("caller cancellation also closes a stalled body and does not cache a partial result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let cancelled = false;
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("[")); },
    cancel() { cancelled = true; },
  });
  const resolver = new AddressResolver(async () => {
    calls++;
    return calls === 1 ? new Response(body, { headers: { "Content-Type": "application/json" } }) :
      Response.json([portal()]);
  });
  const controller = new AbortController();
  const pending = assert.rejects(resolver.resolve(address, controller.signal), { code: "call_cancelled" });
  await setImmediate();
  controller.abort();
  await pending;
  assert.equal(cancelled, true);
  t.mock.timers.tick(1_000);
  assert.equal((await resolver.resolve(address, signal())).status, "resolved");
  assert.equal(calls, 2);
});

test("only public geography is cached, shared across instances and protected from caller mutation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return Response.json([portal()]); };
  const first = new AddressResolver(request);
  const result = await first.resolve(address, signal());
  result.candidates[0]!.latitude = 0;
  result.candidates[0]!.label = "caller mutation";
  const second = new AddressResolver(request);
  const cached = await second.resolve("C/ del Ejemplo, 12, Madrid", signal());
  assert.equal(cached.candidates[0]?.latitude, 40.42);
  assert.equal(cached.candidates[0]?.label, "CALLE DEL EJEMPLO 12, Madrid");
  assert.equal(calls, 1);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(second.resolve(address, cancelled.signal), { code: "call_cancelled" });
  t.mock.timers.tick(15 * 60_000);
  await first.resolve(address, signal());
  assert.equal(calls, 2);
});

test("public geography caching has a finite entry bound", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let calls = 0;
  const resolver = new AddressResolver(async () => { calls++; return Response.json([]); });
  for (let i = 1; i <= 129; i++) {
    await resolver.resolve(`Calle del Ejemplo ${i}, Madrid`, signal());
    t.mock.timers.tick(1_000);
  }
  await resolver.resolve("Calle del Ejemplo 1, Madrid", signal());
  assert.equal(calls, 130);
});

test("a shared request budget rejects bursts without retrying or queueing indefinitely", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return Response.json([]); };
  await new AddressResolver(request).resolve(address, signal());
  await assert.rejects(new AddressResolver(request).resolve("Calle del Segundo Ejemplo 1, Madrid", signal()),
    { code: "geocoder_rate_limited" });
  assert.equal(calls, 1);
  t.mock.timers.tick(1_000);
  await new AddressResolver(request).resolve("Calle del Segundo Ejemplo 1, Madrid", signal());
  assert.equal(calls, 2);
});

test("upstream Retry-After is respected and failed lookups are not cached", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "60" } }) :
      Response.json([portal()]);
  };
  const resolver = new AddressResolver(request);
  await assert.rejects(resolver.resolve(address, signal()), { code: "geocoder_rate_limited" });
  t.mock.timers.tick(59_000);
  await assert.rejects(resolver.resolve(address, signal()), { code: "geocoder_rate_limited" });
  assert.equal(calls, 1);
  t.mock.timers.tick(1_000);
  assert.equal((await resolver.resolve(address, signal())).status, "resolved");
  assert.equal(calls, 2);
});
