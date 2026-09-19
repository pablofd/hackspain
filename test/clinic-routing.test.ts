import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import {
  assessComplaint, resolveProvider, resolveSpecialty, triageSymptomKeys,
  type ComplaintAssessment, type ComplaintInput, type RoutingProvider, type RoutingSpecialty, type TriageSymptom,
} from "../src/clinic-routing.js";

const specialties: readonly RoutingSpecialty[] = [
  { id: "SYN-GENERAL", name: "Medicina general" },
  { id: "SYN-CHILD", name: "Pediatría" },
  { id: "SYN-BONES", name: "Traumatología" },
  { id: "SYN-GYN", name: "Ginecología" },
  { id: "SYN-PHYSIO", name: "Fisioterapia" },
  { id: "SYN-SKIN", name: "Dermatología" },
];
const providers: readonly RoutingProvider[] = [
  { id: "SYN-P1", name: "Dra. Berta Sáez", specialty_id: "SYN-GENERAL", languages: ["es", "ca"] },
  { id: "SYN-P2", name: "Dr. Bruno Sáenz", specialty_id: "SYN-CHILD", languages: ["es"] },
  {
    id: "SYN-P3", name: "Dr. Celso Iglesias", specialty_id: "SYN-BONES", languages: ["es", "en"],
    leave: { start: "2026-09-14", end: "2026-09-30", reason: "Synthetic leave" },
  },
  { id: "SYN-P4", name: "Dra. Dalia Iglesia", specialty_id: "SYN-GYN", languages: ["ca"], leave: null },
  { id: "SYN-P5", name: "Èric Font", specialty_id: "SYN-PHYSIO", languages: ["ca"] },
];
const callDate = "2026-09-18";
const adultBirth = "1992-02-05";
const childBirth = "2018-07-04";

function assess(complaint: string, dateOfBirth = adultBirth): ComplaintAssessment {
  return assessComplaint({ complaint, dateOfBirth, callDate }, specialties);
}

function expectRoute(result: ComplaintAssessment, specialtyId: string): void {
  assert.equal(result.kind, "route", JSON.stringify(result));
  if (result.kind === "route") {
    assert.equal(result.specialtyId, specialtyId);
    assert.ok(specialties.some((specialty) => specialty.id === result.specialtyId && specialty.name === result.specialtyName));
  }
}

function expectEmergency(result: ComplaintAssessment, pattern: string, complaint = ""): void {
  assert.equal(result.kind, "emergency", `${complaint}: ${JSON.stringify(result)}`);
  if (result.kind === "emergency") {
    assert.equal(result.reason, "medical_emergency");
    assert.equal(result.pattern, pattern);
    assert.ok(!("specialtyId" in result));
  }
}

test("near-neighbor short surnames require clarification even when one matches exactly", () => {
  for (const query of ["Sáez", "Saenz", "Dr. Iglesias", "Iglesia"]) {
    const result = resolveProvider(query, providers);
    assert.equal(result.kind, "ambiguous");
    if (result.kind === "ambiguous") {
      assert.equal(result.reason, "provider_name_ambiguous");
      assert.equal(result.candidates.length, 2);
      assert.deepEqual(result.candidates.map(({ id }) => id),
        query.startsWith("S") ? ["SYN-P1", "SYN-P2"] : ["SYN-P3", "SYN-P4"]);
      assert.ok(result.candidates.every((candidate) => providers.some((provider) =>
        candidate.id === provider.id && candidate.name === provider.name && candidate.specialty_id === provider.specialty_id)));
    }
  }
});

