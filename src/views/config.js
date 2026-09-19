import { el, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill, toggle, bar } from "../components/ui.js";
import { statusCard } from "../components/status.js";
import { agentProfile, behaviourDefaults, TRAITS, POLICIES } from "../data/mock.js";

export const meta = {
  title: "Configuración",
  sub: "Voz, instrucciones, acciones y cumplimiento de maio",
};

const TABS = [
  { id: "agente", label: "Agente" },
  { id: "instrucciones", label: "Instrucciones" },
  { id: "acciones", label: "Acciones" },
  { id: "cumplimiento", label: "Cumplimiento" },
];

export function render() {
  let tab = "agente";
  let statusOpen = false;
  const state = {
    traits: { ...behaviourDefaults.traits },
    policies: { ...behaviourDefaults.policies },
  };

  const panel = el("div", { class: "stack stack--lg" });
  const statusHost = el("aside", { class: "status-host", hidden: true });
  const board = el("div", { class: "config-board" }, panel, statusHost);

  function paintStatus() {
    if (statusOpen) mount(statusHost, statusCard(state));
  }

  const tabsBar = el(
    "div",
    { class: "segmented" },
    ...TABS.map((t) =>
      el(
        "button",
        {
          class: t.id === tab ? "is-active" : "",
          onclick: () => {
            tab = t.id;
            paint();
          },
        },
        t.label,
      ),
    ),
  );

  const statusBtn = el(
    "button",
    {
      class: "btn",
      onclick: () => {
        statusOpen = !statusOpen;
        statusBtn.classList.toggle("btn--primary", statusOpen);
        statusBtn.lastChild.textContent = statusOpen ? "Ocultar estado" : "Estado";
        board.classList.toggle("is-status", statusOpen);
        statusHost.hidden = !statusOpen;
        paintStatus();
      },
    },
    icon("relations", "nav__icon"),
    el("span", {}, "Estado"),
  );

  function paint() {
    tabsBar.querySelectorAll("button").forEach((b, i) => {
      b.classList.toggle("is-active", TABS[i].id === tab);
    });
    mount(panel, ...tabContent(tab, state, paintStatus));
    paintStatus();
  }

  paint();

  return el(
    "div",
    { class: "view" },
    el("div", { class: "row row--wrap" }, tabsBar, statusBtn),
    board,
  );
}

function tabContent(tab, state, onChange) {
  if (tab === "instrucciones") return instructionsTab(state, onChange);
  if (tab === "acciones") return actionsTab();
  if (tab === "cumplimiento") return complianceTab();
  return agentTab();
}

function agentTab() {
  return [
    el(
      "div",
      { class: "grid grid--main" },
      card(
        { title: "Identidad", sub: "Cómo se presenta maio al descolgar" },
        field("Nombre", el("input", { class: "input", value: agentProfile.name })),
        field("Clínica", el("input", { class: "input", value: agentProfile.clinic })),
        field(
          "Voz",
          el("select", { class: "select" }, ...agentProfile.voices.map((v) => el("option", {}, v))),
        ),
        field("Idiomas", el("input", { class: "input", value: agentProfile.languages })),
        field(
          "Saludo",
          el(
            "textarea",
            { class: "textarea", style: { minHeight: "84px", fontFamily: "var(--font-ui)", fontSize: "13px" } },
            agentProfile.greeting,
          ),
        ),
      ),
      el(
        "div",
        { class: "stack stack--lg" },
        card(
          { title: "Rendimiento", tint: "accent" },
          el(
            "div",
            { class: "agent-card__metrics", style: { borderTop: "0", paddingTop: "0" } },
            metric("Llamadas", agentProfile.calls),
            metric("Resolución", `${agentProfile.resolution}%`),
            metric("Media", agentProfile.avgHandle),
          ),
          el("div", { style: { marginTop: "16px" } }, bar(agentProfile.resolution)),
        ),
        card(
          { title: "Canales" },
          el(
            "div",
            { class: "chips" },
            ...agentProfile.channels.map((c) => el("span", { class: "chip" }, c)),
            el("button", { class: "btn btn--sm btn--ghost" }, "Añadir"),
          ),
        ),
      ),
    ),
    saveBar(),
  ];
}

