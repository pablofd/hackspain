import { z } from "zod";
import { AppError } from "./errors.js";

export interface RoutingProvider {
  readonly id: string;
  readonly name: string;
  readonly specialty_id: string;
  readonly languages: readonly string[];
  readonly leave?: { readonly start: string; readonly end: string; readonly reason: string } | null;
}

export interface RoutingSpecialty {
  readonly id: string;
  readonly name: string;
}

export type ProviderResolution =
  | { kind: "found"; provider: RoutingProvider; match: "id" | "name" }
  | {
    kind: "ambiguous";
    candidates: readonly RoutingProvider[];
    reason: "provider_name_ambiguous" | "provider_name_uncertain";
    clarification: string;
  }
  | { kind: "not_found"; reason: "provider_not_found"; clarification: string };

export type SpecialtyResolution =
  | { kind: "found"; specialty: RoutingSpecialty }
  | {
    kind: "ambiguous";
    candidates: readonly RoutingSpecialty[];
    reason: "specialty_ambiguous";
    clarification: string;
  }
  | { kind: "not_found"; reason: "specialty_not_found"; clarification: string };

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function nameTokens(value: string): string[] {
  const tokens = normalize(value).split(" ").filter(Boolean);
  while (/^(?:dr|dra|doctor|doctora|prof|professor|professora|profesor|profesora|sr|sra|senor|senora|don|dona)$/.test(tokens[0] ?? "")) {
    tokens.shift();
  }
  return tokens;
}

function neighboringToken(left: string, right: string): boolean {
  if (Math.min(left.length, right.length) < 4 || Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const differences = [...left].flatMap((letter, index) => letter === right[index] ? [] : [index]);
    if (differences.length === 1) return true;
    const [first, second] = differences;
    return differences.length === 2 && first !== undefined && second === first + 1 &&
      left[first] === right[second] && left[second] === right[first];
  }
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index += 1;
  return shorter.slice(index) === longer.slice(index + 1);
}

function nameMatch(query: readonly string[], name: string): "exact" | "near" | undefined {
  const remaining = nameTokens(name);
  if (query.length === 0 || query.length > remaining.length) return undefined;
  const missing: string[] = [];
  for (const token of query) {
    const index = remaining.indexOf(token);
    if (index === -1) missing.push(token);
    else remaining.splice(index, 1);
  }
  if (missing.length === 0) return "exact";
  if (missing.length === 1 && remaining.some((token) => neighboringToken(missing[0]!, token))) return "near";
  return undefined;
}

function providerCopy(provider: RoutingProvider): RoutingProvider {
  return {
    id: provider.id,
    name: provider.name,
    specialty_id: provider.specialty_id,
    languages: [...provider.languages],
    ...(provider.leave === undefined ? {} : { leave: provider.leave === null ? null : { ...provider.leave } }),
  };
}

/** A unique fuzzy suggestion is still ambiguous: the caller must confirm it. */
export function resolveProvider(
  query: string,
  providers: readonly RoutingProvider[],
  filters: { specialtyId?: string } = {},
): ProviderResolution {
  const eligible = providers.filter((provider) =>
    filters.specialtyId === undefined || provider.specialty_id === filters.specialtyId);
  const byId = eligible.filter((provider) => provider.id === query);
  if (byId.length === 1) return { kind: "found", provider: providerCopy(byId[0]!), match: "id" };
  const tokens = nameTokens(query);
  const matches = byId.length > 1
    ? byId.map((provider) => ({ provider, match: "exact" as const }))
    : eligible.flatMap((provider) => {
      const match = nameMatch(tokens, provider.name);
      return match === undefined ? [] : [{ provider, match }];
    });
  if (matches.length === 1 && matches[0]?.match === "exact") {
    return { kind: "found", provider: providerCopy(matches[0].provider), match: "name" };
  }
  if (matches.length > 0) {
    return {
      kind: "ambiguous",
      candidates: matches.map(({ provider }) => providerCopy(provider)),
      reason: matches.length > 1 ? "provider_name_ambiguous" : "provider_name_uncertain",
      clarification: "Confirm the provider's full name or specialty before selecting an ID.",
    };
  }
  return {
    kind: "not_found",
    reason: "provider_not_found",
    clarification: "Ask for the provider's name again; do not infer a specialty.",
  };
}

