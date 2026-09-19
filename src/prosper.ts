import { z } from "zod";
import type { Context } from "@opentelemetry/api";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { withSpan } from "./telemetry.js";
import {
  actionSchema, appointmentsSchema, availabilityQuerySchema, availabilitySchema, directorySchema,
  idSchema, patientQuerySchema, receiptSchema, sameAction,
  type Appointment, type Availability, type AvailabilityQuery, type Patient, type PatientQuery,
  type ProsperAction, type SubmissionResult,
} from "./prosper-types.js";

const catalogEntry = z.object({ id: idSchema, name: z.string() }).passthrough();
const clinicDay = z.object({ weekday: z.string(), intervals: z.array(z.string()) });
const clinicSchema = z.object({
  clinic_name: z.string(),
  patient_count: z.number().int(),
  calendar: z.object({
    starts: z.iso.date(),
    ends: z.iso.date(),
    max_span_days: z.number().int().positive().max(14),
    slot_minutes: z.number().int().positive(),
    closure_days: z.array(z.iso.date()),
  }).passthrough(),
  locations: z.array(catalogEntry.extend({
    address: z.string(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    hours: z.array(clinicDay),
  })),
  providers: z.array(catalogEntry.extend({
    specialty_id: idSchema,
    languages: z.array(z.string()),
    schedules: z.array(z.object({ location_id: idSchema, location_name: z.string(), days: z.array(clinicDay) })),
    leave: z.object({ start: z.iso.date(), end: z.iso.date(), reason: z.string() }).nullable(),
  })),
  specialties: z.array(catalogEntry.extend({
    min_age_months: z.number().int().nonnegative(),
    max_age_months: z.number().int().nonnegative().nullable(),
    referral_required: z.boolean(),
  })),
  appointment_types: z.array(catalogEntry),
  plans: z.array(catalogEntry),
  restrictions: z.array(z.record(z.string(), z.unknown())),
});

export type Clinic = z.infer<typeof clinicSchema>;

export function clinicSummary(clinic: Clinic) {
  return {
    clinic_name: clinic.clinic_name,
    calendar: clinic.calendar,
    providers: clinic.providers.map(({ id, name, specialty_id, languages, schedules, leave }) => ({
      id, name, specialty_id, languages, schedules, leave,
    })),
    locations: clinic.locations.map(({ id, name, address, hours, latitude, longitude }) => ({
      id, name, address, hours, latitude, longitude,
    })),
    specialties: clinic.specialties.map(({ id, name, min_age_months, max_age_months, referral_required }) => ({
      id, name, min_age_months, max_age_months, referral_required,
    })),
    plans: clinic.plans.map(({ id, name, covered_specialty_names, uncovered_specialty_names, covered_location_names, uncovered_location_names }) => ({
      id, name, covered_specialty_names, uncovered_specialty_names, covered_location_names, uncovered_location_names,
    })),
    appointment_types: clinic.appointment_types.map(({ id, name, duration_minutes, guidance }) => ({
      id, name, duration_minutes, guidance,
    })),
    restrictions: clinic.restrictions,
  };
}

export class ProsperClient {
  private cached: Clinic | undefined;

  constructor(
    private readonly config: Pick<Config, "PROSPER_API_BASE_URL" | "PROSPER_API_KEY">,
    private readonly request: typeof fetch = fetch,
  ) {}

  getClinic(parent: Context, signal: AbortSignal): Promise<Clinic> {
    return withSpan("execute_tool get_clinic", {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "get_clinic",
      "http.request.method": "GET",
      "url.path": "/api/v1/clinic",
    }, parent, async () => {
      signal.throwIfAborted();
      if (this.cached) return this.cached;
      this.cached = await this.read("/api/v1/clinic", clinicSchema, signal, "prosper_invalid_clinic");
      return this.cached;
    });
  }

  findPatients(query: PatientQuery, parent: Context, signal: AbortSignal): Promise<Patient[]> {
    const input = patientQuerySchema.safeParse(query);
    if (!input.success) throw new AppError("invalid_patient_query");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input.data)) if (value) params.set(key, value);
    return withSpan("prosper.directory", { "url.path": "/api/v1/directory" }, parent, async () =>
      (await this.read(`/api/v1/directory?${params}`, directorySchema, signal)).matches);
  }

  availability(query: AvailabilityQuery, parent: Context, signal: AbortSignal): Promise<Availability> {
    const input = availabilityQuerySchema.safeParse(query);
    if (!input.success) throw new AppError("invalid_availability_query");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input.data)) {
      if (Array.isArray(value)) for (const insurer of value) params.append(key, insurer);
      else if (value) params.set(key, value);
    }
    return withSpan("prosper.availability", { "url.path": "/api/v1/availability" }, parent, () =>
      this.read(`/api/v1/availability?${params}`, availabilitySchema, signal));
  }

  appointments(patientId: string, when: "upcoming" | "past" | "all", parent: Context, signal: AbortSignal): Promise<Appointment[]> {
    if (!idSchema.safeParse(patientId).success) throw new AppError("invalid_patient_id");
    return withSpan("prosper.appointments", { "url.path": "/api/v1/patients/{patient_id}/appointments" }, parent, async () =>
      (await this.read(`/api/v1/patients/${encodeURIComponent(patientId)}/appointments?when=${when}`,
        appointmentsSchema, signal)).appointments);
  }

  submit(callId: string, action: ProsperAction, parent: Context, signal: AbortSignal): Promise<SubmissionResult> {
    if (!idSchema.safeParse(callId).success) throw new AppError("invalid_call_id");
    const parsed = actionSchema.safeParse(action);
    if (!parsed.success) throw new AppError("invalid_action");
    const { action: verb, ...fields } = parsed.data;
    const body = { call_id: callId, ...(parsed.data.action === "REGISTER" ? parsed.data.new_patient : fields) };
    const route = verb.toLowerCase().replace("_", "-");
    return withSpan(`prosper.submit.${route}`, {
      "http.request.method": "POST", "url.path": `/api/v1/submit/${route}`, "prosper.action": verb,
    }, parent, async () => {
      const response = await this.fetch(`/api/v1/submit/${route}`, signal, JSON.stringify(body));
      // The contract reserves 409 for an identical action already accepted for this call.
      if (response.status === 409) return { status: "duplicate", action: parsed.data };
      if (!response.ok) {
        if (response.status >= 500 || response.status === 408) throw new AppError("prosper_submission_unknown");
        throw new AppError(`prosper_http_${response.status}`);
      }
      let data: unknown;
      try { data = await this.json(response); }
      catch { throw new AppError("prosper_submission_unknown"); }
      const receipt = receiptSchema.safeParse(data);
      if (!receipt.success || receipt.data.call_id !== callId ||
          !receipt.data.record.actions.some((record) => sameAction(parsed.data, record))) {
        throw new AppError("prosper_submission_unknown");
      }
      return { status: "accepted", action: parsed.data, receivedAt: receipt.data.received_at };
    });
  }

  private async fetch(path: string, signal: AbortSignal, body?: string): Promise<Response> {
    signal.throwIfAborted();
    try {
      return await this.request(new URL(path, this.config.PROSPER_API_BASE_URL), {
        headers: {
          "X-Api-Key": this.config.PROSPER_API_KEY, Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { method: "POST", body } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        redirect: "error",
      });
    } catch {
      throw new AppError(body ? "prosper_submission_unknown" :
        signal.aborted ? "call_cancelled" : "prosper_network_error");
    }
  }

  private async json(response: Response): Promise<unknown> {
    try { return await response.json(); }
    catch { throw new AppError("prosper_invalid_json"); }
  }

  private async read<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, code = "prosper_invalid_response"): Promise<T> {
    const response = await this.fetch(path, signal);
    if (!response.ok) throw new AppError(`prosper_http_${response.status}`);
    const parsed = schema.safeParse(await this.json(response));
    if (!parsed.success) throw new AppError(code);
    return parsed.data;
  }
}