test("full name, accents, titles and explicit specialty can disambiguate API providers", () => {
  for (const [query, id] of [
    [" DOCTORA   bérta  saez ", "SYN-P1"], ["Bruno Sáenz", "SYN-P2"],
    ["prof. CELSO Iglesias", "SYN-P3"], ["Dalia Iglesia", "SYN-P4"], ["Dr. Eric Font", "SYN-P5"],
  ]) {
    const result = resolveProvider(query!, providers);
    assert.equal(result.kind, "found");
    if (result.kind === "found") {
      assert.equal(result.provider.id, id);
      assert.equal(result.provider.name, providers.find((provider) => provider.id === id)?.name);
    }
  }
  const filtered = resolveProvider("Sáez", providers, { specialtyId: "SYN-GENERAL" });
  assert.equal(filtered.kind, "found");
  if (filtered.kind === "found") assert.equal(filtered.provider.id, "SYN-P1");
  const physio = resolveProvider("Dr. Eric Font", providers);
  assert.equal(physio.kind, "found");
  if (physio.kind === "found") {
    assert.equal(physio.provider.name, "Èric Font");
    assert.equal(physio.provider.specialty_id, "SYN-PHYSIO");
  }
});

test("generic name similarity is not tied to public names and never auto-selects a unique near match", () => {
  const synthetic: readonly RoutingProvider[] = [
    { id: "ID-aB1", name: "Dra. Marina Robles", specialty_id: "SYN-SKIN", languages: [] },
    { id: "ID-aB2", name: "Dr. Óscar Roble", specialty_id: "SYN-BONES", languages: [] },
  ];
  assert.equal(resolveProvider("Robles", synthetic).kind, "ambiguous");
  const near = resolveProvider("Marina Roblez", synthetic);
  assert.equal(near.kind, "ambiguous");
  if (near.kind === "ambiguous") {
    assert.equal(near.reason, "provider_name_uncertain");
    assert.deepEqual(near.candidates.map(({ id }) => id), ["ID-aB1"]);
  }
  assert.equal(resolveProvider("Marina Robles", synthetic).kind, "found");
  assert.equal(resolveProvider("ID-aB1", synthetic).kind, "found");
  assert.equal(resolveProvider("id-ab1", synthetic).kind, "not_found");
  assert.equal(resolveProvider(" ID-aB1 ", synthetic).kind, "not_found");
});

test("nonexistent providers never acquire a guessed specialty; titles and empty input are not names", () => {
  for (const query of ["Zulema Inexistente", "", "Dr.", "traumatologia", "Sa", "SYN-P1"]) {
    const result = resolveProvider(query, providers, { specialtyId: "not-an-api-specialty" });
    assert.equal(result.kind, "not_found");
    assert.ok(!("specialty_id" in result));
    assert.ok(!("provider" in result));
    assert.ok(!("candidates" in result));
  }
  for (const query of ["Zulema Inexistente", "", "Dr.", "traumatologia", "Sa"]) {
    assert.equal(resolveProvider(query, providers).kind, "not_found");
  }
});

test("leave metadata and original titles are retained without mutating the catalogue", () => {
  const before = structuredClone(providers);
  const result = resolveProvider("Celso Iglesias", providers);
  assert.equal(result.kind, "found");
  if (result.kind === "found") {
    assert.deepEqual(result.provider.leave, providers[2]?.leave);
    assert.notEqual(result.provider.leave, providers[2]?.leave);
    assert.notEqual(result.provider.languages, providers[2]?.languages);
    assert.equal(result.provider.name, "Dr. Celso Iglesias");
  }
  assert.deepEqual(providers, before);
});

test("specialty aliases in three languages resolve only to actual catalogue IDs", () => {
  for (const [id, queries] of [
    ["SYN-GENERAL", ["general practice", "family doctor", "medicina de familia", "metge de capçalera"]],
    ["SYN-CHILD", ["pediatrics", "paediatrics", "pediatría", "pediatre"]],
    ["SYN-BONES", ["orthopedics", "orthopaedics", "traumatología", "traumatòleg"]],
    ["SYN-GYN", ["gynecology", "gynaecology", "ginecología", "ginecòleg"]],
    ["SYN-PHYSIO", ["physical therapy", "fisioterapia", "fisioterapeuta"]],
    ["SYN-SKIN", ["dermatology", "dermatología", "dermatòleg"]],
  ] as const) {
    for (const query of queries) {
      const result = resolveSpecialty(query, specialties);
      assert.equal(result.kind, "found", query);
      if (result.kind === "found") assert.deepEqual(result.specialty, specialties.find((specialty) => specialty.id === id));
    }
  }
  assert.equal(resolveSpecialty("pediatrics", specialties.filter(({ id }) => id !== "SYN-CHILD")).kind, "not_found");
  assert.equal(resolveSpecialty("cardiology", specialties).kind, "not_found");
  assert.equal(resolveSpecialty("SYN-GENERAL", specialties).kind, "found");
  assert.equal(resolveSpecialty("syn-general", specialties).kind, "not_found");
  assert.equal(resolveSpecialty("", specialties).kind, "not_found");
});

