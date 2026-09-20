import { el, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill, emptyState, bar, donut } from "../components/ui.js";
import { networkPanel } from "../components/network.js";
import { transcriptPanel } from "../components/transcript.js";
import { realSignalsPanel } from "../components/signals.js";
import { demoCallControl } from "../components/demo-call.js";
import { snapshot as liveSnapshot, outcomeLabels, formatDate, callTranscript } from "../data/api.js";
import { getPresentation, demoSentiments } from "../data/presentation.js";
import { RANGES, STATES, DEFAULT_RANGE, inRange, matchesState, callQuality } from "../data/insights.js";

export const meta = { title: "Llamadas", sub: "Conversaciones, transcripciones y acciones" };
const number = (value, unit = "") => Number.isFinite(value) ? `${Math.round(value)}${unit}` : "No disponible";

export function render(param, query) {
  const { snapshot } = getPresentation();
  let filter = STATES.some((item) => item.id === query?.get("estado")) ? query.get("estado") : param === "directo" ? "live" : "all";
  let range = RANGES.some((item) => item.id === query?.get("rango") && item.days <= snapshot.historyDays)
    ? query.get("rango") : snapshot.historyDays < 7 ? "1d" : DEFAULT_RANGE;
  let selectedId = query?.get("llamada");
  let mapOpen = param === "mapa";
  let panel = null;
  let mapView;
  let disposed = false;
  let transcriptId;
  let transcriptController;
  let transcript = { status: "idle", data: null };
  const transcriptView = transcriptPanel();
  const realSignals = realSignalsPanel();
  const demoCall = demoCallControl();
  const stopDemo = () => demoCall.close();
  const tbody = el("tbody", {});
  const detail = chatCard(togglePanel, transcriptView.element);
  const summary = el("div", { class: "grid grid--2" });
  const noSelection = card({}, emptyState("Sin selección", "Selecciona un registro de la lista."));
  const hero = el("div", { class: "calls__panel" }, noSelection, detail.element, summary);
  const signals = el("aside", { class: "signals", hidden: true });
  const listCard = card({ flush: true }, el("div", { class: "table-wrap" },
    el("table", { class: "data" },
      el("thead", {}, el("tr", {}, ...["Llamada / paciente", "Acción", "Registro", "Sentimiento", "Duración", "Cuándo"].map((label) => el("th", {}, label)))),
      tbody)));
  const grid = el("div", { class: "grid grid--calls" }, listCard, hero, signals);
  const board = el("div", {}, grid);
  const search = query?.get("buscar")?.toLocaleLowerCase("es") ?? "";
  const visible = () => getPresentation().calls.filter((call) => inRange(call, range) && matchesState(call, filter) &&
    (!search || `${call.id} ${call.caller} ${call.reason}`.toLocaleLowerCase("es").includes(search)));

  function togglePanel(kind) {
    panel = panel === kind ? null : kind;
    paint();
    if (panel === "signals" && !getPresentation().simulated && !mapOpen) realSignals.open();
  }

  function paintTranscript() {
    transcriptView.update({ key: transcriptId, ...transcript, simulated: getPresentation().simulated });
  }

  async function loadTranscript(id) {
    if (disposed || (id === transcriptId && transcriptController)) return;
    const changed = id !== transcriptId;
    transcriptController?.abort();
    transcriptId = id;
    if (!id) {
      transcriptController = undefined;
      transcript = { status: "idle", data: null };
      paintTranscript();
      return;
    }
    const controller = new AbortController();
    transcriptController = controller;
    const previous = changed ? null : transcript.data;
    transcript = { status: previous ? "refreshing" : "loading", data: previous };
    paintTranscript();
    const current = () => !disposed && !controller.signal.aborted && transcriptController === controller &&
      transcriptId === id && selectedId === id && !mapOpen && liveSnapshot !== null;
    try {
      const call = getPresentation().calls.find((item) => item.id === id);
      const data = call?.simulated
        ? { callId: id, entries: call.transcript, limited: false, checkedAt: new Date().toISOString() }
        : await callTranscript(id, controller.signal);
      if (!current()) return;
      transcript = { status: "ok", data };
    } catch (error) {
      if (!current()) return;
      transcript = { status: "error", data: previous, error: error.message };
    } finally {
      if (transcriptController === controller) transcriptController = undefined;
    }
    paintTranscript();
  }

  function paint() {
    if (disposed) return;
    demoCall.refresh();
    const rows = visible();
    if (!rows.some((call) => call.id === selectedId)) selectedId = rows[0]?.id;
    const selected = rows.find((call) => call.id === selectedId);
    const realSignalsVisible = Boolean(selected && panel === "signals" && !mapOpen && !getPresentation().simulated);
    realSignals.update(selected?.id, liveSnapshot?.signalAnalysis, realSignalsVisible);
    const nextTranscriptId = mapOpen ? undefined : selected?.id;
    if (nextTranscriptId !== transcriptId) void loadTranscript(nextTranscriptId);
    mount(tbody, ...rows.map((call) => el("tr", {
      class: call.id === selectedId ? "is-selected" : "",
      onclick: () => { selectedId = call.id; paint(); },
    },
    el("td", {}, el("div", { class: "row-flex" }, el("span", { class: "avatar", "aria-hidden": "true" }, call.caller[0]),
      el("div", {}, el("div", { class: "cell-main" }, call.caller), el("div", { class: "cell-sub" }, call.phone)))),
    el("td", {}, el("div", { class: "cell-main" }, call.reason), el("div", { class: "cell-sub" }, call.missReason)),
    el("td", {}, pill(outcomeLabels[call.outcome].text, outcomeLabels[call.outcome].pill.replace("pill--", ""))),
    el("td", { class: `text-sm hide-lg ${demoSentiments[call.sentiment]?.cls ?? "muted"}` },
      call.simulated ? demoSentiments[call.sentiment].text : "—"), el("td", { class: "mono" }, call.duration),
    el("td", { class: "cell-sub" }, call.time))));
    if (!rows.length) mount(tbody, el("tr", {}, el("td", { colspan: 6, class: "empty" }, "Sin registros observados con este filtro.")));
    noSelection.hidden = Boolean(selected);
    detail.element.hidden = summary.hidden = !selected;
    if (selected) {
      detail.update(selected, panel);
      mount(summary,
        card({ title: "Resumen del registro", sub: selected.id },
          el("dl", { class: "kv" },
            el("dt", {}, "Resultado observado"), el("dd", {}, outcomeLabels[selected.outcome].text),
            el("dt", {}, "Fuente del recibo"), el("dd", {}, selected.receiptSource ?? "Sin recibo observado"),
            el("dt", {}, "Cierre local"), el("dd", {}, selected.endReason ?? "No observado"),
            el("dt", {}, "Veredicto Prosper"), el("dd", {}, "No consultado"),
            el("dt", {}, "Sentimiento"), el("dd", {}, selected.simulated ? `${demoSentiments[selected.sentiment].text} · simulado` : "No instrumentado"))),
        card({ title: "Acciones recibidas", sub: "No incluye borradores ni confirmaciones sin recibo" },
          selected.actions.length ? el("div", { class: "timeline" }, ...selected.actions.map((action) =>
            el("div", { class: "timeline__item" }, el("div", { class: "timeline__title" }, action))))
            : emptyState("Sin recibo observado", "No permite deducir un veredicto del juez.")));
    }
    grid.classList.toggle("is-signals", Boolean(panel && selected));
    listCard.hidden = Boolean(panel && selected);
    signals.hidden = !panel || !selected;
    if (realSignalsVisible) {
      if (signals.firstChild !== realSignals.element) mount(signals, realSignals.element);
    } else mount(signals, ...(panel && selected ? (panel === "metrics" ? metricsPanel(selected) : signalsPanel(selected)) : []));
    if (mapOpen) {
      if (!mapView) mapView = networkPanel(rows, { state: filter, range });
      else mapView.update(rows, { state: filter, range });
      if (board.firstChild !== mapView) mount(board, mapView);
    } else if (board.firstChild !== grid) mount(board, grid);
  }

  function selector(items, current, change) {
    const bar = el("div", { class: "segmented" }, ...items.map((item) =>
      el("button", { class: item.id === current ? "is-active" : "", onclick: (event) => {
        change(item.id);
        bar.querySelectorAll("button").forEach((button) => button.classList.remove("is-active"));
        event.currentTarget.classList.add("is-active");
        paint();
      } }, item.label)));
    return bar;
  }
  const mapButton = el("button", { class: mapOpen ? "btn btn--primary" : "btn", onclick: () => {
    mapOpen = !mapOpen;
    mapButton.classList.toggle("btn--primary", mapOpen);
    mapButton.lastChild.textContent = mapOpen ? "Ocultar mapa" : "Ver mapa";
    paint();
  } }, icon("relations", "nav__icon"), el("span", {}, mapOpen ? "Ocultar mapa" : "Ver mapa"));
  const root = el("div", { class: "view" },
    el("div", { class: "row row--wrap" },
      selector(STATES, filter, (value) => { filter = value; }),
      selector(RANGES.filter((item) => item.days <= snapshot.historyDays), range, (value) => { range = value; }),
      el("div", { class: "row calls__tools", role: "group", "aria-label": "Mapa y llamada en directo" }, mapButton, demoCall.element)),
    search ? el("p", { class: "card__sub" }, `Resultados para «${query.get("buscar")}»`) : null,
    board,
    el("p", { class: "card__sub" }, getPresentation().simulated
      ? "Demo visual: conversaciones, pacientes, sentimientos y analítica son ejemplos locales. No representan llamadas reales."
      : "Un registro abierto no confirma actividad de voz. Un recibo no es un veredicto del juez; sentimiento no instrumentado."));
  root.update = () => {
    paint();
    if (!mapOpen && selectedId) void loadTranscript(selectedId);
  };
  root.dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("pagehide", stopDemo);
    demoCall.dispose();
    transcriptController?.abort();
    transcriptController = undefined;
    transcript = { status: "idle", data: null };
    transcriptView.dispose();
    realSignals.dispose();
    mapView?.dispose();
  };
  paint();
  window.addEventListener("pagehide", stopDemo);
  return root;
}

