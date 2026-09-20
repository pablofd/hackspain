export let snapshot = null;
export let calls = [];
export let clients = [];
let credential = "";
let connection = 0;

export const outcomeLabels = {
  resolved: { text: "Registro recibido", pill: "pill--ok" },
  escalated: { text: "Escalado registrado", pill: "pill--alert" },
  no_action: { text: "Sin acción", pill: "pill--neutral" },
  pending: { text: "Registro abierto", pill: "pill--accent" },
  unknown: { text: "Sin recibo observado", pill: "pill--neutral" },
};
export const sentimentLabels = { unavailable: { text: "No disponible", cls: "muted" } };
export const riskLabels = { unavailable: { text: "No evaluado", pill: "pill--neutral" } };
export const actionLabels = {
  BOOK: "Reserva comunicada", RESCHEDULE: "Cambio comunicado", CANCEL: "Cancelación comunicada",
  REGISTER: "Alta comunicada", NO_ACTION: "Sin acción", ESCALATE: "Escalado comunicado",
};

export function formatDate(value) {
  return value ? new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value)) : "No disponible";
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function madridDay(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type).value;
  return Date.parse(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
}

function normaliseCalls() {
  calls = (snapshot?.calls ?? []).map((call) => {
    const client = call.patientIds.length === 1 ? clients.find((patient) => patient.id === call.patientIds[0]) : null;
    const actions = call.actions.map((action) => `${actionLabels[action.action] ?? action.action}${action.reason ? ` · ${action.reason}` : ""}`);
    const escalated = call.actions.some((action) => action.action === "ESCALATE");
    const booked = call.actions.some((action) => action.action === "BOOK" || action.action === "RESCHEDULE");
    const missed = call.actions.some((action) => action.action === "NO_ACTION");
    const timestamp = call.startedAt ?? call.receivedAt;
    return {
      ...call,
      caller: client?.name ?? (call.patientIds.length === 1
        ? `Paciente ${call.patientIds[0]}` : `Llamada ${call.id}`),
      personKey: call.patientIds.length === 1 ? call.patientIds[0] : call.id,
      phone: client?.phone ?? "No consultado",
      reason: actions.length ? [...new Set(call.actions.map((action) => actionLabels[action.action]))].join(" · ") : "Sin acción recibida",
      outcome: escalated ? "escalated" : booked ? "resolved" : missed ? "no_action" :
        actions.length ? "resolved" : call.openRecord ? "pending" : "unknown",
      booked, missed, missReason: call.actions.find((action) => action.action === "NO_ACTION")?.reason ?? null,
      sentiment: "unavailable",
      duration: formatDuration(call.durationMs),
      time: `${call.startedAt ? "" : "Recibo · "}${formatDate(timestamp)}`,
      direction: "Entrante",
      live: call.openRecord,
      daysAgo: timestamp ? Math.floor((madridDay(snapshot.observedAt) - madridDay(timestamp)) / 86_400_000) : Infinity,
      actions,
    };
  });
}

export function acceptSnapshot(value) {
  if (!value || !Array.isArray(value.calls) || !value.sources || !Number.isInteger(value.historyDays) ||
      !Number.isFinite(Date.parse(value.observedAt))) throw new Error("dashboard_invalid_response");
  snapshot = value;
  normaliseCalls();
}

export function setPatients(patients) {
  clients = patients.map((patient) => ({
    ...patient, tags: [], risk: "unavailable",
    lastContact: "No disponible", nextAppt: "Consultar ficha",
  }));
  normaliseCalls();
}