test("specialty ambiguity is not resolved using catalogue order", () => {
  const duplicateFamily = [...specialties, { id: "SYN-GENERAL-2", name: "Family medicine" }];
  const result = resolveSpecialty("general practice", duplicateFamily);
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") assert.deepEqual(result.candidates.map(({ id }) => id), ["SYN-GENERAL", "SYN-GENERAL-2"]);
  assert.equal(resolveSpecialty("medicina general o pediatría", specialties).kind, "ambiguous");
  assert.equal(resolveSpecialty("orthopaedics / physiotherapy", specialties).kind, "ambiguous");
});

test("all documented injury sites route to orthopaedics in English, Spanish and Catalan", () => {
  for (const complaint of [
    "I twisted my ankle.", "I injured my arm.", "I fell and injured my knee.", "I sprained my wrist.",
    "Me torcí el tobillo.", "Tengo una lesión en el brazo.", "Me caí y tengo una lesión en la rodilla.", "Tengo un esguince en la muñeca.",
    "M'he torcat el turmell.", "Tinc una lesió al braç.", "M'he fet mal al genoll.", "Tinc una lesió al canell.",
  ]) expectRoute(assess(complaint), "SYN-BONES");
});

test("documented child fever, cough, ear and tummy complaints use verified age", () => {
  for (const complaint of [
    "My child has a fever.", "My child is coughing.", "My son has ear pain.", "My daughter has a tummy ache.",
    "Mi hijo tiene fiebre.", "Mi hija tiene tos.", "Le duele el oído.", "Le duele la barriga.",
    "El meu fill té febre.", "La meva filla té tos.", "Li fa mal l'orella.", "Li fa mal la panxa.",
  ]) expectRoute(assess(complaint, childBirth), "SYN-CHILD");
  const missingAge = assessComplaint({ complaint: "My child has a fever.", callDate }, specialties);
  assert.equal(missingAge.kind, "clarify");
  if (missingAge.kind === "clarify") assert.equal(missingAge.reason, "age_required");
});

test("a reported temperature maps to the published child fever family without structured observations", () => {
  for (const complaint of [
    "My child has had a temperature for two days and is off their food.",
    "My child is running a temperature.",
    "My child has a high temperature.",
    "My child's temperature has been raised.",
  ]) {
    const result = assessComplaint({ complaint, dateOfBirth: "2015-01-01", callDate }, specialties);
    expectRoute(result, "SYN-CHILD");
    assert.equal(result.source, "text");
    assert.deepEqual(result.symptoms, ["fever"]);
    if (result.kind === "route") assert.equal(result.ageMonths, 140);
  }
  const missingAge = assessComplaint({
    complaint: "My child has had a temperature for two days and is off their food.", callDate,
  }, specialties);
  assert.equal(missingAge.kind, "clarify");
  if (missingAge.kind === "clarify") assert.equal(missingAge.reason, "age_required");
  assert.equal(assess("I have had a temperature for two days.").kind, "clarify");
});

test("temperature mentions preserve uncertainty, negation and the limits of the published fever mapping", () => {
  for (const complaint of [
    "My child has not had a temperature and is off their food.",
    "My child might have had a temperature.",
    "My child may have had a temperature.",
    "My child could have a temperature.",
    "If my child had a temperature, which specialty would they see?",
    'The leaflet mentions "a temperature for two days".',
    "My child has a normal temperature.",
    "My child has a temperature that is normal.",
    "My child has a temperature of 36 degrees.",
    "My child has a temperature, 36 degrees.",
    "I checked my child's temperature.",
    "My child is off their food.",
  ]) assert.equal(assess(complaint, "2015-01-01").kind, "clarify", complaint);
});

