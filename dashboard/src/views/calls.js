import { el, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill, emptyState } from "../components/ui.js";
import { networkPanel } from "../components/network.js";
import { calls, snapshot, outcomeLabels, formatDate, callTranscript } from "../data/api.js";
import { RANGES, STATES, DEFAULT_RANGE, inRange, matchesState, callQuality } from "../data/insights.js";

export const meta = { title: "Llamadas", sub: "Registros y acciones reales · actualización cada 5 segundos" };
const number = (value, unit = "") => Number.isFinite(value) ? `${Math.round(value)}${unit}` : "No disponible";
const transcriptTime = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function render(param, query) {
  let filter = STATES.some((item) => item.id === query?.get("estado")) ? query.get("estado") : param === "directo" ? "live" : "all";
  let range = RANGES.some((item) => item.id === query?.get("rango") && item.days <= snapshot.historyDays)
    ? query.get("rango") : snapshot.historyDays < 7 ? "1d" : DEFAULT_RANGE;
  let selectedId = query?.get("llamada");
  let mapOpen = param === "mapa";
  let panel = null;
  let mapSignature;
  let disposed = false;
  let transcriptId;
  let transcriptController;
  let transcript = { status: "idle", data: null };
  const transcriptBody = el("div", { class: "chat transcript", role: "region", "aria-label": "Transcripción de la llamada" });
  const tbody = el("tbody", {});
  const hero = el("div", { class: "calls__panel" });
  const signals = el("aside", { class: "signals", hidden: true });
  const listCard = card({ flush: true }, el("div", { class: "table-wrap" },
    el("table", { class: "data" },
      el("thead", {}, el("tr", {}, ...["Llamada / paciente", "Acción", "Registro", "Sentimiento", "Duración", "Cuándo"].map((label) => el("th", {}, label)))),
      tbody)));
  const grid = el("div", { class: "grid grid--calls" }, listCard, hero, signals);
  const board = el("div", {}, grid);
  const visible = () => calls.filter((call) => inRange(call, range) && matchesState(call, filter));

  function togglePanel(kind) {
    panel = panel === kind ? null : kind;
    paint();
  }

  function paintTranscript() {
    const scrollTop = transcriptBody.scrollTop;
    mount(transcriptBody, ...transcriptContent(transcript));
    transcriptBody.scrollTop = scrollTop;
  }

  async function loadTranscript(id) {
    if (disposed || (id === transcriptId && transcriptController)) return;
    const changed = id !== transcriptId;
    transcriptController?.abort();
    transcriptId = id;
    if (changed) transcriptBody.scrollTop = 0;
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
      transcriptId === id && selectedId === id && !mapOpen && snapshot !== null;
    try {
      const data = await callTranscript(id, controller.signal);
      if (!current()) return;
      transcript = { status: "ok", data };
    } catch (error) {
      if (!current()) return;
      transcript = { status: "error", data: null, error: error.message };
    } finally {
      if (transcriptController === controller) transcriptController = undefined;
    }
    paintTranscript();
  }

  function paint() {
    if (disposed) return;
    const rows = visible();
    if (!rows.some((call) => call.id === selectedId)) selectedId = rows[0]?.id;
    const selected = rows.find((call) => call.id === selectedId);
    const nextTranscriptId = mapOpen ? undefined : selected?.id;
    if (nextTranscriptId !== transcriptId) void loadTranscript(nextTranscriptId);
    mount(tbody, ...rows.map((call) => el("tr", {
      class: call.id === selectedId ? "is-selected" : "",
      onclick: () => { selectedId = call.id; paint(); },
    },
    el("td", {}, el("div", { class: "cell-main" }, call.caller), el("div", { class: "cell-sub" }, call.phone)),
    el("td", {}, el("div", { class: "cell-main" }, call.reason), el("div", { class: "cell-sub" }, call.missReason)),
    el("td", {}, pill(outcomeLabels[call.outcome].text, outcomeLabels[call.outcome].pill.replace("pill--", ""))),
    el("td", { class: "muted text-sm" }, "No disponible"), el("td", { class: "mono" }, call.duration),
    el("td", { class: "cell-sub" }, call.time))));
    if (!rows.length) mount(tbody, el("tr", {}, el("td", { colspan: 6, class: "empty" }, "Sin registros observados con este filtro.")));
    if (!selected) mount(hero, card({}, emptyState("Sin selección", "Selecciona un registro de la lista.")));
    else mount(hero,
      chatCard(selected, panel, togglePanel, transcriptBody),
      el("div", { class: "grid grid--2" },
        card({ title: "Resumen del registro", sub: selected.id },
          el("dl", { class: "kv" },
            el("dt", {}, "Resultado observado"), el("dd", {}, outcomeLabels[selected.outcome].text),
            el("dt", {}, "Fuente del recibo"), el("dd", {}, selected.receiptSource ?? "Sin recibo observado"),
            el("dt", {}, "Cierre local"), el("dd", {}, selected.endReason ?? "No observado"),
            el("dt", {}, "Veredicto Prosper"), el("dd", {}, "No consultado"),
            el("dt", {}, "Sentimiento"), el("dd", {}, "No implementado"))),
        card({ title: "Acciones recibidas", sub: "No incluye borradores ni confirmaciones sin recibo" },
          selected.actions.length ? el("div", { class: "timeline" }, ...selected.actions.map((action) =>
            el("div", { class: "timeline__item" }, el("div", { class: "timeline__title" }, action))))
            : emptyState("Sin recibo observado", "Esto no permite deducir por sí solo un veredicto del juez."))));
    grid.classList.toggle("is-signals", Boolean(panel && selected));
    listCard.hidden = Boolean(panel && selected);
    signals.hidden = !panel || !selected;
    mount(signals, ...(panel && selected ? (panel === "metrics" ? metricsPanel(selected) : signalsPanel()) : []));
    if (mapOpen) {
      const signature = JSON.stringify(rows);
      if (signature !== mapSignature) {
        mount(board, networkPanel(rows, { state: filter, range }));
        mapSignature = signature;
      }
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
    mapSignature = null;
    mapButton.classList.toggle("btn--primary", mapOpen);
    mapButton.lastChild.textContent = mapOpen ? "Ocultar mapa" : "Ver mapa";
    paint();
  } }, icon("relations", "nav__icon"), el("span", {}, mapOpen ? "Ocultar mapa" : "Ver mapa"));
  const root = el("div", { class: "view" },
    el("p", { class: "card__sub" }, "«Registro abierto» indica un archivo reciente sin cierre, no que el paciente esté hablando. El contador del agente es la referencia de llamadas activas."),
    el("div", { class: "row row--wrap" },
      selector(STATES, filter, (value) => { filter = value; }),
      selector(RANGES.filter((item) => item.days <= snapshot.historyDays), range, (value) => { range = value; }),
      mapButton),
    board);
  root.update = () => {
    paint();
    if (!mapOpen && selectedId) void loadTranscript(selectedId);
  };
  root.dispose = () => {
    disposed = true;
    transcriptController?.abort();
    transcriptController = undefined;
    transcript = { status: "idle", data: null };
    mount(transcriptBody);
  };
  paint();
  return root;
}