function instructionsTab(state, onChange) {
  const editor = el(
    "textarea",
    { class: "textarea", style: { minHeight: "300px" } },
    agentProfile.instructions,
  );
  const counter = el("span", { class: "text-sm muted" }, `${agentProfile.instructions.length} caracteres`);
  editor.addEventListener("input", () => {
    counter.textContent = `${editor.value.length} caracteres`;
  });

  return [
    el(
      "div",
      { class: "grid grid--main" },
      card(
        {
          title: "Instrucciones del agente",
          sub: "Define cómo se comporta maio en cada llamada",
          actions: el("button", { class: "btn btn--sm btn--ghost" }, "Restaurar"),
        },
        editor,
        el(
          "div",
          { class: "row", style: { marginTop: "12px" } },
          counter,
          el("span", { class: "text-sm muted ml-auto" }, "Se aplica a la siguiente llamada"),
        ),
      ),
      el(
        "div",
        { class: "stack stack--lg" },
        card(
          { title: "Tono" },
          choice("Registro", ["Cálido", "Neutro", "Formal"], 0),
          choice("Tratamiento", ["Usted", "Tú"], 0),
          choice("Longitud", ["Breve", "Media", "Detallada"], 0),
        ),
        card(
          { title: "Frases prohibidas", sub: "maio nunca las dirá" },
          el(
            "div",
            { class: "chips" },
            ...["diagnóstico", "receta", "no se preocupe", "seguro que no es nada"].map((t) =>
              el("span", { class: "chip" }, t),
            ),
            el("button", { class: "btn btn--sm btn--ghost" }, "Añadir"),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        { title: "Carácter", sub: "Mueve los rasgos y observa el estado del agente" },
        ...TRAITS.map(([key, label, desc]) => slider(label, desc, state.traits[key], (v) => {
          state.traits[key] = v;
          onChange();
        })),
      ),
      card(
        { title: "Reacciones", sub: "Qué hace maio en cada situación" },
        ...POLICIES.map((p) =>
          choice(p.label, p.options, state.policies[p.id], (i) => {
            state.policies[p.id] = i;
            onChange();
          }),
        ),
      ),
    ),
    saveBar(),
  ];
}

/* Deslizador 0-100 que refleja el valor en vivo */
function slider(label, desc, value, onInput) {
  const out = el("span", { class: "meter__val" }, String(value));
  const input = el("input", {
    class: "range",
    type: "range",
    min: "0",
    max: "100",
    step: "2",
    value: String(value),
    oninput: (e) => {
      out.textContent = e.target.value;
      onInput(Number(e.target.value));
    },
  });
  return el(
    "div",
    { class: "field" },
    el("div", { class: "meter__top" }, el("label", {}, label), out),
    input,
    desc && el("span", { class: "hint" }, desc),
  );
}

function actionsTab() {
  return [
    card(
      { title: "Acciones habilitadas", sub: "Lo que maio puede ejecutar sin supervisión" },
      el(
        "div",
        {},
        ...agentProfile.skills.map(([name, desc, on]) => toggleRow(name, desc, on)),
      ),
    ),
    card(
      { title: "Sistemas conectados", sub: "Dónde escribe maio cuando ejecuta una acción" },
      el(
        "div",
        { class: "list" },
        ...[
          ["Doctoralia", "Agenda y profesionales", "Operativo", "ok"],
          ["HIS · HL7 FHIR", "Historia clínica", "Operativo", "ok"],
          ["Adeslas API", "Coberturas y autorizaciones", "Latencia alta", "alert"],
          ["Twilio Voice", "Telefonía SIP", "Operativo", "ok"],
          ["Stripe", "Cobros", "Desconectado", "neutral"],
        ].map(([n, d, label, tone]) =>
          el(
            "div",
            { class: "list__item" },
            el(
              "div",
              { class: "list__body" },
              el("div", { class: "list__title" }, n),
              el("div", { class: "list__meta" }, d),
            ),
            pill(label, tone),
          ),
        ),
      ),
    ),
    saveBar(),
  ];
}

function complianceTab() {
  return [
    card(
      { title: "Barandillas", sub: "Se aplican antes de cada acción" },
      el(
        "div",
        {},
        ...agentProfile.guardrails.map(([name, desc, on]) => toggleRow(name, desc, on)),
      ),
    ),
    el(
      "div",
      { class: "grid grid--2" },
      card(
        { title: "Datos y retención" },
        field(
          "Retención de audio",
          el(
            "select",
            { class: "select" },
            el("option", {}, "30 días"),
            el("option", { selected: true }, "90 días"),
            el("option", {}, "1 año"),
          ),
        ),
        field(
          "Residencia de datos",
          el("select", { class: "select" }, el("option", {}, "Unión Europea"), el("option", {}, "España")),
        ),
        field("Responsable del tratamiento", el("input", { class: "input", value: "Clínica Vera Salud, S.L." })),
      ),
      card(
        { title: "Estado de cumplimiento", tint: "ok" },
        el(
          "dl",
          { class: "kv" },
          el("dt", {}, "Aviso de IA"),
          el("dd", {}, "100% de llamadas"),
          el("dt", {}, "Consentimiento"),
          el("dd", {}, "99,4% registrado"),
          el("dt", {}, "Cifrado"),
          el("dd", {}, "AES-256 en reposo"),
          el("dt", {}, "Incidencias"),
          el("dd", {}, "0 abiertas"),
        ),
      ),
    ),
    saveBar(),
  ];
}

function toggleRow(name, desc, on) {
  return el(
    "div",
    { class: "toggle-row" },
    el(
      "div",
      { class: "toggle-row__body" },
      el("div", { class: "toggle-row__title" }, name),
      el("div", { class: "toggle-row__desc" }, desc),
    ),
    toggle(on),
  );
}

/* Selector en línea con una sola opción activa */
function choice(label, options, activeIndex, onPick) {
  const group = el(
    "div",
    { class: "segmented segmented--wrap" },
    ...options.map((o, i) =>
      el(
        "button",
        {
          class: i === activeIndex ? "is-active" : "",
          onclick: (e) => {
            group.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
            e.currentTarget.classList.add("is-active");
            onPick?.(i);
          },
        },
        o,
      ),
    ),
  );
  return el("div", { class: "field" }, el("label", {}, label), group);
}

function saveBar() {
  return el(
    "div",
    { class: "row row--wrap" },
    el("button", { class: "btn btn--primary" }, "Guardar cambios"),
    el("button", { class: "btn" }, "Probar voz"),
    el("div", { class: "ml-auto" }, pill("Última edición hoy 08:12", "ok")),
  );
}

function field(label, control) {
  return el("div", { class: "field" }, el("label", {}, label), control);
}

function metric(label, value) {
  return el("div", { class: "agent-card__metric" }, el("span", {}, label), el("strong", {}, String(value)));
}