test("persistent fatigue, headache, throat and dizziness route only within the published adult family", () => {
  for (const complaint of [
    "I have persistent fatigue.", "I have headaches for several weeks.", "I have a sore throat for weeks.", "I have persistent dizziness.",
    "Tengo cansancio persistente.", "Tengo dolor de cabeza desde hace varios días.", "Tengo dolor de garganta persistente.", "Tengo mareos desde hace semanas.",
    "Tinc cansament persistent.", "Tinc mal de cap des de fa setmanes.", "Tinc mal de coll persistent.", "Tinc mareig des de fa dies.",
  ]) expectRoute(assess(complaint), "SYN-GENERAL");
  assert.equal(assess("I have a headache.").kind, "clarify");
  assert.equal(assess("I have persistent fatigue.", childBirth).kind, "clarify");
});

test("all published gynaecology complaint families have multilingual routing", () => {
  for (const complaint of [
    "I have heavy periods.", "I have irregular periods.", "I have bleeding between periods.", "I have persistent low pelvic pain on one side.",
    "Tengo reglas muy abundantes.", "Tengo reglas irregulares.", "Tengo sangrado entre las reglas.", "Tengo dolor pélvico bajo persistente en un lado.",
    "Tinc regles abundants.", "Tinc regles irregulars.", "Tinc sagnat entre les regles.", "Tinc dolor pelvià baix persistent a un costat.",
  ]) expectRoute(assess(complaint), "SYN-GYN");
});

test("fourteenth birthday is calculated in full months on the supplied call day", () => {
  const beforeBirthday = assess("I have a fever.", "2012-09-19");
  expectRoute(beforeBirthday, "SYN-CHILD");
  if (beforeBirthday.kind === "route") assert.equal(beforeBirthday.ageMonths, 167);
  const onBirthday = assess("I have persistent headaches.", "2012-09-18");
  expectRoute(onBirthday, "SYN-GENERAL");
  if (onBirthday.kind === "route") assert.equal(onBirthday.ageMonths, 168);
  const afterBirthday = assess("I have persistent headaches.", "2012-09-17");
  expectRoute(afterBirthday, "SYN-GENERAL");
  if (afterBirthday.kind === "route") assert.equal(afterBirthday.ageMonths, 168);
  const noAdultExtrapolation = assess("I have a fever.", "2012-09-18");
  assert.equal(noAdultExtrapolation.kind, "clarify");
  if (noAdultExtrapolation.kind === "clarify") assert.equal(noAdultExtrapolation.reason, "age_outside_published_route");
  const nextDay = assessComplaint({ complaint: "I have persistent headaches.", dateOfBirth: "2012-09-19", callDate: "2026-09-19" }, specialties);
  expectRoute(nextDay, "SYN-GENERAL");
});

test("all eight documented emergency pattern shapes are recognized without needing patient age", () => {
  for (const [complaint, pattern] of [
    ["I have chest pain and breathlessness.", "chest_pain_with_breathlessness"],
    ["I have sudden facial droop.", "sudden_facial_droop"],
    ["One side of my face has suddenly drooped.", "sudden_facial_droop"],
    ["I have sudden arm weakness.", "sudden_arm_weakness"],
    ["My arm has suddenly gone weak.", "sudden_arm_weakness"],
    ["I have sudden slurred speech.", "sudden_slurred_speech"],
    ["I have sudden severe breathlessness.", "sudden_severe_breathlessness"],
    ["It is still bleeding after applying pressure.", "bleeding_despite_pressure"],
    ["I hit my head and now I am confused.", "head_injury_then_confusion"],
    ["I am vomiting after I hit my head.", "head_injury_then_vomiting"],
  ]) expectEmergency(assessComplaint({ complaint: complaint!, callDate }, specialties), pattern!);
});