function transcriptContent(state) {
  const nodes = [
    el("h3", { class: "text-sm" }, "Transcripción"),
    el("p", { class: "card__sub" },
      "Las horas son del registro, no tiempos acústicos exactos. El texto reconocido puede contener errores. El del agente es generado: puede estar interrumpido y no demuestra lo que se oyó."),
  ];
  if (state.status === "loading" || state.status === "refreshing") {
    nodes.push(el("p", { class: "text-sm", role: "status" },
      state.status === "loading" ? "Cargando transcripción…" : "Actualizando transcripción…"));
  }
  if (state.status === "error") {
    nodes.push(el("div", { role: "status" }, state.error === "dashboard_transcript_not_found"
      ? emptyState("Registro local no encontrado", "No hay un archivo para esta llamada dentro de la muestra reciente. Un recibo de Prosper no contiene la conversación.")
      : emptyState("Error al leer la transcripción", `La fuente no está disponible: ${state.error}. No se ha reconstruido ningún texto.`)));
  }
  if (!state.data) return nodes;
  nodes.push(el("p", { class: "card__sub" },
    `Consulta: ${transcriptTime.format(new Date(state.data.checkedAt))} · solo la llamada seleccionada`));
  if (state.data.limited) nodes.push(el("p", { class: "text-sm text-alert", role: "status" },
    "Muestra limitada: se muestran los fragmentos más recientes, no toda la conversación."));
  if (!state.data.entries.length) nodes.push(emptyState("Sin transcripción registrada",
    "El archivo no contiene fragmentos de texto completos disponibles."));
  nodes.push(...state.data.entries.map((entry) => el("article", {
    class: `chat__row chat__row--${entry.speaker === "user" ? "caller" : "agent"}`,
    "aria-label": entry.speaker === "user" ? "Interlocutor" : "Agente · texto generado",
  },
  el("div", { class: "transcript__message" },
    el("div", { class: "chat__meta" },
      el("span", {}, entry.speaker === "user" ? "Interlocutor · texto reconocido" : "Agente · texto generado"),
      el("time", { dateTime: entry.timestamp, title: entry.timestamp }, transcriptTime.format(new Date(entry.timestamp)))),
    entry.partial ? el("p", { class: "text-sm secondary" }, "Fragmento parcial · puede estar incompleto o interrumpido") : null,
    el("div", { class: "chat__bubble transcript__text", dir: "auto" }, entry.text),
    el("div", { class: "transcript__detail" }, `Ítem: ${entry.itemId}`,
      entry.startMs === undefined ? null : ` · Intervalo del modelo: ${entry.startMs}–${entry.endMs} ms`)))));
  return nodes;
}