function chatCard(onToggle, transcriptBody) {
  const name = el("span", { class: "truncate" });
  const badge = el("span", { class: "pill pill--neutral" });
  const subtitle = el("div", { class: "chat-card__sub truncate" });
  const metrics = el("button", { class: "signal-btn", onclick: () => onToggle("metrics") }, icon("reports", "signal-btn__icon"), "Ver analítica");
  const signals = el("button", { class: "signal-btn", onclick: () => onToggle("signals") },
    el("span", { class: "signal-btn__eq", "aria-hidden": "true" }, el("i", {}), el("i", {}), el("i", {})), "Señales");
  const events = el("div", {});
  const duration = el("span", { class: "mono ml-auto" });
  const waveform = el("div", { class: "waveform", hidden: true, "aria-hidden": "true", title: "Onda ilustrativa · sin grabación" },
    ...Array.from({ length: 48 }, (_, index) => el("i", {
      class: index < 16 ? "is-played" : "", style: { height: `${18 + Math.abs(Math.sin(index * 1.7)) * 70}%` },
    })));
  const playbackLabel = el("span", { class: "text-sm muted" }, "Reproducción no disponible");
  const element = el("section", { class: "chat-card grain" },
    el("div", { class: "chat-card__head" }, icon("maio", "chat-card__logo"),
      el("div", { style: { minWidth: 0 } },
        el("div", { class: "chat-card__name" }, name, badge), subtitle),
      el("div", { class: "row ml-auto" }, metrics, signals)),
    transcriptBody,
    el("details", { class: "transcript-events" },
      el("summary", { class: "text-sm" }, "Eventos técnicos recientes"), events),
    el("div", { class: "player" },
      el("button", { class: "player__btn", disabled: true, title: "Audio privado no expuesto" }, icon("play", "nav__icon")),
      waveform, playbackLabel,
      duration));
  return { element, update(call, panel) {
    name.textContent = call.caller;
    badge.textContent = `${call.live ? "Registro abierto" : outcomeLabels[call.outcome].text}${call.simulated ? " · demo" : ""}`;
    subtitle.textContent = `${call.reason} · ${call.time}`;
    metrics.classList.toggle("is-on", panel === "metrics");
    signals.classList.toggle("is-on", panel === "signals");
    signals.title = call.simulated ? "Señales simuladas, sin inferencia" : "Abrir análisis textual con Azure (coste separado)";
    duration.textContent = call.duration;
    waveform.hidden = !call.simulated;
    playbackLabel.textContent = call.simulated ? "Onda de ejemplo · sin audio" : "Reproducción no disponible";
    mount(events, ...call.events.slice(-12).map((event) =>
      el("div", { class: "timeline__item" }, el("div", { class: "timeline__time" }, formatDate(event.timestamp)),
        el("div", { class: "timeline__title" }, event.code))));
  } };
}

