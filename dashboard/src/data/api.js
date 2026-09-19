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

export async function api(path, signal) {
  if (!credential) throw new Error("dashboard_unauthorized");
  const current = connection;
  const response = await fetch(path, {
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
      value.entries.some((entry) => !entry || !["user", "assistant"].includes(entry.speaker) ||
        typeof entry.text !== "string" || typeof entry.itemId !== "string" ||
        typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp)) ||
        (entry.partial !== undefined && typeof entry.partial !== "boolean") ||
        (entry.startMs === undefined ? entry.endMs !== undefined :
          !Number.isFinite(entry.startMs) || !Number.isFinite(entry.endMs) ||
          entry.startMs < 0 || entry.endMs < entry.startMs))) throw new Error("dashboard_invalid_response");
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
