import { el, mount } from "../lib/dom.js";
import { card, bar, emptyState } from "./ui.js";
import { callSignals, signalToneLabels, signalIntentLabels, signalPatternLabels, signalConfidenceLabels } from "../data/api.js";

const clock = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "medium",
});
const number = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const errors = {
  signals_busy: "Hay otro análisis en curso. Puedes reintentar cuando termine la espera.",
  signals_cooldown: "El servicio requiere una pausa antes de volver a analizar.",
  signals_disabled: "El análisis de señales no está configurado o está deshabilitado.",
  signals_unavailable: "El servicio de análisis no está disponible.",
  signals_invalid_response: "La respuesta de análisis no cumple el contrato; no se mostrarán estimaciones sin validar.",
  signals_invalid_configuration: "La configuración de análisis no es válida.",
  signals_cancelled: "La consulta se canceló al cambiar de panel. No se reintenta automáticamente.",
  dashboard_unauthorized: "Acceso no autorizado. Vuelve a conectar el dashboard.",
  dashboard_transcript_not_found: "No se encuentra la transcripción de esta llamada.",
  dashboard_invalid_call_id: "El identificador de llamada no es válido.",
};

export function realSignalsPanel() {
  const cache = new Map();
  let callId;
  let config;
  let configurationKey;
  let visible = false;
  let authorized = false;
  let disposed = false;
  let revision = 0;
  let controller;
  let timer;
  let state;
  let renderedData;
  let renderedContent;
  const cost = el("p", { class: "card__sub" },
    "Usa inferencia de texto de Azure con coste separado. Solo esta llamada; no cambia el agente ni el EHR.");
  const status = el("p", { class: "text-sm", role: "status" });
  const timing = el("p", { class: "card__sub signals-timing" });
  const source = el("p", { class: "card__sub signals-source" });
  const stale = el("p", { class: "text-sm text-alert", hidden: true });
  const button = el("button", { class: "btn btn--sm", onclick: () => {
    if (!available() || !visible || disposed) return;
    authorized = true;
    void request();
  } }, "Analizar esta llamada");
  const body = el("div", { class: "stack stack--lg" });
  const element = el("div", { class: "real-signals stack stack--lg", role: "region", "aria-label": "Señales textuales de la llamada" },
    card({ title: "Señales del texto", sub: "Azure · estimaciones lingüísticas" },
      cost, status, source, stale, timing, button,
      el("p", { class: "card__sub" },
        "No mide emociones ni diagnostica. Los indicadores y la confianza no son probabilidades calibradas; un recibo de reserva no demuestra satisfacción.")),
    body);

  function available() {
    return config?.enabled === true && config.estimated === true && typeof config.model === "string" && config.model.length > 0 &&
      Number.isFinite(config.minRefreshSeconds) && config.minRefreshSeconds >= 30;
  }

  function cancel() {
    revision += 1;
    clearTimeout(timer);
    if (controller) {
      controller.abort();
      controller = undefined;
      if (state) { state.error = "signals_cancelled"; state.automatic = false; }
    }
  }

  function render() {
    if (disposed) return;
    const data = state?.data ?? null;
    const configured = available();
    button.hidden = !configured || !callId;
    button.disabled = Boolean(controller) || Date.now() < (state?.nextAllowed ?? 0);
    button.textContent = controller ? "Analizando…" : state?.error ? "Reintentar análisis" : data ? "Actualizar análisis" : "Analizar esta llamada";
    status.classList.toggle("text-alert", Boolean(state?.error) || (config?.enabled === true && !configured));
    if (!configured) {
      status.textContent = config?.enabled ? errors.signals_invalid_configuration : "Análisis textual no configurado.";
      mount(body, emptyState("Sentimiento e intenciones: no disponibles", "No se ha enviado texto a Azure desde este panel."));
      renderedData = renderedContent = undefined;
    } else {
      status.textContent = state?.error
        ? `${errors[state.error] ?? "No se pudo obtener el análisis."} (${state.error})`
        : controller ? "Analizando texto de esta llamada…"
          : data?.status === "insufficient_data" ? "Texto insuficiente para estimar señales. No hay un análisis disponible."
            : data ? "Último análisis recibido · conservado en esta vista."
              : "Abre el análisis de esta llamada de forma explícita.";
      if (data !== renderedData) {
        const content = data?.analysis ? JSON.stringify([data.analysis, data.evidence]) : "";
        if (content !== renderedContent) {
          const expanded = body.querySelector(".signals-evidence")?.open;
          mount(body, ...(data?.analysis ? analysisCards(data) : []));
          const evidence = body.querySelector(".signals-evidence");
          if (evidence && expanded) evidence.open = true;
          renderedContent = content;
        }
        renderedData = data;
      }
    }
    source.textContent = data
      ? `Fuente: Azure · ${data.model} · análisis: ${data.analyzedAt ? clock.format(new Date(data.analyzedAt)) : "fecha no disponible"} · ${data.coverage.entries} fragmentos / ${data.coverage.characters} caracteres${data.coverage.limited ? " · Muestra limitada; no es toda la conversación." : ""}`
      : configured ? `Fuente: Azure · ${config.model}` : "Fuente: Azure · no configurada";
    stale.hidden = !data || (!data.stale && !state?.error && !controller);
    stale.textContent = data?.stale ? "Resultado marcado como desactualizado por el servidor." :
      state?.error ? "Se conserva el análisis anterior, sin actualizar." : "Se muestra el análisis anterior mientras se actualiza.";
    timing.textContent = configured
      ? `${state?.nextAllowed > Date.now() ? `Siguiente consulta posible: ${clock.format(new Date(state.nextAllowed))}. ` : ""}Actualización mínima: ${config.minRefreshSeconds} s, solo mientras este panel está visible. Los errores requieren reintento explícito.`
      : "";
  }

  function schedule() {
    clearTimeout(timer);
    if (disposed || !visible || !available() || !state || controller || document.hidden) return;
    const delay = Math.max(0, state.nextAllowed - Date.now());
    if (authorized && state.automatic && !state.error) {
      timer = setTimeout(() => void request(), Math.min(Math.max(1, delay), 2_147_483_647));
    } else if (delay > 0) {
      // Cooldown expiry only enables the button after an error; it never retries.
      timer = setTimeout(() => { render(); schedule(); }, Math.min(delay, 2_147_483_647));
    }
  }

  async function request() {
    if (disposed || !visible || !authorized || !available() || !callId || controller || document.hidden) return;
    if (Date.now() < state.nextAllowed) { render(); schedule(); return; }
    clearTimeout(timer);
    const active = new AbortController();
    controller = active;
    const currentRevision = revision;
    const id = callId;
    const currentState = state;
    currentState.nextAllowed = Date.now() + config.minRefreshSeconds * 1000;
    currentState.error = null;
    currentState.automatic = false;
    render();
    const current = () => !disposed && visible && authorized && revision === currentRevision &&
      controller === active && !active.signal.aborted && callId === id;
    try {
      const data = await callSignals(id, active.signal);
      if (!current()) return;
      currentState.data = data;
      currentState.nextAllowed = Math.max(currentState.nextAllowed, data.nextRefreshAt ? Date.parse(data.nextRefreshAt) : 0);
      currentState.automatic = true;
    } catch (error) {
      if (!current()) return;
      currentState.error = error.message;
    } finally {
      if (controller === active) controller = undefined;
    }
    if (disposed || revision !== currentRevision || !visible || callId !== id) return;
    render();
    schedule();
  }

  return {
    element,
    update(id, capability, isVisible) {
      if (disposed) return;
      const key = JSON.stringify([capability?.enabled, capability?.model, capability?.minRefreshSeconds, capability?.estimated]);
      if (key !== configurationKey || id !== callId) {
        cancel();
        if (key !== configurationKey) cache.clear();
        configurationKey = key;
        config = capability;
        callId = id;
        authorized = false;
        renderedData = renderedContent = undefined;
        if (id) {
          state = cache.get(id) ?? { data: null, nextAllowed: 0, error: null, automatic: false };
          cache.delete(id);
          cache.set(id, state);
          while (cache.size > 8) cache.delete(cache.keys().next().value);
        } else state = undefined;
      } else if (!isVisible && visible) {
        cancel();
        authorized = false;
      }
      visible = isVisible;
      if (visible) { render(); schedule(); }
    },
    open() {
      if (disposed || !visible || !available() || !callId) return;
      authorized = true;
      if (!state.error && Date.now() >= state.nextAllowed) void request();
      else { render(); schedule(); }
    },
    dispose() {
      cancel();
      disposed = true;
      authorized = false;
      cache.clear();
      state = renderedData = renderedContent = undefined;
      element.replaceChildren();
    },
  };
}