export function signalsPanel(call) {
  if (call?.simulated) {
    const calm = call.sentiment === "negative" ? 34 : call.sentiment === "positive" ? 88 : 72;
    const meter = (label, value) => el("div", { class: "list__item" },
      el("div", { class: "list__body" }, el("div", { class: "list__title" }, label), bar(value)),
      el("span", { class: "mono" }, `${value}%`));
    return [
      el("div", { class: "signals__strip brand-wash" }, "Señales · demo visual, no inferencia"),
      card({ title: "Estado emocional", sub: "Valores de ejemplo para mostrar el diseño original" },
        el("div", { class: "gauge-row" }, donut([
          { value: calm, color: "var(--dusty-denim)" }, { value: 100 - calm, color: "var(--parchment)" },
        ], { size: 120, center: `${calm}%` }),
        el("div", { style: { flex: 1 } }, meter("Calma", calm), meter("Satisfacción", calm - 7), meter("Confusión", 22)))),
      card({ title: "Intenciones", sub: "Ejemplo simulado" }, meter(call.reason, 94), meter("Preferencia horaria", 71), meter("Consultar información", 58)),
      card({ title: "Patrones de conversación", sub: "Ilustración, no análisis de pacientes reales" },
        el("div", { class: "chips" }, ...["Busca una cita", "Prefiere la mañana", "Confirma la propuesta"].map((label) => el("span", { class: "signal-chip" }, label)))),
    ];
  }
  return [card({ title: "Señales no implementadas" },
    emptyState("Sentimiento e intenciones: no disponibles",
      "El backend no genera emoción, confianza de intención ni recomendaciones. No se inferirán a partir del resultado de la llamada."))];
}

