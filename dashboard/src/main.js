import { el, mount } from "./lib/dom.js";
import { icon } from "./lib/icons.js";
import { connect, disconnect, refresh, snapshot } from "./data/api.js";
import * as home from "./views/home.js";
import * as calls from "./views/calls.js";
import * as config from "./views/config.js";
import * as clients from "./views/clients.js";

const ROUTES = {
  "/": { view: home, icon: "reports", label: "Inicio" },
  "/llamadas": { view: calls, icon: "phone", label: "Llamadas" },
  "/clientes": { view: clients, icon: "clients", label: "Clientes" },
  "/configuracion": { view: config, icon: "settings", label: "Configuración" },
};
let timer;
let generation = 0;
let view;
let content;
let title;
let sub;
let status;
let banner;
let clinicName;
const navLinks = new Map();

function route() {
  const [pathname, search = ""] = location.hash.replace(/^#/, "").split("?");
  const [, segment = "", param = ""] = pathname.split("/");
  return { path: ROUTES[`/${segment}`] ? `/${segment}` : "/", param, query: new URLSearchParams(search) };
}

function renderRoute() {
  if (!snapshot || !content) return;
  view?.dispose?.();
  const { path, param, query } = route();
  const current = ROUTES[path];
  title.textContent = current.view.meta.title;
  sub.textContent = current.view.meta.sub;
  document.title = `${current.view.meta.title} · maio`;
  view = current.view.render(param, query);
  mount(content, view);
  content.scrollTop = 0;
  navLinks.forEach((link, key) => link.classList.toggle("is-active", key === path));
  document.body.classList.remove("nav-open");
}

function paintStatus(error) {
  if (!banner) return;
  banner.textContent = error
    ? `Sin actualizar: ${error}. Los datos anteriores no representan el estado en directo.`
    : `Solo lectura · actualizado ${new Date(snapshot.observedAt).toLocaleTimeString("es-ES")} · recibo de API ≠ veredicto del juez`;
  banner.classList.toggle("text-alert", Boolean(error));
  status.textContent = error ? "Estado no actualizado" : snapshot.health
    ? `${snapshot.health.activeCalls} llamadas activas · ${snapshot.health.voiceDeployment}`
    : "Estado del agente no disponible";
  clinicName.textContent = snapshot.clinic?.name ?? "Clínica no disponible";
}

async function poll(currentGeneration) {
  try {
    await refresh();
    if (currentGeneration !== generation) return;
    paintStatus();
    view?.update?.();
  } catch (error) {
    if (currentGeneration !== generation) return;
    if (error.message === "dashboard_unauthorized") { login(); return; }
    paintStatus(error.message);
  }
  timer = setTimeout(() => void poll(currentGeneration), 5_000);
}

function shell() {
  title = el("h1", { class: "topbar__title" });
  sub = el("p", { class: "topbar__sub" });
  status = el("p", {});
  clinicName = el("h4", {});
  banner = el("div", { class: "connection-banner", role: "status" });
  content = el("div", { class: "content", id: "content" });
  navLinks.clear();
  mount(document.getElementById("app"),
    el("div", { class: "app-bg", "aria-hidden": "true" }),
    el("div", { class: "shell" },
      el("aside", { class: "sidebar grain" },
        el("div", { class: "brand" }, icon("maio", "brand__mark"), el("div", { class: "brand__name" }, "maio")),
        el("nav", { class: "nav" }, el("div", { class: "nav__group" },
          el("div", { class: "nav__label" }, "Plataforma"),
          ...Object.entries(ROUTES).map(([path, item]) => {
            const link = el("a", { class: "nav__item", href: `#${path}` }, icon(item.icon), el("span", {}, item.label));
            navLinks.set(path, link);
            return link;
          }))),
        el("div", { class: "sidebar__footer grain" },
          clinicName, status,
          el("a", { class: "pill pill--neutral pill--link", href: "#/llamadas/directo" }, "Ver registros abiertos")),
        el("div", { class: "user-chip" },
          el("span", { class: "user-chip__avatar" }, "OP"),
          el("div", {}, el("div", { class: "user-chip__name" }, "Operador"),
            el("button", { class: "btn btn--sm btn--ghost", onclick: login }, "Desconectar")))),
      el("main", { class: "main" },
        el("header", { class: "topbar" },
          el("button", { class: "btn btn--icon btn--ghost nav-toggle", "aria-label": "Abrir menú",
            onclick: () => document.body.classList.toggle("nav-open") }, icon("menu", "nav__icon")),
          el("div", { class: "topbar__titles" }, title, sub)),
        banner, content),
      el("div", { class: "scrim", onclick: () => document.body.classList.remove("nav-open") })));
  paintStatus();
  renderRoute();
  timer = setTimeout(() => void poll(generation), 5_000);
}

function login() {
  generation += 1;
  clearTimeout(timer);
  view?.dispose?.();
  view = null;
  content = null;
  disconnect();
  const input = el("input", { class: "input", type: "password", name: "dashboard-token",
    autocomplete: "off", required: true, minLength: 32, placeholder: "DASHBOARD_TOKEN" });
  const message = el("p", { class: "text-sm", role: "status" });
  const button = el("button", { class: "btn btn--primary", type: "submit" }, "Conectar");
  const form = el("form", { class: "card access-card", onsubmit: async (event) => {
    event.preventDefault();
    button.disabled = true;
    message.textContent = "Conectando fuentes de datos…";
    try {
      await connect(input.value);
      input.value = "";
      shell();
    } catch (error) {
      message.textContent = `No se pudo conectar: ${error.message}`;
      button.disabled = false;
    }
  } },
  el("div", { class: "brand" }, icon("maio", "brand__mark"), el("h1", { class: "brand__name" }, "maio")),
  el("p", { class: "card__sub" }, "Consola privada de solo lectura. Usa el token del dashboard, nunca una clave de Azure o Prosper."),
  el("label", { class: "field" }, "Token de acceso", input), button, message);
  mount(document.getElementById("app"), el("div", { class: "access" }, form));
}

window.addEventListener("hashchange", renderRoute);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") document.body.classList.remove("nav-open");
});
login();
