import { el, mount } from "../lib/dom.js";
import { card, pill } from "./ui.js";
import { snapshot } from "../data/api.js";

const names = {
  voice: "Agente local", clinic: "Catálogo Prosper", submissions: "Recibos Prosper",
  records: "Metadatos locales", azure: "Azure Monitor", foundry: "Foundry / Application Insights",
  speech: "Azure Speech",
};
const states = { ok: "Disponible", error: "Error", not_configured: "Sin configurar", not_used: "No utilizado" };

export function compactSources() {
  const summary = el("summary", {});
  const body = el("div", { class: "source-popover" });
  const element = el("details", { class: "source-status" }, summary, body);
  function update() {
    const errors = Object.values(snapshot.sources).filter((source) => source.status === "error").length;
    summary.textContent = `Fuentes de datos${errors ? ` · ${errors} con error` : " · estado real"}`;
    summary.classList.toggle("text-alert", errors > 0);
    mount(body, sourcesCard());
  }
  return { element, update, close() { element.open = false; } };
}

export function sourcesCard() {
  return card({ title: "Fuentes de datos", sub: "Sin datos simulados ni sustituciones automáticas" },
    el("div", { class: "source-list" }, ...Object.entries(snapshot.sources).map(([key, source]) =>
      el("div", { class: "source-row" },
        el("div", {}, el("strong", {}, names[key]), source.code && el("div", { class: "muted" }, source.code)),
        pill(states[source.status], source.status === "error" ? "alert" : "neutral")))),
    snapshot.coverage.recordPermissionsRestricted === false && el("p", { class: "card__sub text-alert" },
      "Los registros de origen tienen permisos o ACL adicionales. Revisa su acceso local; el adaptador no cambia permisos ni publica su contenido."),
    el("p", { class: "card__sub" },
      `Muestra de ${snapshot.historyDays} días: hasta 200 archivos locales y 200 recibos. No es un histórico completo. Azure puede llegar con retraso.`));
}

const labels = {
  AzureOpenAIRequests: "Peticiones al modelo",
  ProcessedPromptTokens: "Tokens de entrada",
  GeneratedTokens: "Tokens de salida",
  AudioPromptTokens: "Tokens de audio de entrada",
  AudioCompletionTokens: "Tokens de audio de salida",
  RealtimeUsageTime: "Uso de Realtime",
  AzureOpenAITimeToResponse: "Tiempo a primera respuesta (gateway)",
  AudioSecondsTranscribed: "Audio transcrito",
  SynthesizedCharacters: "Caracteres sintetizados",
  Latency: "Latencia del recurso Speech",
};
const units = { tokens: "tokens", requests: "peticiones", seconds: "s", ms: "ms", characters: "caracteres" };
export function cloudCard(kind) {
  const data = snapshot.cloud[kind];
  return card({
    title: kind === "openAi" ? "Azure / Foundry · consumo y respuesta" : "Azure Speech",
    sub: data ? (data.deployment
      ? `Deployment ${data.deployment} · no atribuible a una sola llamada`
      : "Recurso externo: no forma parte del agente de voz actual") : "No disponible",
  }, data
    ? el("dl", { class: "kv" }, ...data.metrics.flatMap((metric) => [
      el("dt", {}, labels[metric.name] ?? metric.name),
      el("dd", { class: "mono" }, metric.value == null ? `— (${metric.status})`
        : `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(metric.value)} ${units[metric.unit]}`),
    ]))
    : el("p", { class: "text-sm secondary" }, kind === "openAi"
      ? "Configura el recurso de Azure Monitor y sus permisos de lectura. La clave de inferencia no da acceso a estas métricas."
      : "El agente usa audio de Azure OpenAI, no el servicio Azure Speech separado. No hay consumo Speech que atribuirle."),
  data && el("p", { class: "card__sub" },
    `${new Date(data.start).toLocaleDateString("es-ES")} – ${new Date(data.end).toLocaleDateString("es-ES")}. Sin datos no equivale a cero.`));
}