const specialtyAliases = {
  general_practice: [
    "general practice", "general practitioner", "family medicine", "family doctor", "gp",
    "medicina general", "medico general", "medica general", "medicina de familia",
    "medicina familiar", "medico de familia", "medica de familia", "atencion primaria",
    "atencio primaria", "metge de familia", "metgessa de familia", "metge de capcalera", "metgessa de capcalera",
  ],
  paediatrics: [
    "paediatrics", "pediatrics", "paediatrician", "pediatrician", "pediatria",
    "pediatra", "pediatre", "pediatrica", "pediatrico",
  ],
  orthopaedics: [
    "orthopaedics", "orthopedics", "orthopaedic", "orthopedic", "orthopaedist", "orthopedist",
    "traumatologia", "traumatologo", "traumatologa", "traumatoleg", "ortopedia",
  ],
  gynaecology: [
    "gynaecology", "gynecology", "gynaecologist", "gynecologist", "ginecologia",
    "ginecologo", "ginecologa", "ginecoleg",
  ],
  physiotherapy: [
    "physiotherapy", "physical therapy", "physiotherapist", "fisioterapia", "fisioterapeuta", "fisio",
  ],
  dermatology: [
    "dermatology", "dermatologist", "dermatologia", "dermatologo", "dermatologa", "dermatoleg",
  ],
} as const;

type SpecialtyFamily = keyof typeof specialtyAliases;
const specialtyFamilies = Object.keys(specialtyAliases) as SpecialtyFamily[];
const familyIds: Readonly<Record<SpecialtyFamily, readonly string[]>> = {
  general_practice: ["general_practice"],
  paediatrics: ["paediatrics", "pediatrics"],
  orthopaedics: ["orthopaedics", "orthopedics"],
  gynaecology: ["gynaecology", "gynecology"],
  physiotherapy: ["physiotherapy"],
  dermatology: ["dermatology"],
};

function catalogueHasFamily(specialty: RoutingSpecialty, family: SpecialtyFamily): boolean {
  const name = ` ${normalize(specialty.name)} `;
  return familyIds[family].includes(specialty.id) ||
    specialtyAliases[family].some((alias) => name.includes(` ${alias} `));
}

export function resolveSpecialty(query: string, specialties: readonly RoutingSpecialty[]): SpecialtyResolution {
  const byId = specialties.filter((specialty) => specialty.id === query);
  const terms = query.split(/\s+(?:or|o)\s+|[/,;|]/i).map(normalize).filter(Boolean);
  const families = specialtyFamilies.filter((family) =>
    specialtyAliases[family].some((alias) => terms.includes(alias)));
  const candidates = (byId.length > 0 ? byId : specialties.filter((specialty) =>
    terms.includes(normalize(specialty.name)) || families.some((family) => catalogueHasFamily(specialty, family))))
    .map(({ id, name }) => ({ id, name }));
  if (candidates.length === 1) return { kind: "found", specialty: candidates[0]! };
  if (candidates.length > 1) {
    return {
      kind: "ambiguous", candidates, reason: "specialty_ambiguous",
      clarification: "Ask which of the catalogue specialties the caller means.",
    };
  }
  return {
    kind: "not_found", reason: "specialty_not_found",
    clarification: "Clarify the requested specialty using the clinic catalogue.",
  };
}

/** Compound keys require every qualifier, including onset, persistence and chronology. */
export const triageSymptomKeys = [
  "ankle_injury", "arm_injury", "knee_injury", "wrist_injury",
  "fever", "cough", "ear_complaint", "tummy_complaint",
  "persistent_fatigue", "persistent_headache", "persistent_throat_complaint", "persistent_dizziness",
  "heavy_periods", "irregular_periods", "intermenstrual_bleeding", "persistent_low_pelvic_pain",
  "chest_pain_with_breathlessness",
  "sudden_facial_droop", "sudden_arm_weakness", "sudden_slurred_speech",
  "sudden_severe_breathlessness", "bleeding_despite_pressure",
  "head_injury_then_confusion", "head_injury_then_vomiting",
] as const;

export type TriageSymptom = typeof triageSymptomKeys[number];
export type SymptomStatus = "present" | "absent" | "uncertain";
export interface TriageObservation {
  readonly symptom: TriageSymptom;
  readonly status: SymptomStatus;
}
export interface ComplaintInput {
  readonly complaint: string;
  /** Verified ISO birth date; do not infer age from words such as "child" or "daughter". */
  readonly dateOfBirth?: string;
  /** The call's Europe/Madrid calendar date, YYYY-MM-DD, not the machine date. */
  readonly callDate: string;
  readonly context?: "reported" | "hypothetical" | "uncertain";
  /** Caller-affirmed current observations, not hypothetical or quoted symptoms. */
  readonly observations?: readonly TriageObservation[];
}