function analysisCards(data) {
  const quotes = new Map();
  const evidence = el("details", { class: "signals-evidence" },
    el("summary", {}, `Textos del interlocutor (${data.evidence.length})`),
    ...data.evidence.map((entry, index) => {
      const quote = el("figure", { class: "signals-quote", tabIndex: -1 },
        el("figcaption", {}, `Texto ${index + 1} · Interlocutor · ${clock.format(new Date(entry.timestamp))}`),
        el("blockquote", { dir: "auto" }, entry.text));
      quotes.set(entry.id, { node: quote, index: index + 1 });
      return quote;
    }));
  const references = (ids) => el("div", { class: "signals-references" },
    ids.length ? "Evidencia del interlocutor: " : "Sin evidencia textual asociada.",
    ...ids.map((id) => el("button", { class: "btn btn--sm btn--ghost", onclick: () => {
      const quote = quotes.get(id);
      evidence.open = true;
      quote.node.scrollIntoView({ block: "nearest" });
      quote.node.focus({ preventScroll: true });
    } }, `Texto ${quotes.get(id).index}`)));
  return [
    card({ title: `Tono lingüístico estimado: ${signalToneLabels[data.analysis.tone]}` },
      ...[["calmness", "Calma expresada"], ["satisfaction", "Satisfacción expresada"], ["confusion", "Confusión expresada"]]
        .map(([key, label]) => {
          const indicator = data.analysis.indicators[key];
          return el("section", { class: "textual-indicator", "aria-label": label },
            el("div", { class: "row" }, el("span", {}, label),
              el("strong", { class: "mono ml-auto" }, indicator.score === null ? "Desconocido" : `${number.format(indicator.score)} /100`)),
            el("p", { class: "card__sub" }, "Indicador textual estimado; no emoción medida"),
            indicator.score === null ? null : bar(indicator.score),
            references(indicator.evidence));
        })),
    card({ title: "Intenciones expresadas", sub: "Confianza cualitativa del modelo, no probabilidad calibrada" },
      data.analysis.intents.length ? el("div", { class: "list" }, ...data.analysis.intents.map((intent) =>
        el("div", { class: "signals-finding" },
          el("div", { class: "row" }, el("span", {}, signalIntentLabels[intent.kind]),
            el("span", { class: "pill pill--neutral ml-auto" }, `Confianza: ${signalConfidenceLabels[intent.confidence]}`)),
          references(intent.evidence)))) : el("p", { class: "text-sm muted" }, "No se han identificado intenciones con respaldo textual.")),
    card({ title: "Patrones lingüísticos estimados" },
      data.analysis.patterns.length ? el("div", { class: "list" }, ...data.analysis.patterns.map((pattern) =>
        el("div", { class: "signals-finding" }, el("span", {}, signalPatternLabels[pattern.kind]), references(pattern.evidence))))
        : el("p", { class: "text-sm muted" }, "No se han identificado patrones con respaldo textual.")),
    card({ title: "Evidencia textual", sub: "Solo citas del interlocutor; la transcripción puede contener errores" }, evidence),
  ];
}