test("pain across the chest with difficulty catching breath is recognized directly without age", () => {
  for (const complaint of [
    "Tight pain across my chest and I am struggling to catch my breath.",
    "They have tight pain across their chest and are struggling to catch their breath.",
    "She has pain in her chest and cannot catch her breath.",
    "He has pain across his chest and is unable to catch his breath.",
    "We have pain across our chest and are struggling to catch our breath.",
    "I can not catch my breath and have pain across my chest.",
  ]) {
    const result = assessComplaint({ complaint, callDate }, specialties);
    expectEmergency(result, "chest_pain_with_breathlessness", complaint);
    assert.equal(result.source, "text");
  }
});

test("new chest and breath phrases retain negation, uncertainty and hypothetical safeguards", () => {
  for (const complaint of [
    "No tight pain across my chest and I am not struggling to catch my breath.",
    "They have pain across their chest but are not struggling to catch their breath.",
    "They have no pain across their chest but are struggling to catch their breath.",
    "Maybe they have pain across their chest and are struggling to catch their breath.",
    "I may have pain across my chest and be struggling to catch my breath.",
    "If they have pain across their chest and are struggling to catch their breath, could they book?",
    'The leaflet mentions "tight pain across my chest and struggling to catch my breath".',
    "Does pain across the chest with difficulty catching breath mean an emergency?",
  ]) assert.equal(assessComplaint({ complaint, callDate }, specialties).kind, "clarify", complaint);
});

test("English, Spanish and Catalan emergency synonyms preserve complete-pattern requirements", () => {
  for (const [complaint, pattern] of [
    ["Tengo dolor en el pecho y me falta el aire.", "chest_pain_with_breathlessness"],
    ["No puedo respirar y me duele el pecho.", "chest_pain_with_breathlessness"],
    ["Em fa mal el pit i em falta l'aire.", "chest_pain_with_breathlessness"],
    ["No puc respirar i em fa mal el pit.", "chest_pain_with_breathlessness"],
    ["Tengo la boca torcida de repente.", "sudden_facial_droop"],
    ["De sobte se li torca la cara.", "sudden_facial_droop"],
    ["Tengo debilidad en un brazo de repente.", "sudden_arm_weakness"],
    ["De sobte tinc el braç sense força.", "sudden_arm_weakness"],
    ["De repente tengo el habla pastosa.", "sudden_slurred_speech"],
    ["De sobte tinc la parla arrossegada.", "sudden_slurred_speech"],
    ["De repente no puedo respirar.", "sudden_severe_breathlessness"],
    ["No puedo respirar de repente.", "sudden_severe_breathlessness"],
    ["De sobte no puc respirar.", "sudden_severe_breathlessness"],
    ["Sigue sangrando a pesar de la presión.", "bleeding_despite_pressure"],
    ["Encara sagna malgrat la pressió.", "bleeding_despite_pressure"],
    ["Tengo un golpe en la cabeza y ahora estoy confuso.", "head_injury_then_confusion"],
    ["Tinc un cop al cap i ara estic confós.", "head_injury_then_confusion"],
    ["Tengo vómitos después de un golpe en la cabeza.", "head_injury_then_vomiting"],
    ["Tinc vòmits després d'un cop al cap.", "head_injury_then_vomiting"],
  ]) expectEmergency(assess(complaint!), pattern!, complaint);
});

test("negated emergency signs and general or quoted questions do not establish an emergency", () => {
  for (const complaint of [
    "I have no chest pain or breathlessness.",
    "I have chest pain without breathlessness.",
    "I don't have chest pain or difficulty breathing.",
    "I have no sudden facial droop, sudden arm weakness or slurred speech.",
    "I do not have sudden severe breathlessness.",
    "No tengo dolor en el pecho ni me falta el aire.",
    "No tinc mal al pit ni em falta l'aire.",
    "I have a head injury but no confusion or vomiting.",
    "The bleeding stopped after pressure.",
    "The bleeding does not continue after pressure.",
    "What should someone do if they have chest pain and breathlessness?",
    "What is sudden facial droop?",
    "Do chest pain and breathlessness happen together?",
    "Should sudden facial droop be reported?",
    "Do I have chest pain and breathlessness?",
    "Can breathlessness and chest pain be an emergency?",
    "Tell me about chest pain and breathlessness.",
    "Please explain chest pain with breathlessness.",
    "I read that chest pain and breathlessness are serious.",
    'The leaflet says "sudden facial droop and arm weakness".',
    "The leaflet says 'chest pain with breathlessness'.",
    "¿Qué pasaría si tengo dolor en el pecho y falta de aire?",
    "¿Es peligroso tener dolor de pecho y falta de aire?",
    "La falta de aire con dolor de pecho es grave?",
    "Què passa si algú té mal al pit i falta d'aire?",
    "If I ever had a head injury and vomiting, could I book?",
    "I had a head injury last year and I am vomiting.",
    "I vomited before I hit my head.",
    "Chest pain no, breathlessness no.",
  ]) assert.equal(assess(complaint).kind, "clarify", complaint);
});