type AssessmentSource = "text" | "structured";
type RouteReason = "published_injury" | "published_child_complaint" |
  "published_persistent_complaint" | "published_gynaecology_complaint";
type ClarificationReason = "reported_symptoms_unclear" | "uncertain_symptoms" | "symptom_details_required" |
  "no_published_match" | "age_required" | "age_outside_published_route" |
  "multiple_published_routes" | "specialty_unavailable" | "specialty_ambiguous";
type EmergencySymptom = Extract<TriageSymptom,
  "chest_pain_with_breathlessness" | "sudden_facial_droop" | "sudden_arm_weakness" |
  "sudden_slurred_speech" | "sudden_severe_breathlessness" | "bleeding_despite_pressure" |
  "head_injury_then_confusion" | "head_injury_then_vomiting">;

interface AssessmentEvidence {
  source: AssessmentSource;
  symptoms: readonly TriageSymptom[];
}
export type ComplaintAssessment =
  | (AssessmentEvidence & {
    kind: "route"; specialtyId: string; specialtyName: string; reason: RouteReason; ageMonths: number | null;
  })
  | (AssessmentEvidence & { kind: "emergency"; reason: "medical_emergency"; pattern: EmergencySymptom })
  | (AssessmentEvidence & {
    kind: "clarify"; reason: ClarificationReason; clarification: string;
    requiresEmergencyClarification: boolean;
  });

const complaintInputSchema = z.object({
  complaint: z.string().max(12_000),
  dateOfBirth: z.string().optional(),
  callDate: z.string(),
  context: z.enum(["reported", "hypothetical", "uncertain"]).optional(),
  observations: z.array(z.object({
    symptom: z.enum(triageSymptomKeys),
    status: z.enum(["present", "absent", "uncertain"]),
  }).strict()).max(100).optional(),
}).strict();

const emergencySymptoms: readonly EmergencySymptom[] = [
  "chest_pain_with_breathlessness", "sudden_facial_droop", "sudden_arm_weakness", "sudden_slurred_speech",
  "sudden_severe_breathlessness", "bleeding_despite_pressure", "head_injury_then_confusion", "head_injury_then_vomiting",
];
const routeGroups: readonly { family: SpecialtyFamily; reason: RouteReason; symptoms: readonly TriageSymptom[] }[] = [
  { family: "orthopaedics", reason: "published_injury", symptoms: ["ankle_injury", "arm_injury", "knee_injury", "wrist_injury"] },
  { family: "paediatrics", reason: "published_child_complaint", symptoms: ["fever", "cough", "ear_complaint", "tummy_complaint"] },
  {
    family: "general_practice", reason: "published_persistent_complaint",
    symptoms: ["persistent_fatigue", "persistent_headache", "persistent_throat_complaint", "persistent_dizziness"],
  },
  {
    family: "gynaecology", reason: "published_gynaecology_complaint",
    symptoms: ["heavy_periods", "irregular_periods", "intermenstrual_bleeding", "persistent_low_pelvic_pain"],
  },
];

function parseDate(value: string, code: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new AppError(code, "Use a valid calendar date in YYYY-MM-DD format.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(`${value}T12:00:00Z`);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new AppError(code, "Use a valid calendar date in YYYY-MM-DD format.");
  }
  return { year, month, day };
}

function ageInMonths(dateOfBirth: string | undefined, callDate: string): number | null {
  if (dateOfBirth === undefined) return null;
  const birth = parseDate(dateOfBirth, "invalid_date_of_birth");
  const call = parseDate(callDate, "invalid_call_date");
  if (dateOfBirth > callDate) throw new AppError("invalid_date_of_birth", "Birth date must not be after the call date.");
  return (call.year - birth.year) * 12 + call.month - birth.month - (call.day < birth.day ? 1 : 0);
}

