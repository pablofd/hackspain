import { el } from "../lib/dom.js";
import { card, pill, bar } from "./ui.js";
import { demoAgent as agent } from "../data/agent-demo.js";

function fields(rows) {
  return el("dl", { class: "kv" }, ...rows.flatMap(([name, value]) =>
    [el("dt", {}, name), el("dd", {}, String(value))]));
}

function switches(rows) {
  return el("div", {}, ...rows.map(([name, description, enabled]) =>
    el("div", { class: "toggle-row" },
      el("div", { class: "toggle-row__body" },
        el("div", { class: "toggle-row__title" }, name),
        el("div", { class: "toggle-row__desc" }, description)),
      el("button", { class: `switch${enabled ? " is-on" : ""}`, role: "switch",
        "aria-label": name, "aria-checked": String(enabled), disabled: true }))));
}

export function demoConfiguration(tab) {
  const notice = el("p", { class: "connection-banner", role: "status" },
    "Configuración ficticia del mockup · solo lectura. No configura Azure ni el agente real; canales, métricas y cumplimiento son ejemplos.");
  if (tab === "agente") return [notice,
    el("div", { class: "grid grid--main" },
      card({ title: "Identidad", sub: "Cómo se presenta maio en el escenario ficticio" },
        fields([["Nombre", agent.name], ["Clínica", agent.clinic], ["Voz", agent.voices[0]],
          ["Voces del mockup", agent.voices.join(" · ")], ["Idiomas", agent.languages]]),
        el("label", { class: "field" }, "Saludo",
          el("textarea", { class: "textarea", readOnly: true, "aria-label": "Saludo demo", value: agent.greeting }))),
      el("div", { class: "stack stack--lg" },
        card({ title: "Rendimiento", sub: "Valores simulados", tint: "accent" },
          fields([["Llamadas", agent.calls], ["Resolución", `${agent.resolution}%`], ["Media", agent.avgHandle]]), bar(agent.resolution)),
        card({ title: "Canales", sub: "No son integraciones reales" },
          el("div", { class: "chips" }, ...agent.channels.map((name) => pill(name))))))];
  if (tab === "instrucciones") return [notice,
    el("div", { class: "grid grid--main" },
      card({ title: "Instrucciones del agente", sub: "Prompt ficticio original; no se aplica a ninguna llamada" },
        el("textarea", { class: "textarea", readOnly: true, "aria-label": "Prompt demo",
          style: { minHeight: "360px" }, value: agent.instructions }),
        el("p", { class: "card__sub" }, `${agent.instructions.length} caracteres · solo lectura`)),
      el("div", { class: "stack stack--lg" },
        card({ title: "Tono" }, fields([["Registro", "Cálido"], ["Tratamiento", "Usted"], ["Longitud", "Breve"]])),
        card({ title: "Frases prohibidas" }, el("div", { class: "chips" },
          ...["diagnóstico", "receta", "no se preocupe", "seguro que no es nada"].map((name) => pill(name)))))),
    el("div", { class: "grid grid--main" },
      card({ title: "Carácter", sub: "Rasgos simulados del mockup" },
        ...agent.traits.map(([name, value]) => el("label", { class: "field" },
          `${name} · ${value}`, el("input", { class: "range", type: "range", min: 0, max: 100,
            value, disabled: true, "aria-label": name })))),
      card({ title: "Reacciones", sub: "Políticas ficticias, no reglas clínicas del backend" }, fields(agent.policies)))];
  if (tab === "acciones") return [notice,
    card({ title: "Acciones habilitadas", sub: "Capacidades ilustrativas del mockup" }, switches(agent.skills)),
    card({ title: "Sistemas conectados", sub: "Estados ficticios; no se consulta ningún sistema" },
      fields(agent.systems.map(([name, detail, state]) => [name, `${detail} · ${state}`])))];
  return [notice,
    card({ title: "Barandillas", sub: "Ejemplos del mockup" }, switches(agent.guardrails)),
    el("div", { class: "grid grid--2" },
      card({ title: "Datos y retención" }, fields([["Retención de audio", "90 días"],
        ["Residencia de datos", "Unión Europea"], ["Responsable del tratamiento", "Clínica Vera Salud, S.L."]])),
      card({ title: "Estado de cumplimiento", sub: "Simulado; no constituye una auditoría" },
        fields([["Aviso de IA", "100% de llamadas"], ["Consentimiento", "99,4% registrado"],
          ["Cifrado", "AES-256 en reposo"], ["Incidencias", "0 abiertas"]])) )];
}