test("affirmed red flags outrank routine bookings while negation is scoped across contrast clauses", () => {
  expectEmergency(assess("I want a knee appointment. I have chest pain and cannot breathe."), "chest_pain_with_breathlessness");
  expectEmergency(assess("No fever, but I have chest pain and breathlessness."), "chest_pain_with_breathlessness");
  expectEmergency(assess("I hit my head and I am confused but I am not vomiting."), "head_injury_then_confusion");
  expectEmergency(assess("It does not stop bleeding after applying pressure."), "bleeding_despite_pressure");
  expectEmergency(assess("It doesn't stop bleeding after applying pressure."), "bleeding_despite_pressure");
  expectEmergency(assess("No para de sangrar después de aplicar presión."), "bleeding_despite_pressure");
  expectEmergency(assess("I am applying pressure but it is still bleeding."), "bleeding_despite_pressure");
  expectEmergency(assess("What should I do? I have chest pain and cannot breathe."), "chest_pain_with_breathlessness");
  expectEmergency(assess("Sí, tengo dolor en el pecho y me falta el aire."), "chest_pain_with_breathlessness");
  expectRoute(assess("No chest pain or breathlessness. I twisted my ankle."), "SYN-BONES");
  assert.equal(assess("I would like a routine appointment.").kind, "clarify");
});

test("uncertainty, incomplete red flags and unsupported complaints do not produce invented medical routes", () => {
  for (const complaint of [
    "Maybe I have chest pain and breathlessness.",
    "I am not sure whether I have sudden slurred speech.",
    "I have chest pain.", "I have breathlessness.", "I have sudden breathlessness.",
    "I have arm weakness.", "I have slurred speech.", "I have facial droop.",
    "I have a head injury.", "I have a rash.", "I have back pain.", "I want treatment for diabetes.",
    "I have sudden severe ankle pain and mild breathlessness.",
    "I have sudden severe anxiety with mild breathlessness.",
    "I have a sudden headache and longstanding arm weakness.",
    "I have an ankle injury and persistent fatigue.",
  ]) assert.equal(assess(complaint).kind, "clarify", complaint);
  assert.equal(assess("I have a fever.", adultBirth).kind, "clarify");
});

test("enumerated current observations provide deterministic routing for unsupported natural wording", () => {
  const cases: readonly [TriageSymptom, string, string][] = [
    ["ankle_injury", adultBirth, "SYN-BONES"], ["arm_injury", adultBirth, "SYN-BONES"],
    ["knee_injury", adultBirth, "SYN-BONES"], ["wrist_injury", adultBirth, "SYN-BONES"],
    ["fever", childBirth, "SYN-CHILD"], ["cough", childBirth, "SYN-CHILD"],
    ["ear_complaint", childBirth, "SYN-CHILD"], ["tummy_complaint", childBirth, "SYN-CHILD"],
    ["persistent_fatigue", adultBirth, "SYN-GENERAL"], ["persistent_headache", adultBirth, "SYN-GENERAL"],
    ["persistent_throat_complaint", adultBirth, "SYN-GENERAL"], ["persistent_dizziness", adultBirth, "SYN-GENERAL"],
    ["heavy_periods", adultBirth, "SYN-GYN"], ["irregular_periods", adultBirth, "SYN-GYN"],
    ["intermenstrual_bleeding", adultBirth, "SYN-GYN"], ["persistent_low_pelvic_pain", adultBirth, "SYN-GYN"],
  ];
  for (const [symptom, dateOfBirth, specialtyId] of cases) {
    const result = assessComplaint({
      complaint: "Symptoms clarified with the caller.", dateOfBirth, callDate,
      observations: [{ symptom, status: "present" }],
    }, specialties);
    expectRoute(result, specialtyId);
    assert.equal(result.source, "structured");
  }
  const routineKeys = new Set(cases.map(([symptom]) => symptom));
  for (const symptom of triageSymptomKeys.filter((key) => !routineKeys.has(key))) {
    expectEmergency(assessComplaint({
      complaint: "Current symptoms clarified.", callDate, observations: [{ symptom, status: "present" }],
    }, specialties), symptom);
  }
});