const words = {
  chest: /\b(?:chest pain|chest hurts|pain (?:in|across) (?:(?:my|your|the|his|her|their|our) )?chest|dolor (?:en (?:el |mi )?|de )?(?:pecho|torax)|me duele el pecho|mal (?:al|de) pit|dolor (?:al|de) pit|em fa mal el pit)\b/,
  breath: /\b(?:breathless(?:ness)?|short(?:ness)? of breath|difficulty breathing|hard to breathe|(?:cannot|can not|unable to|not able to|struggling to) (?:breathe|catch (?:(?:my|your|his|her|their|our|a|the) )?(?:own )?breath)|falta (?:de |el |l |d )?aire|dificultad para respirar|(?:me|le) cuesta respirar|no pued[eo] respirar|ofegat|ofegada|(?:em|li) costa respirar|dificultat per respirar|no (?:puc|pot) respirar)\b/,
  sudden: /\b(?:sudden(?:ly)?|all of a sudden|de repente|repentino|repentina|subito|subita|de sobte|sobtat|sobtada|de cop)\b/,
  severe: /\b(?:severe(?:ly)?|extreme(?:ly)?|very (?:breathless|short of breath|hard to breathe)|(?:cannot|can not|unable to|not able to|struggling to) (?:breathe|catch (?:(?:my|your|his|her|their|our|a|the) )?(?:own )?breath)|no pued[eo] respirar|no (?:puc|pot) respirar|sever[ao]|grave|intens[oa]|muchisimo|muchisima|greu|molt|forta)\b/,
  face: /\b(?:facial droop|drooping (?:face|mouth)|(?:face|mouth) (?:is |has |suddenly )*droop(?:ing|s|ed)?|side of (?:my |his |her |the )?face (?:is |has |suddenly )*droop(?:ing|s|ed)?|(?:cara|boca) (?:caida|torcida)|se (?:me |le )?(?:cae|ha caido) (?:un lado de )?(?:la )?(?:cara|boca)|(?:cara|boca) caiguda|se li torca la cara)\b/,
  armWeakness: /\b(?:arm (?:is |feels? |has |gone |become |suddenly )*weak(?:ness)?|weakness (?:(?:in|of) )?(?:(?:one|my|an|the) )?(?:(?:left|right) )?arm|brazo (?:debil|sin fuerza)|debilidad (?:repentina |subita )?(?:en )?(?:(?:el|un|mi) )?brazo|brac (?:debil|sense forca)|debilitat (?:sobtada )?(?:en |al )?(?:(?:un|el) )?brac)\b/,
  speech: /\b(?:slurred speech|speech (?:is |became |has become |suddenly )*slurred|slurring (?:my|his|her|their) words|habla (?:pastosa|arrastrada)|no (?:puedo|puede) articular|parla (?:arrossegada|pastosa)|dificultat per parlar|no (?:puc|pot) articular)\b/,
  bleeding: /\b(?:bleeding|bleeds|sangrado|sangrando|sangrar|sangra|sangro|sagnat|sagnant|sagnar|sagna)\b/,
  pressure: /\b(?:pressure|pressing|pressed|compression|presion|presionar|presionando|apretando|apretado|compresion|pressio|prement|premut|pressionant)\b/,
  continuing: /\b(?:still|keeps?|continues?|continuing|does not stop|has not stopped|not stopping|will not stop|no para|no se detiene|no ha parado|sigue|continua|segueix|no s atura|encara|no deixa de)\b/,
  afterPressure: /\b(?:after|despite|even with|even though|although|while|but|despues|tras|a pesar|pese|aunque|pero|despres|malgrat|tot i|mentre|amb pressio)\b/,
  head: /\b(?:head injury|head trauma|injured (?:my|his|her|the) head|hit (?:my|his|her|the) head|bumped (?:my|his|her|the) head|golpe (?:en )?(?:la )?cabeza|(?:me|se) golpeo la cabeza|traumatismo craneal|cop al cap)\b/,
  confusion: /\b(?:confused|confusion|disoriented|confus[oa]|desorientad[oa]|confus|confos|confosa|desorientat)\b/,
  vomiting: /\b(?:vomit(?:ing|ed|s)?|throwing up|threw up|vomitos|vomitando|vomitar|vomita|vomitant|vomits)\b/,
  injury: /\b(?:injur(?:y|ies|ed)|twist(?:ed)?|sprain(?:ed)?|fractur(?:e|ed)|broken|broke|fell|hurt (?:my|his|her|the)|lesion|torci|torcedura|esguince|golpe|caida|me cai|me hice dano|m he fet mal|m he torcat|torcada|esquinc|lesio|trencat|cop|caigut)\b/,
  ankle: /\b(?:ankle|tobillo|turmell)\b/,
  arm: /\b(?:arm|brazo|brac)\b/,
  knee: /\b(?:knee|rodilla|genoll)\b/,
  wrist: /\b(?:wrist|muneca|canell)\b/,
  // Colloquial "a temperature" reports fever; a measurement alone does not.
  fever: /\b(?:fever|feverish|a temperature(?!\s*(?:of\b|reading\b|measurement\b|(?:that )?is normal\b|,?\s*\d))|(?:high|raised|elevated) temperature|temperature (?:is |has been )?(?:high|raised|elevated)|fiebre|febre)\b/,
  cough: /\b(?:cough(?:ing)?|tos)\b/,
  ear: /\b(?:earache|ear pain|sore ear|ear hurts|dolor (?:de|en el) oido|duele el oido|mal d orella|fa mal l orella)\b/,
  tummy: /\b(?:tummy (?:ache|pain|hurts)|stomach ?ache|stomach pain|stomach hurts|dolor (?:de |en la )?barriga|dolor abdominal|duele la barriga|mal de panxa|fa mal la panxa)\b/,
  persistent: /\b(?:persistent|persisting|ongoing|every day|for (?:\d+|several|many|a few|two|three|four) (?:days|weeks|months)|for weeks|for months|persistente|continuo|recurrente|desde hace|varios dias|varias semanas|cada dia|des de fa|fa (?:dies|setmanes|mesos))\b/,
  fatigue: /\b(?:fatigue|fatigued|tired(?:ness)?|exhausted|exhaustion|cansancio|cansad[oa]|fatiga|cansament|cansat|esgotament)\b/,
  headache: /\b(?:headaches?|head ache|dolor de cabeza|duele la cabeza|mal de cap|fa mal el cap)\b/,
  throat: /\b(?:sore throat|throat pain|throat discomfort|throat hurts|dolor de garganta|duele la garganta|mal de coll|fa mal el coll)\b/,
  dizziness: /\b(?:dizziness|dizzy|lightheaded|mareos?|maread[oa]|mareig|marejat|marejada)\b/,
  heavyPeriods: /\b(?:heavy (?:menstrual )?periods?|periods? (?:are |is )?heavy|sangrado menstrual abundante|menstruacion(?:es)? abundantes?|reglas? (?:muy )?abundantes?|menstruacio abundant|menstruacions abundants|regles? abundants?|sagnat menstrual abundant)\b/,
  irregularPeriods: /\b(?:irregular periods?|periods? (?:are |is )?irregular|irregular menstruation|reglas? irregular(?:es)?|menstruacion(?:es)? irregular(?:es)?|regles? irregulars?|menstruacio irregular)\b/,
  betweenPeriods: /\b(?:intermenstrual bleeding|bleeding between (?:my )?periods|sangrado intermenstrual|sangr(?:ado|o) entre (?:las )?(?:reglas|menstruaciones)|sagnat intermenstrual|sagn(?:at|o) entre (?:les )?regles)\b/,
  pelvic: /\b(?:low(?:er)? pelvic pain|pain low in (?:my|the) pelvis|dolor pelvico bajo|dolor en (?:el )?bajo vientre|dolor (?:en la parte baja de la|bajo en la) pelvis|dolor pelvia baix|dolor a la part baixa de la pelvis)\b/,
} as const;

