import { ROOT_CONTEXT } from "@opentelemetry/api";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ProsperClient } from "../prosper.js";
import { idSchema, receiptSchema, type ProsperAction } from "../prosper-types.js";
import { DashboardAzure, type CallTrace } from "./azure.js";
import type { DashboardConfig } from "./config.js";
import { DashboardRecords, type LocalCall } from "./records.js";
import { cached, observe, requestJson, type Source } from "./source.js";

const healthSchema = z.object({
  status: z.enum(["ok", "stopping"]),
  activeCalls: z.number().int().nonnegative(),
  telemetry: z.enum(["azure", "console"]),
  capabilities: z.array(z.string()),
  localRecording: z.boolean(),
  localAudioRecording: z.boolean(),
  voiceConnector: z.enum(["realtime", "live"]),
  voiceDeployment: z.string().max(200),
  voiceBackendDeployment: z.string().max(200).optional(),
  voiceOutputGainDb: z.number(),
});
const submissionsSchema = z.object({ submissions: z.array(receiptSchema).max(200) });
const patientSearchSchema = z.union([
  z.strictObject({ name: z.string().trim().min(2).max(200) }),
  z.strictObject({ phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/) }),
]);

function status<T>(source: Source<T>) {
  return { status: source.status, code: source.code, checkedAt: source.checkedAt };
}

function publicAction(action: ProsperAction) {
  return {
    action: action.action,
    reason: "reason" in action ? action.reason : null,
    patientId: "patient_id" in action ? action.patient_id : null,
    providerId: "provider_id" in action ? action.provider_id : null,
    locationId: "location_id" in action ? action.location_id : null,
    slot: "slot" in action ? action.slot : null,
  };
}

interface ObservedCall {
  id: string;
  startedAt: string | null;
  receivedAt: string | null;
  endedAt: string | null;
  openRecord: boolean;
  durationMs: number | null;
  endReason: string | null;
  actions: ReturnType<typeof publicAction>[];
  receiptSource: "prosper" | "local" | null;
  patientIds: string[];
  events: LocalCall["events"];
  technical: {
    inputBytes: number | null;
    outputBytes: number | null;
    interruptions: number | null;
    transcriptEvents: number | null;
    trace: CallTrace | null;
  };
}

export class DashboardService {
  private readonly prosper: ProsperClient;
  private readonly records: DashboardRecords;
  private readonly azure: DashboardAzure;

  constructor(
    readonly config: DashboardConfig,
    private readonly request: typeof fetch = fetch,
    azure?: DashboardAzure,
  ) {
    this.prosper = new ProsperClient(config.voice, request);
    this.records = new DashboardRecords(config.DASHBOARD_RECORDS_DIR, config.DASHBOARD_HISTORY_DAYS, [
      config.DASHBOARD_TOKEN, config.voice.PROSPER_API_KEY, config.voice.VOICE_ENDPOINT_TOKEN,
      config.voice.AZURE_OPENAI_API_KEY ?? "", config.voice.APPLICATIONINSIGHTS_CONNECTION_STRING ?? "",
    ]);
    this.azure = azure ?? new DashboardAzure(config, request);
  }

  private readonly health = cached(2_000, () => observe("voice", () =>
    requestJson(this.request, new URL("/healthz", this.config.DASHBOARD_VOICE_URL),
      healthSchema, "voice_health", {}, AbortSignal.timeout(3_000))));

  private readonly clinic = cached(60_000, () => observe("prosper_clinic", async () => {
    const clinic = await this.prosper.getClinic(ROOT_CONTEXT, AbortSignal.timeout(10_000));
    return {
      name: clinic.clinic_name,
      patientCount: clinic.patient_count,
      locations: clinic.locations.map(({ id, name }) => ({ id, name })),
      providers: clinic.providers.map(({ id, name, specialty_id }) => ({ id, name, specialtyId: specialty_id })),
      specialties: clinic.specialties.map(({ id, name }) => ({ id, name })),
      plans: clinic.plans.map(({ id, name }) => ({ id, name })),
    };
  }));

  private readonly submissions = cached(15_000, () => observe("prosper_submissions", async () => {
    const result = await requestJson(this.request,
      new URL("/api/v1/submissions?limit=200", this.config.voice.PROSPER_API_BASE_URL),
      submissionsSchema, "prosper", { "X-Api-Key": this.config.voice.PROSPER_API_KEY }, AbortSignal.timeout(10_000));
    return result.submissions.map((receipt) => ({
      callId: receipt.call_id, receivedAt: receipt.received_at,
      actions: receipt.record.actions.map(publicAction),
    }));
  }));

  private readonly local = cached(2_000, () => observe("local_records", () => this.records.read()));