test("structured evidence must not turn uncertain, contradictory, hypothetical or negated reports into certainty", () => {
  const base: ComplaintInput = {
    complaint: "Symptoms discussed.", callDate,
    observations: [{ symptom: "chest_pain_with_breathlessness", status: "present" }],
  };
  for (const input of [
    { ...base, context: "hypothetical" as const },
    { ...base, context: "uncertain" as const },
    { ...base, complaint: "What should someone do if they have chest pain and breathlessness?" },
    { ...base, complaint: "I have no chest pain or breathlessness." },
    { ...base, observations: [{ symptom: "chest_pain_with_breathlessness" as const, status: "absent" as const }] },
    { ...base, observations: [{ symptom: "chest_pain_with_breathlessness" as const, status: "uncertain" as const }] },
    {
      ...base, observations: [
        { symptom: "chest_pain_with_breathlessness" as const, status: "present" as const },
        { symptom: "chest_pain_with_breathlessness" as const, status: "absent" as const },
      ],
    },
  ]) assert.equal(assessComplaint(input, specialties).kind, "clarify");
  expectEmergency(assessComplaint({
    ...base, complaint: "I have chest pain and breathlessness.",
    observations: [{ symptom: "ankle_injury", status: "present" }],
  }, specialties), "chest_pain_with_breathlessness");
});

test("routing never invents IDs when a specialty is absent or ambiguous", () => {
  const absent = assessComplaint({ complaint: "I twisted my ankle.", callDate }, []);
  assert.equal(absent.kind, "clarify");
  if (absent.kind === "clarify") assert.equal(absent.reason, "specialty_unavailable");
  const ambiguous = assessComplaint({ complaint: "I twisted my ankle.", callDate }, [
    ...specialties, { id: "SYN-BONES-2", name: "Orthopaedics" },
  ]);
  assert.equal(ambiguous.kind, "clarify");
  if (ambiguous.kind === "clarify") assert.equal(ambiguous.reason, "specialty_ambiguous");
  expectEmergency(assessComplaint({ complaint: "I have chest pain and cannot breathe.", callDate }, []), "chest_pain_with_breathlessness");
});

test("invalid dates and observation keys produce safe AppError codes", () => {
  for (const badCallDate of ["2026-02-30", "2026-13-01", "2026-09-18T22:00:00Z", "18/09/2026", "0000-01-01"]) {
    assert.throws(() => assessComplaint({ complaint: "I have a fever.", callDate: badCallDate }, specialties),
      (error: unknown) => error instanceof AppError && error.code === "invalid_call_date");
  }
  for (const badBirthDate of ["2012-02-30", "2027-01-01", "yesterday"]) {
    assert.throws(() => assess("I have persistent fatigue.", badBirthDate),
      (error: unknown) => error instanceof AppError && error.code === "invalid_date_of_birth");
  }
  const invalid = { complaint: "Reported symptoms.", callDate, observations: [{ symptom: "diagnose_stroke", status: "present" }] };
  assert.throws(() => assessComplaint(invalid as unknown as ComplaintInput, specialties),
    (error: unknown) => error instanceof AppError && error.code === "invalid_complaint");
});