type WordKey = keyof typeof words;
interface Mention { status: SymptomStatus; order: number; end: number }
interface TextEvidence {
  observations: TriageObservation[];
  nonReport: boolean;
  incompleteEmergency: boolean;
}

const nonStopping = /\b(?:does not stop|has not stopped|not stopping|will not stop|no para|no se detiene|no ha parado|no s atura|no deixa de)\b/g;
const affirmativeInability = /\b(?:(?:can not|not able to) (?:breathe|catch (?:(?:my|your|his|her|their|our|a|the) )?(?:own )?breath)|no pued[eo] respirar|no (?:puc|pot) respirar|brazo sin fuerza|brac sense forca|no (?:puedo|puede|puc|pot) articular)\b/g;
const negation = /\b(?:no|not|never|without|denies|deny|denied|sin|niega|ni|sense|nega|mai|neither)\b/;
const uncertainty = /\b(?:maybe|perhaps|possibly|not sure|unsure|might|may (?:have|be)|could have|do i have|could i have|creo que|quizas|tal vez|no se si|no estoy segur[oa]|potser|no estic segur[oa])\b/;
const hypothetical = /\b(?:if|suppose|imagine|hypothetical|hypothetically|for example|in general|en caso de|hipotetic[oa]|por ejemplo|en general|per exemple|si)\b/;
const historical = /\b(?:last year|years? ago|used to|history of|el ano pasado|hace anos|antecedentes de|l any passat|fa anys)\b/;
const generalQuestion = /^(?:what|how|could|would|should|is|are|does|do|can (?:someone|a person|chest|breathlessness|you explain|you tell)|(?:please )?(?:tell me about|explain|define)|information about|i (?:want|need) (?:information|to know)|que|como|podria|puede (?:alguien|una persona)|es (?:normal|peligroso|grave)|com|explica)\b/;
const generalReference = /^(?:the (?:leaflet|website|book|article)|i (?:read|heard)|he leido|he llegit|el folleto|el web|la web|segun|segons)\b/;
const currentReport = /\b(?:(?:i|he|she|we|they|patient|child|son|daughter) (?:have|has|am|is|are|feel|feels|cannot)|tengo|tiene|me duele|le duele|estoy|siento|llevo|me falta|le falta|no puedo|no puede|tinc|em fa mal|li fa mal|estic|em falta|li falta|no puc|no pot)\b/;
const qualifierLinks = new Set((
  "is are was became become has have been feels feel very extremely sudden suddenly severe severely " +
  "de repente grave severa severo subito subita sobtat sobtada greu muy molt i am tengo tiene tinc te " +
  "la el l the my his her our a an mi me le em li un una one in on en unilateral left right now ahora ara came started ha comenzado forma modo"
).split(" "));

