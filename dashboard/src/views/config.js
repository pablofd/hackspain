import { el, mount } from "../lib/dom.js";
import { card, pill, emptyState } from "../components/ui.js";
import { sourcesCard } from "../components/sources.js";
import { snapshot } from "../data/api.js";
import { presentation } from "../data/presentation.js";
import { demoConfiguration } from "../components/demo-config.js";

export const meta = { title: "Configuración", sub: "Perfil e instrucciones · configuración de solo lectura" };
const tabs = [
  { id: "agente", label: "Agente" }, { id: "instrucciones", label: "Instrucciones" },
  { id: "acciones", label: "Acciones" }, { id: "cumplimiento", label: "Cumplimiento" },
];
const capabilities = {
  voice: "Voz entrante", clinic: "Consultas a Prosper", book: "Comunicar reserva",
  reschedule: "Comunicar cambio", cancel: "Comunicar cancelación", register: "Comunicar alta",
  outcomes: "Comunicar NO_ACTION / ESCALATE",
};

export function render() {
  let tab = "agente";
  const panel = el("div", { class: "stack stack--lg" });
  function paint() {
    if (presentation === "demo") {
      mount(panel, ...demoConfiguration(tab));
      return;
    }
    const health = snapshot.health;
    if (tab === "agente") mount(panel,
      el("div", { class: "grid grid--main" },
        card({ title: "Perfil en ejecución", sub: "Respuesta de /healthz; no prueba una invocación exitosa a Azure" },
          el("dl", { class: "kv" }, ...[
            ["Clínica", snapshot.clinic?.name],
            ["Estado", health?.status],
            ["Conector", health?.voiceConnector],
            ["Deployment de voz", health?.voiceDeployment],
            ["Voz configurada", snapshot.agentConfiguration?.voice],
            ["Backend Live", health?.voiceConnector === "live" ? health.voiceBackendDeployment : "No utilizado"],
            ["Ganancia de salida", health ? `${health.voiceOutputGainDb} dB` : null],
            ["Llamadas activas", health?.activeCalls],
            ["Exportación de trazas", health?.telemetry === "azure" ? "Application Insights" : health ? "Consola local" : null],
          ].flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value ?? "No disponible")]))),
        sourcesCard()),
      card({ title: "Canales" }, pill("Prosper / WebSocket entrante"),
        el("p", { class: "card__sub" }, "No hay WhatsApp, SMS, llamadas salientes ni un servicio Speech separado en el runtime.")));
    else if (tab === "instrucciones") mount(panel,
      card({ title: "Instrucciones del agente", sub: "Copia de las instrucciones enviadas a Azure desde este backend; sin conexión a Foundry y sin edición." },
        snapshot.agentConfiguration ? [
          el("p", { class: "card__sub" }, "Fecha de referencia: hoy en Madrid. Cada llamada usa su propia fecha. Esta vista no inspecciona sesiones ya abiertas."),
          el("textarea", { class: "textarea", readOnly: true, "aria-label": "Prompt real de Azure",
            style: { minHeight: "440px" }, value: snapshot.agentConfiguration.prompt }),
          el("p", { class: "card__sub" }, `${snapshot.agentConfiguration.prompt.length} caracteres · src/receptionist.ts`),
        ] : emptyState("Prompt no disponible", "Actualiza el adaptador del dashboard para consultar las instrucciones del backend.")),
      card({ title: "Carácter, reacciones y simulación" }, emptyState("No implementados",
        "No hay valores reales de personalidad ni previsiones de satisfacción que mostrar. Los ajustes de demostración no se aplican al agente.")));
    else if (tab === "acciones") mount(panel,
      card({ title: "Capacidades publicadas por el agente", sub: "Solo lectura. Una acción clínica exige los controles de identidad y confirmación del backend." },
        health ? el("div", { class: "list" }, ...health.capabilities.map((capability) =>
          el("div", { class: "list__item" }, el("div", { class: "list__body" }, capabilities[capability] ?? capability), pill("Habilitada"))))
          : emptyState("No disponible", "No se ha podido consultar /healthz.")),
      sourcesCard());
    else mount(panel,
      card({ title: "Grabación local" },
        el("dl", { class: "kv" },
          el("dt", {}, "Registros privados"), el("dd", {}, health ? (health.localRecording ? "Activados" : "Desactivados") : "No disponible"),
          el("dt", {}, "Audio local"), el("dd", {}, health ? (health.localAudioRecording ? "Activado" : "Desactivado") : "No disponible"),
          el("dt", {}, "Contenido servido"), el("dd", {}, "Metadatos y transcripción autenticada de la llamada seleccionada; sin archivos NDJSON ni WAV"))),
      card({ title: "Cumplimiento" }, emptyState("Sin puntuación automática",
        "La presencia de guardas o recibos no demuestra consentimiento correcto, exactitud clínica ni cumplimiento normativo. No se inventan porcentajes.")));
  }
  const bar = el("div", { class: "segmented" }, ...tabs.map((item) =>
    el("button", { class: tab === item.id ? "is-active" : "", onclick: (event) => {
      tab = item.id;
      bar.querySelectorAll("button").forEach((button) => button.classList.remove("is-active"));
      event.currentTarget.classList.add("is-active");
      paint();
    } }, item.label)));
  const root = el("div", { class: "view" }, bar, panel);
  root.update = paint;
  paint();
  return root;
}