function metricsPanel(call) {
  const q = callQuality(call);
  if (call.simulated) return [
    el("div", { class: "signals__strip brand-wash" }, "Analítica · demo visual, no medición"),
    ...[
      ["Latencia de respuesta", [["Primera respuesta", `${q.first} ms`], ["Mediana", `${q.p50} ms`], ["P95", `${q.p95} ms`]]],
      ["Calidad de la llamada", [["MOS", `${q.mos.toFixed(1)} / 5`], ["Jitter", `${q.jitter} ms`], ["Pérdida", `${q.loss}%`]]],
      ["Comprensión y turno de palabra", [["Confianza ASR", `${q.asr}%`], ["Interrupciones", q.bargeIns], ["Silencios", q.silence]]],
    ].map(([title, fields]) => card({ title, sub: "Datos simulados para ilustrar el panel" },
      el("dl", { class: "kv" }, ...fields.flatMap(([label, value]) => [el("dt", {}, label), el("dd", { class: "mono" }, String(value))])))),
  ];
  const trace = call.technical.trace;
  return [
    card({ title: "Respuesta del backend", sub: "Duración de spans chat en Application Insights; no tiempo desde que calla el paciente" },
      el("dl", { class: "kv" },
        el("dt", {}, "Mediana"), el("dd", {}, number(q.p50, " ms")),
        el("dt", {}, "P95"), el("dd", {}, number(q.p95, " ms")),
        el("dt", {}, "Respuestas observadas"), el("dd", {}, number(trace?.responseCount)),
        el("dt", {}, "Tokens de entrada"), el("dd", {}, number(trace?.inputTokens)),
        el("dt", {}, "Tokens de salida"), el("dd", {}, number(trace?.outputTokens)),
        el("dt", {}, "Latencia real de turno"), el("dd", {}, "No instrumentada"))),
    card({ title: "Audio y transporte", sub: "Metadatos locales; no prueban reproducción remota" },
      el("dl", { class: "kv" },
        el("dt", {}, "Códec"), el("dd", {}, "G.711 mu-law · 8 kHz · mono"),
        el("dt", {}, "Bytes recibidos"), el("dd", {}, number(call.technical.inputBytes)),
        el("dt", {}, "Bytes enviados"), el("dd", {}, number(call.technical.outputBytes)),
        el("dt", {}, "Interrupciones registradas"), el("dd", {}, number(call.technical.interruptions)),
        el("dt", {}, "MOS / jitter / pérdida"), el("dd", {}, "No medidos"))),
    card({ title: "Transcripción" },
      el("dl", { class: "kv" },
        el("dt", {}, "Eventos de transcripción"), el("dd", {}, number(call.technical.transcriptEvents)),
        el("dt", {}, "Exactitud / confianza ASR"), el("dd", {}, "No disponible"),
        el("dt", {}, "Idioma detectado"), el("dd", {}, "No instrumentado")),
      el("p", { class: "card__sub" }, "Los fragmentos no equivalen a turnos completos ni prueban lo que oyó el interlocutor.")),
  ];
}
