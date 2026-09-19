import { formatDuration } from "./api.js";
import { getPresentation } from "./presentation.js";

export const RANGES = [
  { id: "1d", label: "Hoy", days: 1, short: "hoy (Madrid)" },
  { id: "7d", label: "7 días", days: 7, short: "últimos 7 días observados" },
  { id: "30d", label: "30 días", days: 30, short: "últimos 30 días observados" },
];
export const DEFAULT_RANGE = "7d";
export const rangeById = (id) => RANGES.find((range) => range.id === id) ?? RANGES[1];
export const inRange = (call, range) => call.daysAgo >= 0 && call.daysAgo < rangeById(range).days;
export const callsInRange = (range) => getPresentation().calls.filter((call) => inRange(call, range));
export const STATES = [
  { id: "all", label: "Todas" }, { id: "live", label: "Registros abiertos" },
  { id: "booked", label: "Con reserva" }, { id: "missed", label: "Sin acción" },
  { id: "resolved", label: "Registro recibido" }, { id: "escalated", label: "Escaladas" },
  { id: "unknown", label: "Sin recibo" },
];
export const stateLabel = (id) => STATES.find((state) => state.id === id)?.label ?? "Todas";
export function matchesState(call, state) {
  if (state === "all") return true;
  if (state === "live") return call.live;
  if (state === "booked") return call.booked;
  if (state === "missed") return call.missed;
  return call.outcome === state;
}
const mean = (values) => {
  const measured = values.filter(Number.isFinite);
  return measured.length ? measured.reduce((total, value) => total + value, 0) / measured.length : null;
};
export const availableCalls = () => {
  const { snapshot, simulated } = getPresentation();
  return simulated || snapshot?.sources.records.status === "ok" || snapshot?.sources.submissions.status === "ok";
};

export function callQuality(call) {
  if (call.simulated) return call.visualQuality;
  return {
    p50: call.technical.trace?.responseDurationP50Ms ?? null,
    p95: call.technical.trace?.responseDurationP95Ms ?? null,
    bargeIns: call.technical.interruptions,
    first: null, mos: null, jitter: null, loss: null, asr: null, silence: null,
  };
}

function latency(list) {
  const traces = list.flatMap((call) => call.technical.trace ? [call.technical.trace] : []);
  const count = traces.reduce((total, trace) => total + trace.responseCount, 0);
  return count ? traces.reduce((total, trace) => total + trace.responseDurationTotalMs, 0) / count : null;
}

export function metrics(range) {
  const list = callsInRange(range);
  const available = availableCalls();
  const received = list.filter((call) => call.receiptSource !== null).length;
  return {
    total: available ? list.length : null,
    booked: available ? list.filter((call) => call.booked).length : null,
    missed: available ? list.filter((call) => call.missed).length : null,
    escalated: available ? list.filter((call) => call.outcome === "escalated").length : null,
    receivedShare: list.length ? Math.round(received / list.length * 100) : null,
    avgHandle: formatDuration(mean(list.map((call) => call.durationMs))),
    latency: latency(list),
    bargeIns: mean(list.map((call) => call.technical.interruptions)),
    // A bounded recent sample is not sufficient evidence for period-over-period trends.
    trend: null,
  };
}

export function successVsLatency(range) {
  const result = [];
  for (let day = rangeById(range).days - 1; day >= 0; day -= 1) {
    const list = callsInRange(range).filter((call) => call.daysAgo === day);
    const duration = latency(list);
    if (!list.length || duration === null) continue;
    result.push({
      label: day ? `-${day}d` : "Hoy",
      success: list.filter((call) => call.receiptSource !== null).length / list.length * 100,
      latency: duration,
    });
  }
  return result;
}
