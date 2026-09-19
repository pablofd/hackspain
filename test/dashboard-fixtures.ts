import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { parseDashboardConfig } from "../src/dashboard/config.js";
import type { TranscriptEntry } from "../src/dashboard/records.js";

export function dashboardDirectory(t: TestContext) {
  const directory = join(".local", `dashboard-test-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function dashboardConfig(directory: string, overrides: NodeJS.ProcessEnv = {}) {
  return parseDashboardConfig({
    AZURE_OPENAI_ENDPOINT: "https://synthetic.openai.azure.com",
    AZURE_OPENAI_DEPLOYMENT: "synthetic-voice",
    PROSPER_API_BASE_URL: "https://clinic.example",
    PROSPER_API_KEY: "synthetic-prosper-key",
    VOICE_ENDPOINT_TOKEN: "synthetic-voice-endpoint-token-32-characters",
    DASHBOARD_TOKEN: "synthetic-dashboard-token-at-least-32-characters",
    DASHBOARD_PORT: "0",
    DASHBOARD_RECORDS_DIR: directory,
    DASHBOARD_SIGNALS_ENABLED: "false",
    ...overrides,
  });
}

export const dashboardClinic = {
  clinic_name: "Clinica Sintetica", patient_count: 2,
  calendar: { starts: "2026-09-07", ends: "2026-10-16", max_span_days: 14, slot_minutes: 15, closure_days: [] },
  locations: [{ id: "test-site", name: "Sede de prueba", address: "Synthetic site", latitude: 40.4, longitude: -3.7, hours: [] }],
  providers: [{ id: "test-provider", name: "Profesional de prueba", specialty_id: "test-specialty", languages: ["es"],
    schedules: [], leave: null }],
  specialties: [{ id: "test-specialty", name: "Especialidad de prueba", min_age_months: 0, max_age_months: null, referral_required: false }],
  appointment_types: [], plans: [], restrictions: [],
};

export const dashboardPatient = {
  patient_id: "PATIENT_TEST", given_name: "Ada", first_surname: "Sintetica", second_surname: "Prueba",
  national_id: "00000000T", date_of_birth: "1980-06-15", phone: "+34600000000",
  has_visited_before: true, insurer: "mapfre", referrals: [], note: "PRIVATE_CLINICAL_NOTE",
  matched_fields: ["name"], email: "private@example.test",
};

export const dashboardBook = {
  action: "BOOK", patient_id: "PATIENT_TEST", provider_id: "test-provider",
  location_id: "test-site", appointment_type_id: "test-type",
  slot: "2026-09-28T10:15:00+02:00", policy_id: "mapfre",
};

export function writeDashboardRecord(
  directory: string, callId = "dashboard-test-call", options: {
    ended?: boolean; accepted?: boolean; started?: Date; transcripts?: Omit<TranscriptEntry, "timestamp">[];
  } = {},
) {
  const started = options.started ?? new Date(Date.now() - 30_000);
  const record = (type: string, extra: object = {}, offset = 0) => ({
    schemaVersion: 1, callId, timestamp: new Date(started.getTime() + offset).toISOString(), type, ...extra,
  });
  const lines = [
    record("start"),
    ...(options.transcripts ?? [
      { speaker: "user", itemId: "item-test", text: "PRIVATE_TRANSCRIPT_WITH_ID_00000000T" },
    ]).map((entry, index) => record("transcript", entry, 1000 + index)),
    record("tool", { name: "find_patient", status: "ok", details: { name: "PRIVATE_TOOL_NAME" } }, 2000),
    record("action", { proposalId: "proposal-test", stage: "proposed", action: dashboardBook }, 3000),
    record("interruption", { reason: "caller" }, 4000),
    ...(options.accepted === false ? [] : [record("action", {
      proposalId: "proposal-test", stage: "accepted", action: dashboardBook,
    }, 5000)]),
    ...(options.ended === false ? [] : [record("end", {
      reason: "prosper_stop", inputBytes: 8000, outputBytes: 16000,
      audio: { filename: "PRIVATE_AUDIO_FILENAME.wav" },
    }, 20_000)]),
  ];
  const path = join(directory, `call-v1-${callId}-${started.getTime()}-${randomUUID()}.ndjson`);
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  writeFileSync(path, text, { mode: 0o600 });
  return { path, text, started, record };
}

export function dashboardFetch(options: { submissions?: boolean; fail?: boolean } = {}) {
  const requests: { url: URL; method: string; headers: Headers }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    if ((init?.method ?? "GET") !== "GET") throw new Error("Unexpected write");
    if (options.fail) return new Response("PRIVATE_UPSTREAM_FAILURE", { status: 503 });
    if (url.pathname === "/healthz") return Response.json({
      status: "ok", activeCalls: 0, telemetry: "console",
      capabilities: ["voice", "clinic", "book", "reschedule", "cancel", "register", "outcomes"],
      localRecording: true, localAudioRecording: false, voiceConnector: "realtime",
      voiceDeployment: "synthetic-voice", voiceOutputGainDb: 0,
    });
    if (url.origin !== "https://clinic.example") throw new Error("Unexpected external service");
    if (url.pathname === "/api/v1/clinic") return Response.json(dashboardClinic);
    if (url.pathname === "/api/v1/submissions") return Response.json({
      submissions: options.submissions === false ? [] : [{
        call_id: "dashboard-test-call", received_at: new Date().toISOString(), record: { actions: [dashboardBook] },
      }],
    });
    if (url.pathname === "/api/v1/directory") return Response.json({ matches: [dashboardPatient] });
    if (url.pathname === "/api/v1/patients/PATIENT_TEST/appointments") return Response.json({ appointments: [{
      appointment_id: "APPOINTMENT_TEST", patient_id: "PATIENT_TEST", provider_id: "test-provider",
      location_id: "test-site", appointment_type_id: "test-type", start_time: "2026-09-28T10:15:00+02:00",
      duration_minutes: 30,
    }] });
    throw new Error("Unexpected clinic path");
  };
  return { request, requests };
}