function mergeStatus(left: SymptomStatus | undefined, right: SymptomStatus): SymptomStatus {
  return left === undefined || left === right ? right : "uncertain";
}

function mentions(clause: string, pattern: RegExp, order: number): Mention[] {
  return [...clause.matchAll(new RegExp(pattern.source, "g"))].map((match) => {
    const before = clause.slice(0, match.index)
      .replace(nonStopping, "").replace(affirmativeInability, "").replace(/\b(?:not only|no solo|no nomes)\b/g, "")
      .replace(/\b(?:not (?:sudden|severe)|no (?:repentin[oa]|sever[oa]|sobtat|sobtada|greu))\b/g, "");
    const after = clause.slice(match.index + match[0].length);
    const deniedAfter = /^(?:\s+(?:is|are|was|were|esta|es))?\s+(?:absent|denied|not present|ruled out|descartad[oa])\b/.test(after) ||
      /^\s+no\s*(?:$|,)/.test(after);
    return {
      status: negation.test(before) || deniedAfter ? "absent" : uncertainty.test(clause) ? "uncertain" : "present",
      order: order + match.index,
      end: order + match.index + match[0].length,
    };
  });
}

function recognizeText(complaint: string): TextEvidence {
  const unquoted = complaint.replace(/"[^"]*"|“[^”]*”|«[^»]*»|(?:^|\s)'[^']+'(?=\s|[.!?,;]|$)/g, " ");
  const prose = unquoted.replace(/\bsí(?=\s|[,.;!?:]|$)/gi, "afirmativamente")
    .normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/\bcan['’]t\b/g, "cannot").replace(/\bwon['’]t\b/g, "will not")
    .replace(/\b(do|does|is|are|was|were|have|has|did)n['’]t\b/g, "$1 not")
    .replace(/[^\p{L}\p{N}.!?,;\n]+/gu, " ").replace(/[^\S\n]+/g, " ");
  const all = new Map<WordKey, Mention[]>();
  const observations = new Map<TriageSymptom, SymptomStatus>();
  let nonReport = unquoted !== complaint;
  let usableClauses = 0;
  const clauses = (prose.match(/[^.!?;\n]+[.!?;\n]?/g) ?? []).flatMap((sentence) => {
    if (sentence.trimEnd().endsWith("?") && !currentReport.test(sentence)) {
      nonReport = true;
      return [];
    }
    return sentence.replace(/[.!?;\n]$/, "").split(/\b(?:but|however|pero|sin embargo|encara que)\b|,(?=\s*(?:i have|i am|he has|she has|tengo|tiene|tinc|em fa|me duele))|\b(?:and|y|i)\s+(?=(?:i|he|she|we|they)\s+(?:have|has|am|is|are)|tengo\b|tiene\b|tinc\b)/);
  });
  const set = (symptom: TriageSymptom, status: SymptomStatus): void => {
    observations.set(symptom, mergeStatus(observations.get(symptom), status));
  };
  for (const [index, clause] of clauses.entries()) {
    if (!clause.trim()) continue;
    if (hypothetical.test(clause.trim()) || historical.test(clause) ||
      ((generalQuestion.test(clause.trim()) || generalReference.test(clause.trim())) && !currentReport.test(clause))) {
      nonReport = true;
      continue;
    }
    const local = new Map<WordKey, Mention[]>();
    for (const key of Object.keys(words) as WordKey[]) {
      const found = mentions(clause, words[key], index * 20_000);
      local.set(key, found);
      all.set(key, [...(all.get(key) ?? []), ...found]);
    }
    if ([...local.values()].some((found) => found.length > 0)) usableClauses += 1;
    const status = (key: WordKey): SymptomStatus | undefined =>
      local.get(key)?.reduce<SymptomStatus | undefined>((result, mention) => mergeStatus(result, mention.status), undefined);
    const associated = (modifier: WordKey, symptom: WordKey): boolean =>
      (local.get(modifier) ?? []).some((left) => (local.get(symptom) ?? []).some((right) => {
        if (left.order <= right.end && right.order <= left.end) return true;
        const gap = clause.slice(Math.min(left.end, right.end) - index * 20_000, Math.max(left.order, right.order) - index * 20_000).trim();
        return gap === "" || gap.split(/\s+/).every((word) => qualifierLinks.has(word));
      }));
    const combine = (symptom: TriageSymptom, keys: readonly WordKey[]): void => {
      const statuses = keys.map(status);
      if (statuses.some((value) => value === undefined)) return;
      set(symptom, statuses.includes("absent") ? "absent" : statuses.includes("uncertain") ? "uncertain" : "present");
    };
    combine("ankle_injury", ["ankle", "injury"]);
    combine("arm_injury", ["arm", "injury"]);
    combine("knee_injury", ["knee", "injury"]);
    combine("wrist_injury", ["wrist", "injury"]);
    for (const [symptom, key] of [
      ["fever", "fever"], ["cough", "cough"], ["ear_complaint", "ear"], ["tummy_complaint", "tummy"],
      ["heavy_periods", "heavyPeriods"], ["irregular_periods", "irregularPeriods"], ["intermenstrual_bleeding", "betweenPeriods"],
    ] as const) {
      const value = status(key);
      if (value !== undefined) set(symptom, value);
    }
    combine("persistent_fatigue", ["persistent", "fatigue"]);
    combine("persistent_headache", ["persistent", "headache"]);
    combine("persistent_throat_complaint", ["persistent", "throat"]);
    combine("persistent_dizziness", ["persistent", "dizziness"]);
    combine("persistent_low_pelvic_pain", ["persistent", "pelvic"]);
    if (associated("sudden", "face")) combine("sudden_facial_droop", ["sudden", "face"]);
    if (associated("sudden", "armWeakness")) combine("sudden_arm_weakness", ["sudden", "armWeakness"]);
    if (associated("sudden", "speech")) combine("sudden_slurred_speech", ["sudden", "speech"]);
    if (associated("sudden", "breath") && associated("severe", "breath")) {
      combine("sudden_severe_breathlessness", ["sudden", "severe", "breath"]);
    }
  }
  const aggregate = (key: WordKey): SymptomStatus | undefined =>
    all.get(key)?.reduce<SymptomStatus | undefined>((result, mention) => mergeStatus(result, mention.status), undefined);
  const combineAll = (symptom: TriageSymptom, keys: readonly WordKey[]): void => {
    const statuses = keys.map(aggregate);
    if (statuses.some((status) => status === undefined)) return;
    set(symptom, statuses.includes("absent") ? "absent" : statuses.includes("uncertain") ? "uncertain" : "present");
  };
  combineAll("chest_pain_with_breathlessness", ["chest", "breath"]);
  if (words.afterPressure.test(prose)) combineAll("bleeding_despite_pressure", ["bleeding", "pressure", "continuing"]);
  const headOrder = all.get("head")?.find((mention) => mention.status === "present")?.order;
  for (const [symptom, key] of [["head_injury_then_confusion", "confusion"], ["head_injury_then_vomiting", "vomiting"]] as const) {
    const afterOrder = all.get(key)?.find((mention) => mention.status === "present")?.order;
    if (headOrder !== undefined && afterOrder !== undefined && !/\b(?:before|antes|abans)\b/.test(prose) &&
      (headOrder < afterOrder || /\b(?:after|since|despues|tras|despres)\b/.test(prose))) {
      combineAll(symptom, ["head", key]);
    }
  }
  const emergency = emergencySymptoms.some((symptom) => observations.get(symptom) === "present");
  const incompleteEmergency = !emergency && (
    (["chest", "breath", "face", "armWeakness", "speech", "head"] as const)
      .some((key) => aggregate(key) === "present" || aggregate(key) === "uncertain") ||
    (aggregate("bleeding") === "present" && aggregate("pressure") === "present")
  );
  return {
    observations: [...observations].map(([symptom, status]) => ({ symptom, status })),
    nonReport: nonReport && usableClauses === 0,
    incompleteEmergency,
  };
}

/**
 * Published challenge routing only, not diagnosis or treatment.
 * Text recognition is deliberately bounded. Use explicit observations after clarification
 * for unsupported wording; "present" asserts the complete published symptom pattern.
 */
export function assessComplaint(input: ComplaintInput, specialties: readonly RoutingSpecialty[]): ComplaintAssessment {
  const parsed = complaintInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_complaint", "Provide a complaint and valid published symptom observations.");
  parseDate(input.callDate, "invalid_call_date");
  const text = recognizeText(input.complaint);
  const source: AssessmentSource = input.observations === undefined ? "text" : "structured";
  const evidence = new Map<TriageSymptom, SymptomStatus>();
  for (const { symptom, status } of input.observations ?? text.observations) {
    evidence.set(symptom, mergeStatus(evidence.get(symptom), status));
  }
  if (input.observations !== undefined) {
    for (const { symptom, status } of text.observations) {
      if (evidence.has(symptom) && evidence.get(symptom) !== status) evidence.set(symptom, "uncertain");
      else if (emergencySymptoms.some((key) => key === symptom) && status !== "absent") evidence.set(symptom, status);
    }
  }
  const symptoms = triageSymptomKeys.filter((symptom) => evidence.get(symptom) === "present");
  const requiresEmergencyClarification = input.context !== "hypothetical" && !text.nonReport &&
    (text.incompleteEmergency || emergencySymptoms.some((symptom) =>
      evidence.get(symptom) === "uncertain" || (input.context === "uncertain" && evidence.get(symptom) === "present")));
  const clarify = (reason: ClarificationReason, clarification: string): ComplaintAssessment =>
    ({ kind: "clarify", reason, clarification, source, symptoms, requiresEmergencyClarification });
  if (input.context === "hypothetical" || text.nonReport) {
    return clarify("reported_symptoms_unclear", "Ask whether these symptoms are happening to the patient, rather than being a general or hypothetical question.");
  }
  if (input.context === "uncertain") {
    return clarify("uncertain_symptoms", "Clarify which symptoms the patient is actually reporting now.");
  }
  const emergency = emergencySymptoms.find((symptom) => evidence.get(symptom) === "present");
  if (emergency !== undefined) return { kind: "emergency", reason: "medical_emergency", pattern: emergency, symptoms, source };
  if ([...evidence.values()].includes("uncertain")) {
    return clarify("uncertain_symptoms", "Confirm the uncertain or contradictory symptom details; do not assume a published pattern.");
  }
  if (source === "text" && text.incompleteEmergency) {
    return clarify("symptom_details_required", "Clarify onset and associated symptoms to establish whether a complete published pattern is present.");
  }
  const groups = routeGroups.filter((group) => group.symptoms.some((symptom) => evidence.get(symptom) === "present"));
  if (groups.length === 0) return clarify("no_published_match", "Clarify the complaint or requested specialty; it does not establish a published routing pattern.");
  if (groups.length > 1) return clarify("multiple_published_routes", "Clarify which complaint or specialty this appointment is for.");
  const group = groups[0]!;
  const ageMonths = ageInMonths(input.dateOfBirth, input.callDate);
  if (group.family === "paediatrics" || group.family === "general_practice") {
    if (ageMonths === null) return clarify("age_required", "Verify the patient's date of birth to apply the fourteenth-birthday boundary.");
    if ((group.family === "paediatrics" && ageMonths >= 168) || (group.family === "general_practice" && ageMonths < 168)) {
      return clarify("age_outside_published_route", "Clarify the appropriate specialty; do not extrapolate this published symptom family to a different age group.");
    }
  }
  const matchingSpecialties = specialties.filter((specialty) => catalogueHasFamily(specialty, group.family));
  if (matchingSpecialties.length === 0) return clarify("specialty_unavailable", "The published specialty is absent from the catalogue; clarify without inventing an ID.");
  if (matchingSpecialties.length > 1) return clarify("specialty_ambiguous", "Clarify which matching catalogue specialty is intended.");
  const specialty = matchingSpecialties[0]!;
  return { kind: "route", specialtyId: specialty.id, specialtyName: specialty.name, reason: group.reason, ageMonths, source, symptoms };
}