  async snapshot() {
    const [health, clinic, submissions, records, openAi, speech, traces] = await Promise.all([
      this.health(), this.clinic(), this.submissions(), this.local(),
      this.azure.openAi(), this.azure.speech(), this.azure.traces(),
    ]);
    const now = new Date();
    const calls = new Map<string, ObservedCall>();
    for (const local of records.data?.calls ?? []) {
      if (calls.has(local.id)) continue;
      const accepted = local.actions.filter((action) => action.stage === "accepted" || action.stage === "duplicate");
      calls.set(local.id, {
        id: local.id, startedAt: local.startedAt, endedAt: local.endedAt, receivedAt: null,
        openRecord: !local.endedAt && now.getTime() >= Date.parse(local.startedAt) &&
          now.getTime() - Date.parse(local.startedAt) <= 180_000,
        durationMs: local.endedAt ? Date.parse(local.endedAt) - Date.parse(local.startedAt) : null,
        endReason: local.endReason,
        actions: accepted.map(({ action, reason }) => ({
          action, reason, patientId: null, providerId: null, locationId: null, slot: null,
        })),
        receiptSource: accepted.length ? "local" : null, patientIds: [], events: local.events,
        technical: {
          inputBytes: local.inputBytes, outputBytes: local.outputBytes,
          interruptions: local.interruptions, transcriptEvents: local.transcriptEvents, trace: null,
        },
      });
    }
    // The endpoint can expose successive accumulated records for a call. Keep its newest record.
    const receipts = [...(submissions.data ?? [])].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    for (const receipt of receipts) {
      if (Date.parse(receipt.receivedAt) < now.getTime() - this.config.DASHBOARD_HISTORY_DAYS * 86_400_000) continue;
      const call = calls.get(receipt.callId) ?? {
        id: receipt.callId, startedAt: null, endedAt: null, receivedAt: null,
        openRecord: false, durationMs: null, endReason: null, actions: [], receiptSource: null,
        patientIds: [], events: [],
        technical: { inputBytes: null, outputBytes: null, interruptions: null, transcriptEvents: null, trace: null },
      };
      call.receivedAt = receipt.receivedAt;
      call.actions = receipt.actions;
      call.receiptSource = "prosper";
      call.patientIds = [...new Set(receipt.actions.flatMap((action) => action.patientId ? [action.patientId] : []))];
      calls.set(call.id, call);
    }
    for (const trace of traces.data ?? []) {
      const call = calls.get(trace.callId);
      if (call) call.technical.trace = trace;
    }
    return {
      observedAt: now.toISOString(),
      historyDays: this.config.DASHBOARD_HISTORY_DAYS,
      coverage: {
        recordLimit: records.data?.limit ?? 200, recordsLimited: records.data?.limited ?? null,
        recordPermissionsRestricted: records.data?.restrictedPermissions ?? null,
        submissionLimit: 200, submissionsAtLimit: submissions.data ? submissions.data.length === 200 : null,
        completeHistory: false,
      },
      sources: {
        voice: status(health), clinic: status(clinic), submissions: status(submissions), records: status(records),
        azure: status(openAi), foundry: status(traces), speech: status(speech),
      },
      health: health.data, clinic: clinic.data,
      calls: [...calls.values()].sort((a, b) =>
        Date.parse(b.startedAt ?? b.receivedAt ?? "") - Date.parse(a.startedAt ?? a.receivedAt ?? "")),
      cloud: { openAi: openAi.data, speech: speech.data },
      unavailable: ["sentiment", "intent_confidence", "mos", "jitter", "packet_loss", "asr_accuracy",
        "turn_latency", "nps", "clinical_risk", "cost", "audio_playback"],
    };
  }

  async transcript(callId: string) {
    return this.records.transcript(callId);
  }

  async patients(query: unknown) {
    const input = patientSearchSchema.safeParse(query);
    if (!input.success) throw new AppError("dashboard_invalid_patient_search");
    const patients = await this.prosper.findPatients(input.data, ROOT_CONTEXT, AbortSignal.timeout(10_000));
    return { patients: patients.map((patient) => ({
      id: patient.patient_id,
      name: [patient.given_name, patient.first_surname, patient.second_surname].filter(Boolean).join(" "),
      phone: patient.phone, insurer: patient.insurer,
    })) };
  }

  async appointments(patientId: string) {
    if (!idSchema.safeParse(patientId).success) throw new AppError("dashboard_invalid_patient_id");
    const appointments = await this.prosper.appointments(patientId, "upcoming", ROOT_CONTEXT, AbortSignal.timeout(10_000));
    return { appointments: appointments.map((appointment) => ({
      id: appointment.appointment_id, providerId: appointment.provider_id, locationId: appointment.location_id,
      typeId: appointment.appointment_type_id, start: appointment.start_time, durationMinutes: appointment.duration_minutes,
    })) };
  }
}

export type DashboardSnapshot = Awaited<ReturnType<DashboardService["snapshot"]>>;