export async function api(path, signal, method = "GET") {
  if (!credential) throw new Error("dashboard_unauthorized");
  const current = connection;
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${credential}` },
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
    cache: "no-store", redirect: "error",
  });
  const value = await response.json();
  if (current !== connection) throw new Error("dashboard_connection_changed");
  if (!response.ok) throw new Error(value.error ?? `dashboard_http_${response.status}`);
  return value;
}

export async function callTranscript(callId, signal) {
  const value = await api(`/api/dashboard/calls/${encodeURIComponent(callId)}/transcript`, signal);
  if (!value || value.callId !== callId || !Array.isArray(value.entries) || value.entries.length > 500 ||
      typeof value.limited !== "boolean" || !Number.isFinite(Date.parse(value.checkedAt)) ||
      value.entries.some((entry) => !validTranscriptEntry(entry))) throw new Error("dashboard_invalid_response");
  return value;
}

export function validTranscriptEntry(entry) {
  return Boolean(entry && ["user", "assistant"].includes(entry.speaker) &&
    typeof entry.text === "string" && entry.text.length <= 65536 &&
    typeof entry.itemId === "string" && entry.itemId.length <= 512 &&
    typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) &&
    (entry.partial === undefined || typeof entry.partial === "boolean") &&
    (entry.startMs === undefined ? entry.endMs === undefined :
      Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs) && entry.startMs >= 0 && entry.endMs >= entry.startMs));
}

export const signalToneLabels = {
  positive: "Positivo", neutral: "Neutro", negative: "Negativo", mixed: "Mixto", unknown: "Indeterminado",
};
export const signalIntentLabels = {
  book: "Pedir cita", reschedule: "Cambiar cita", cancel: "Cancelar cita", register: "Registrarse",
  clinic_information: "Información de la clínica", privacy_request: "Solicitud de privacidad",
  medical_advice: "Solicitud de consejo médico", emergency: "Mención de emergencia", other: "Otra intención",
};
export const signalPatternLabels = {
  correction: "Corrección", repetition: "Repetición", uncertainty: "Incertidumbre", urgency: "Urgencia expresada",
  explicit_confirmation: "Confirmación explícita", declined_offer: "Oferta rechazada", language_switch: "Cambio de idioma",
  thanks: "Agradecimiento", privacy_boundary: "Límite de privacidad",
};
export const signalConfidenceLabels = { low: "Baja", medium: "Media", high: "Alta" };

export async function callSignals(callId, signal) {
  if (!snapshot?.signalAnalysis?.enabled) throw new Error("signals_disabled");
  if (typeof callId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(callId)) throw new Error("dashboard_invalid_call_id");
  const value = await api(`/api/dashboard/calls/${encodeURIComponent(callId)}/signals`, signal, "POST");
  const timestamp = (date) => typeof date === "string" && Number.isFinite(Date.parse(date));
  const nullableDate = (date) => date === null || timestamp(date);
  const count = (number) => Number.isSafeInteger(number) && number >= 0;
  if (!value || value.callId !== callId || !["ready", "insufficient_data"].includes(value.status) ||
      value.source !== "azure_text_estimate" || typeof value.model !== "string" || !value.model || value.model.length > 200 ||
      !nullableDate(value.analyzedAt) || !nullableDate(value.nextRefreshAt) || typeof value.stale !== "boolean" ||
      !value.coverage || !count(value.coverage.entries) || !count(value.coverage.characters) ||
      typeof value.coverage.limited !== "boolean" || !Array.isArray(value.evidence) || value.evidence.length > 500 ||
      value.evidence.some((entry) => !entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 512 ||
        entry.speaker !== "user" || typeof entry.text !== "string" || entry.text.length > 65536 || !timestamp(entry.timestamp))) {
    throw new Error("signals_invalid_response");
  }
  const ids = new Set(value.evidence.map((entry) => entry.id));
  const refs = (list) => Array.isArray(list) && list.length <= 500 &&
    list.every((id) => typeof id === "string" && ids.has(id));
  const named = (labels, key) => typeof key === "string" && Object.hasOwn(labels, key);
  const indicator = (item) => item && (item.score === null ||
    (Number.isFinite(item.score) && item.score >= 0 && item.score <= 100)) && refs(item.evidence);
  const analysis = value.analysis;
  if (ids.size !== value.evidence.length || (value.status === "insufficient_data" ? analysis !== null :
    !analysis || !named(signalToneLabels, analysis.tone) ||
    !["calmness", "satisfaction", "confusion"].every((key) => indicator(analysis.indicators?.[key])) ||
    !Array.isArray(analysis.intents) || analysis.intents.length > 500 ||
    analysis.intents.some((item) => !item || !named(signalIntentLabels, item.kind) ||
      !named(signalConfidenceLabels, item.confidence) || !refs(item.evidence)) ||
    !Array.isArray(analysis.patterns) || analysis.patterns.length > 500 ||
    analysis.patterns.some((item) => !item || !named(signalPatternLabels, item.kind) || !refs(item.evidence)))) {
    throw new Error("signals_invalid_response");
  }
  return value;
}

export async function createDemoCall(signal) {
  if (!snapshot?.demoCall?.enabled) throw new Error("dashboard_demo_disabled");
  let value;
  try { value = await api("/api/dashboard/demo-call", signal, "POST"); }
  catch (error) {
    if (error instanceof TypeError) throw new Error("dashboard_demo_connection_failed");
    throw error;
  }
  if (!value || typeof value.callId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.callId) ||
      typeof value.ticket !== "string" || !/^[A-Za-z0-9_.-]{16,512}$/.test(value.ticket) ||
      value.websocketPath !== "/api/dashboard/demo-call/ws" || value.maxDurationSeconds !== 180 ||
      value.submissionsAllowed !== false || value.codec !== "audio/x-mulaw" || value.sampleRate !== 8000 ||
      value.frameBytes !== 160 || !Array.isArray(value.decodeTable) || value.decodeTable.length !== 256 ||
      value.decodeTable[255] !== 0 || value.decodeTable.some((sample) => !Number.isInteger(sample) || sample < -32768 || sample > 32767) ||
      !Number.isFinite(Date.parse(value.expiresAt))) throw new Error("dashboard_demo_invalid_ticket");
  if (Date.parse(value.expiresAt) <= Date.now()) throw new Error("dashboard_demo_ticket_expired");
  return value;
}

export async function connect(token) {
  connection += 1;
  credential = token;
  try { await refresh(); }
  catch (error) { disconnect(); throw error; }
}

export async function refresh() {
  acceptSnapshot(await api("/api/dashboard/snapshot"));
}

export function disconnect() {
  connection += 1;
  credential = "";
  snapshot = null;
  calls = [];
  clients = [];
}
