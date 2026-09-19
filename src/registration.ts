import { z } from "zod";
import { newPatientSchema } from "./prosper-types.js";

export const registrationFieldNames = [
  "given_name", "first_surname", "second_surname", "national_id",
  "date_of_birth", "phone", "email", "insurer",
] as const;
export type RegistrationField = typeof registrationFieldNames[number];
export type RegistrationPatient = z.infer<typeof newPatientSchema>;
export interface ValidationIssue {
  path: string;
  code: string;
}
export interface RegistrationDraft {
  id: string;
  revision: number;
  fields: Partial<Record<RegistrationField, string>>;
}

const suppliedText = z.string().max(254).nullable().optional();
export const registrationPatchSchema = z.strictObject({
  given_name: suppliedText,
  first_surname: suppliedText,
  second_surname: suppliedText,
  national_id: suppliedText,
  date_of_birth: suppliedText,
  phone: suppliedText,
  email: suppliedText,
  insurer: suppliedText.describe("The catalogue ID of the plan the caller explicitly says they hold; use get_clinic plans to map a supplied plan name. Never default to privado or another plan. Null clears an uncertain value."),
});
export type RegistrationPatch = z.infer<typeof registrationPatchSchema>;

export function validateRegistration(fields: RegistrationDraft["fields"], callDate: string): {
  missing_fields: RegistrationField[];
  invalid_fields: RegistrationField[];
  validation_issues: ValidationIssue[];
  patient?: RegistrationPatient;
} {
  const missing = registrationFieldNames.filter((field) => !fields[field]?.trim());
  const parsed = newPatientSchema.safeParse(fields);
  const issues: ValidationIssue[] = parsed.success ? [] : parsed.error.issues.flatMap((issue) => {
    const field = registrationFieldNames.find((name) => name === issue.path[0]);
    return field && !missing.includes(field) ? [{ path: field, code: issue.code }] : [];
  });
  if (fields.date_of_birth && z.iso.date().safeParse(fields.date_of_birth).success && fields.date_of_birth > callDate) {
    issues.push({ path: "date_of_birth", code: "invalid_birth_date" });
  }
  return {
    missing_fields: missing,
    invalid_fields: registrationFieldNames.filter((field) => issues.some((issue) => issue.path === field)),
    validation_issues: [
      ...missing.map((field) => ({ path: field, code: "missing_field" })),
      ...issues,
    ],
    ...(parsed.success && !issues.length ? { patient: parsed.data } : {}),
  };
}

const questionGroups = [
  { group: "identity", fields: ["given_name", "first_surname", "second_surname", "national_id"] },
  { group: "demographics", fields: ["date_of_birth", "phone"] },
  { group: "contact_and_plan", fields: ["email", "insurer"] },
] as const;
const labels: Record<RegistrationField, string> = {
  given_name: "given name",
  first_surname: "first surname",
  second_surname: "second surname",
  national_id: "DNI or NIE, including its check letter",
  date_of_birth: "date of birth",
  phone: "contact phone number",
  email: "email address",
  insurer: "insurance plan you currently hold",
};

export function registrationGuidance(draft: RegistrationDraft, callDate: string) {
  const { patient, ...validation } = validateRegistration(draft.fields, callDate);
  const needed = new Set([...validation.missing_fields, ...validation.invalid_fields]);
  const groups = questionGroups.flatMap(({ group, fields }) => {
    const remaining = fields.filter((field) => needed.has(field));
    if (!remaining.length) return [];
    const names = remaining.map((field) => labels[field]);
    if (remaining.slice(0, 3).join(",") === "given_name,first_surname,second_surname") {
      names.splice(0, 3, "full name, including both surnames");
    }
    const description = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    return [{ group, fields: remaining, question: `Could you provide your ${description}?` }];
  });
  return {
    registration_id: draft.id,
    revision: draft.revision,
    ready: Boolean(patient),
    ...validation,
    next_question: groups[0] ?? null,
    remaining_groups: groups.map(({ group, fields }) => ({ group, fields })),
    ...(patient ? { prepare_action: { request: { action: "REGISTER", registration_id: draft.id } } } : {}),
    instruction: patient
      ? "All demographics are valid. Call prepare_action with this registration_id NOW, before reading the final summary. Then ask for explicit confirmation and wait for a new caller turn. Nothing has been submitted."
      : "Ask only the next short question group, in the caller's language. Retain supplied details; allow pauses and corrections. If the insurer name is already supplied but its ID is invalid, use get_clinic plans to resolve that name before asking again; never ask the caller for internal IDs. Do not require existing-patient verification, invent an insurer, or repair a DNI/NIE check letter. Use collect_registration again with this registration_id.",
  };
}
