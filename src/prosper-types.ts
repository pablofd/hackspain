import { z } from "zod";

export const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const insurerSchema = z.enum([
  "sanitas", "adeslas", "dkv", "asisa", "mapfre", "caser", "cigna", "axa", "nueva_mutua", "privado",
]);
export const reasonSchema = z.enum([
  "not_eligible_age", "referral_required", "provider_not_in_network", "specialty_not_covered",
  "location_not_covered", "insurer_referral_required", "allowance_exhausted", "provider_on_leave",
  "location_hours", "type_not_offered", "patient_history", "no_availability", "clinic_closed",
  "patient_not_found", "provider_not_found", "caller_not_authorised", "out_of_scope", "medical_emergency",
]);
export type Insurer = z.infer<typeof insurerSchema>;
export type OutcomeReason = z.infer<typeof reasonSchema>;

export function normalizeNationalId(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function validNationalId(value: string): boolean {
  const normalized = normalizeNationalId(value);
  if (!/^(?:\d{8}|[XYZ]\d{7})[A-Z]$/.test(normalized)) return false;
  const digits = normalized.slice(0, -1).replace(/^[XYZ]/, (letter) => String("XYZ".indexOf(letter)));
  return "TRWAGMYFPDXBNJZSQVHLCKE"[Number(digits) % 23] === normalized.at(-1);
}

export function nationalPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("0034")) return digits.slice(4);
  if (digits.length === 11 && digits.startsWith("34")) return digits.slice(2);
  return digits;
}

const text = z.string().trim().min(1).max(200);
export function normalizeHumanText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export const patientQuerySchema = z.strictObject({
  name: text.optional(),
  national_id: text.optional(),
  phone: text.optional(),
  date_of_birth: z.iso.date().optional(),
}).refine((query) => Object.values(query).some(Boolean), "At least one identifier is required");
export type PatientQuery = z.infer<typeof patientQuerySchema>;

export const patientSchema = z.object({
  patient_id: idSchema,
  given_name: z.string(),
  first_surname: z.string(),
  second_surname: z.string(),
  national_id: z.string(),
  date_of_birth: z.iso.date(),
  phone: z.string(),
  has_visited_before: z.boolean(),
  insurer: insurerSchema,
  referrals: z.array(z.string()),
  note: z.string(),
  matched_fields: z.array(z.string()),
});
export type Patient = z.infer<typeof patientSchema>;
export const directorySchema = z.object({ matches: z.array(patientSchema) });

export const slotSchema = z.object({
  provider_id: idSchema,
  provider_name: z.string(),
  specialty_id: idSchema,
  location_id: idSchema,
  appointment_type_id: idSchema,
  start_time: z.iso.datetime({ offset: true }),
  duration_minutes: z.number().int().positive(),
  payable_with: z.array(insurerSchema),
});
export type Slot = z.infer<typeof slotSchema>;

export const availabilitySchema = z.object({
  providers: z.array(z.object({
    id: idSchema, name: z.string(), specialty_id: idSchema, languages: z.array(z.string()),
  })),
  appointment_type: z.object({
    id: idSchema, name: z.string(), duration_minutes: z.number().int().positive(), guidance: z.string(),
  }).passthrough(),
  slots: z.array(slotSchema),
  blocked: z.array(z.object({ provider_id: idSchema, restriction: reasonSchema })),
});
export type Availability = z.infer<typeof availabilitySchema>;
export const availabilityQuerySchema = z.strictObject({
  patient_id: idSchema,
  date_from: z.iso.date(),
  date_to: z.iso.date(),
  specialty_id: idSchema.optional(),
  provider_id: idSchema.optional(),
  location_id: idSchema.optional(),
  insurer: z.array(insurerSchema).min(1).max(2).optional(),
}).refine((query) => Boolean(query.specialty_id || query.provider_id), "A specialty or provider is required");
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const appointmentSchema = z.object({
  appointment_id: idSchema,
  patient_id: idSchema,
  provider_id: idSchema,
  location_id: idSchema,
  appointment_type_id: idSchema,
  start_time: z.iso.datetime({ offset: true }),
  duration_minutes: z.number().int().positive(),
});
export type Appointment = z.infer<typeof appointmentSchema>;
export const appointmentsSchema = z.object({ appointments: z.array(appointmentSchema) });

export const newPatientSchema = z.strictObject({
  given_name: text,
  first_surname: text,
  second_surname: text,
  national_id: text.refine(validNationalId, "Confirm all digits and the DNI/NIE check letter"),
  date_of_birth: z.iso.date(),
  phone: text.refine((value) => /^\d{9}$/.test(nationalPhone(value)), "A Spanish phone number is required"),
  email: z.string().max(254).transform((value) => value.replace(/\s+/g, "").toLowerCase()).pipe(z.email()),
  insurer: insurerSchema,
});
export const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("BOOK"), patient_id: idSchema, provider_id: idSchema,
    location_id: idSchema, appointment_type_id: idSchema,
    slot: z.iso.datetime({ offset: true }), policy_id: insurerSchema,
  }),
  z.strictObject({
    action: z.literal("RESCHEDULE"), appointment_id: idSchema,
    provider_id: idSchema, location_id: idSchema, slot: z.iso.datetime({ offset: true }),
    policy_id: insurerSchema,
  }),
  z.strictObject({ action: z.literal("CANCEL"), appointment_id: idSchema }),
  z.strictObject({ action: z.literal("REGISTER"), new_patient: newPatientSchema }),
  z.strictObject({ action: z.literal("NO_ACTION"), reason: reasonSchema }),
  z.strictObject({ action: z.literal("ESCALATE"), reason: reasonSchema }),
]);
export type ProsperAction = z.infer<typeof actionSchema>;
export const receiptSchema = z.object({
  call_id: idSchema, received_at: z.iso.datetime({ offset: true }),
  record: z.object({ actions: z.array(actionSchema).min(1) }),
});
export type Receipt = z.infer<typeof receiptSchema>;
export type SubmissionResult = {
  status: "accepted" | "duplicate";
  action: ProsperAction;
  receivedAt?: string;
};

export function sameAction(left: ProsperAction, right: ProsperAction): boolean {
  const canonical = (value: ProsperAction) => JSON.stringify(actionSchema.parse({
    ...value,
    ...("slot" in value ? { slot: new Date(value.slot).toISOString() } : {}),
  }));
  return canonical(left) === canonical(right);
}