function chatCard(call, panel, onToggle, transcriptBody) {
  return el("section", { class: "chat-card grain" },
    el("div", { class: "chat-card__head" }, icon("maio", "chat-card__logo"),
      el("div", { style: { minWidth: 0 } },
        el("div", { class: "chat-card__name" }, el("span", { class: "truncate" }, call.caller),
          pill(call.live ? "Registro abierto" : outcomeLabels[call.outcome].text, "neutral", call.live)),
        el("div", { class: "chat-card__sub truncate" }, call.time)),
      el("div", { class: "row ml-auto" },
        el("button", { class: `signal-btn${panel === "metrics" ? " is-on" : ""}`, onclick: () => onToggle("metrics") },
          icon("reports", "signal-btn__icon"), "Ver analítica"),
        el("button", { class: `signal-btn${panel === "signals" ? " is-on" : ""}`, onclick: () => onToggle("signals") }, "Señales"))),
    transcriptBody,
    el("details", { class: "transcript-events" },
      el("summary", { class: "text-sm" }, "Eventos técnicos recientes"),
      ...call.events.slice(-12).map((event) =>
        el("div", { class: "timeline__item" },
          el("div", { class: "timeline__time" }, formatDate(event.timestamp)),
          el("div", { class: "timeline__title" }, event.code)))),
    el("div", { class: "player" },
      el("button", { class: "player__btn", disabled: true, title: "Audio privado no expuesto" }, icon("play", "nav__icon")),
      el("span", { class: "text-sm muted" }, "Reproducción no disponible"),
      el("span", { class: "mono ml-auto" }, call.duration)));
}

export function signalsPanel() {
  return [card({ title: "Señales no implementadas" },
    emptyState("Sentimiento e intenciones: no disponibles",
      "El backend no genera emoción, confianza de intención ni recomendaciones. No se inferirán a partir del resultado de la llamada."))];
}

function metricsPanel(call) {
  const q = callQuality(call);
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
