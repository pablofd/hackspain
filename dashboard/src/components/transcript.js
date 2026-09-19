import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";

const clock = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function transcriptPanel(label = "Transcripción de la llamada") {
  const status = el("p", { class: "transcript-status", role: "status", hidden: true });
  const limit = el("p", { class: "transcript-status text-alert", role: "status", hidden: true },
    "Muestra limitada: solo los fragmentos más recientes.");
  const empty = el("p", { class: "empty", hidden: true });
  const scroller = el("div", { class: "chat transcript" }, empty);
  const element = el("section", { class: "transcript-panel", role: "region", "aria-label": label },
    el("div", { class: "transcript-toolbar" },
      el("span", { class: "section-title" }, "Transcripción"),
      el("details", { class: "transcript-note" },
        el("summary", {}, "Sobre este texto"),
        el("p", {}, "Las horas son del registro, no tiempos acústicos exactos. El texto reconocido puede contener errores. El del agente es generado: puede estar interrumpido y no demuestra lo que se oyó."))),
    status, limit, scroller);
  const rows = new Map();
  let selectedKey;
  let disposed = false;
  let layout;

  function row(entry) {
    const speaker = el("span", {});
    const time = el("time", { class: "mono" });
    const text = el("div", { class: "chat__bubble transcript__text", dir: "auto" });
    const partial = el("span", { class: "transcript-partial", hidden: true },
      "Fragmento parcial · puede estar incompleto o interrumpido");
    const detail = el("details", { class: "transcript__detail" },
      el("summary", {}, "Detalle del fragmento"), el("span", {}));
    const node = el("article", { class: `chat__row chat__row--${entry.speaker === "user" ? "caller" : "agent"}` },
      el("span", { class: `chat__avatar${entry.speaker === "assistant" ? " chat__avatar--agent" : ""}`, "aria-hidden": "true" },
        entry.speaker === "assistant" ? icon("maio", "chat__avatar-mark") : "I"),
      el("div", { class: "transcript__message" },
        el("div", { class: "chat__meta" }, speaker, time), text, partial, detail));
    return { node, speaker, time, text, partial, detail };
  }

  function update({ key, status: state = "ok", data = null, error = null, simulated = false }) {
    if (disposed) return;
    cancelAnimationFrame(layout);
    const changed = key !== selectedKey;
    const oldTop = scroller.scrollTop;
    const follow = changed || scroller.scrollHeight - scroller.clientHeight - oldTop <= 40;
    const top = scroller.getBoundingClientRect().top;
    const anchors = follow ? [] : [...rows].flatMap(([id, item]) => {
      const bounds = item.node.getBoundingClientRect();
      return bounds.bottom > top ? [{ id, offset: bounds.top - top }] : [];
    });
    if (changed) {
      for (const item of rows.values()) item.node.remove();
      rows.clear();
      selectedKey = key;
    }
    const entries = data?.entries ?? [];
    const seen = new Map();
    const retained = new Set();
    let next = scroller.firstElementChild;
    for (const entry of entries) {
      const identity = `${entry.timestamp}\0${entry.speaker}\0${entry.itemId}`;
      const count = seen.get(identity) ?? 0;
      seen.set(identity, count + 1);
      const id = `${identity}\0${count}`;
      const item = rows.get(id) ?? row(entry);
      rows.set(id, item);
      retained.add(id);
      const who = entry.speaker === "user" ? "Interlocutor" : "Agente · texto generado";
      item.node.setAttribute("aria-label", who);
      item.speaker.textContent = simulated ? `${who} · demo` : who;
      item.time.dateTime = entry.timestamp;
      item.time.title = entry.timestamp;
      item.time.textContent = clock.format(new Date(entry.timestamp));
      if (item.text.textContent !== entry.text) item.text.textContent = entry.text;
      item.partial.hidden = !entry.partial;
      item.detail.hidden = !entry.partial && entry.startMs === undefined;
      item.node.title = `Ítem: ${entry.itemId}`;
      item.detail.lastChild.textContent = `Ítem: ${entry.itemId}${entry.startMs === undefined
        ? "" : ` · Intervalo del modelo: ${entry.startMs}–${entry.endMs} ms`}`;
      if (item.node !== next) scroller.insertBefore(item.node, next);
      else next = next.nextElementSibling;
    }
    for (const [id, item] of rows) if (!retained.has(id)) { item.node.remove(); rows.delete(id); }
    status.hidden = state === "ok" || state === "idle";
    status.classList.toggle("text-alert", state === "error");
    status.textContent = state === "error"
      ? error === "dashboard_transcript_not_found"
        ? "Registro local no encontrado. No hay transcripción en la muestra reciente."
        : `Error al leer la transcripción: ${error}. ${entries.length ? "Se conserva la última lectura, sin actualizar." : "No se ha reconstruido ningún texto."}`
      : state === "refreshing" ? "Actualizando transcripción…" : "Cargando transcripción…";
    limit.hidden = !data?.limited;
    empty.hidden = Boolean(entries.length) || state !== "ok";
    empty.textContent = "Sin transcripción registrada";
    const restore = () => {
      if (disposed || key !== selectedKey) return;
      if (follow) scroller.scrollTop = scroller.scrollHeight;
      else {
        const anchor = anchors.find(({ id }) => rows.has(id));
        scroller.scrollTop = anchor
          ? scroller.scrollTop + rows.get(anchor.id).node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset
          : Math.min(oldTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      }
    };
    restore();
    if (!element.isConnected) layout = requestAnimationFrame(restore);
  }

  return {
    element, scroller, update,
    dispose() { disposed = true; cancelAnimationFrame(layout); rows.clear(); scroller.replaceChildren(); },
  };
}
