import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { snapshot, createDemoCall, validTranscriptEntry } from "../data/api.js";
import { createMuLawCodec } from "../lib/voice-codec.js";
import { voicePlayback } from "../lib/voice-playback.js";
import { transcriptPanel } from "./transcript.js";

const messages = {
  NotAllowedError: "Permiso de micrófono denegado. Autorízalo en el navegador para continuar.",
  NotFoundError: "No se ha encontrado un micrófono.",
  NotReadableError: "No se puede abrir el micrófono; comprueba si otra aplicación lo está usando.",
  dashboard_demo_unsupported: "Este navegador necesita HTTPS, micrófono, Web Audio y AudioWorklet.",
  dashboard_demo_busy: "Ya hay una llamada de prueba activa. Espera a que termine.",
  dashboard_demo_disabled: "Las llamadas de prueba no están habilitadas en este servidor.",
  dashboard_demo_connection_failed: "No se pudo conectar la llamada de prueba.",
  dashboard_demo_connection_timeout: "El agente no ha iniciado la llamada a tiempo.",
  dashboard_demo_capture_backpressure: "La conexión no puede enviar el audio a tiempo. La llamada se ha detenido.",
  dashboard_demo_playback_backpressure: "Hay demasiado audio pendiente de reproducción. La llamada se ha detenido.",
  dashboard_unauthorized: "La sesión no está autorizada. Vuelve a conectar el dashboard.",
};
const safeCode = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value)
  ? value : "dashboard_demo_invalid_message";

export function demoCallControl() {
  let current = null;
  let generation = 0;
  let disposed = false;
  let entries = [];
  let limited = false;
  const transcript = transcriptPanel("Transcripción de la llamada fake");
  const status = el("p", { class: "demo-call__status", role: "status" }, "Lista para una prueba de voz.");
  const timer = el("span", { class: "mono" }, "00:00 / 03:00");
  const tools = el("p", { class: "card__sub demo-call__tools" });
  const start = el("button", { class: "btn btn--primary", onclick: () => void begin() }, icon("phone", "nav__icon"), "Iniciar llamada");
  const hangup = el("button", { class: "btn btn--danger", disabled: true, onclick: () => finish("Llamada finalizada.", false) }, "Colgar");
  const dialog = el("dialog", { class: "demo-call-dialog grain", "aria-label": "Llamada fake" },
    el("header", { class: "demo-call__head" },
      icon("maio", "chat-card__logo"), el("div", {},
        el("h2", { class: "card__title" }, "Llamada fake"),
        el("p", { class: "card__sub" }, "Voz real con Azure · prueba no puntuable")),
      el("button", { class: "btn btn--icon btn--ghost ml-auto", "aria-label": "Cerrar llamada fake", onclick: close }, "✕")),
    el("p", { class: "demo-call__notice" },
      "Usa el micrófono para hablar con el agente. Consume Azure de pago. Máximo 3 minutos; no se envían acciones a Prosper ni se modifica el EHR. Evita datos personales reales."),
    el("div", { class: "demo-call__controls row row--wrap" }, start, hangup, timer),
    status, tools, transcript.element);
  const button = el("button", { class: "btn btn--primary btn--sm", hidden: true, onclick: () => {
    if (disposed || !snapshot?.demoCall?.enabled || current) return;
    if (typeof dialog.showModal !== "function") {
      hint.textContent = messages.dashboard_demo_unsupported;
      hint.classList.add("text-alert");
      return;
    }
    dialog.showModal();
    refresh();
  } }, icon("microphone", "nav__icon"), "Llamada fake");
  const hint = el("span", { class: "demo-call__hint", hidden: true }, "Azure de pago · sin envíos");
  const element = el("div", { class: "demo-call-control" }, button, hint, dialog);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });

  function refresh() {
    const enabled = snapshot?.demoCall?.enabled === true;
    const busy = enabled && snapshot.demoCall.activeCalls >= snapshot.demoCall.maxConcurrentCalls;
    button.hidden = hint.hidden = !enabled;
    button.disabled = Boolean(current) || busy;
    button.title = busy ? "Ya hay una llamada de prueba activa" : "Abrir una prueba de voz con micrófono";
    start.disabled = !enabled || Boolean(current) || busy;
    hangup.disabled = !current;
    if (current && !enabled) finish(messages.dashboard_demo_disabled, true);
    else if (!current && busy && dialog.open) status.textContent = messages.dashboard_demo_busy;
  }

  function renderTranscript(state = "ok", error = null) {
    transcript.update({
      key: generation, status: state, error,
      data: { entries, limited, checkedAt: new Date().toISOString() },
    });
  }

  function cleanup(session) {
    session.controller.abort();
    clearTimeout(session.connectTimer);
    clearTimeout(session.durationTimer);
    clearInterval(session.clockTimer);
    session.ready = false;
    if (session.socket) {
      session.socket.onopen = session.socket.onmessage = session.socket.onerror = session.socket.onclose = null;
      if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ event: "stop" }));
      if (session.socket.readyState < WebSocket.CLOSING) session.socket.close(1000);
    }
    for (const track of session.stream?.getTracks() ?? []) { track.onended = null; track.stop(); }
    if (session.worklet) {
      session.worklet.port.postMessage({ event: "stop" });
      session.worklet.port.onmessage = null;
      session.worklet.onprocessorerror = null;
      session.worklet.port.close();
      session.worklet.disconnect();
    }
    session.source?.disconnect();
    session.playback?.clear();
    if (session.context && session.context.state !== "closed") {
      void session.context.close().catch(() => console.warn("dashboard_demo_audio_cleanup_failed"));
    }
  }

  function finish(message, error) {
    const session = current;
    current = null;
    if (session) cleanup(session);
    if (disposed) return;
    status.textContent = message;
    status.classList.toggle("text-alert", error);
    refresh();
  }

  function fail(session, error) {
    if (disposed || current !== session) return;
    const code = safeCode(error?.name === "NotAllowedError" || error?.name === "NotFoundError" || error?.name === "NotReadableError"
      ? error.name : error?.message);
    finish(messages[code] ?? `La llamada se ha detenido: ${code}`, true);
  }

  function close() {
    generation += 1;
    finish("Llamada finalizada.", false);
    if (dialog.open) dialog.close();
  }

  async function begin() {
    if (disposed || current || !snapshot?.demoCall?.enabled) return;
    const session = { controller: new AbortController(), generation: ++generation, ready: false };
    current = session;
    entries = [];
    limited = false;
    tools.textContent = "";
    timer.textContent = "00:00 / 03:00";
    status.classList.remove("text-alert");
    status.textContent = "Solicitando acceso al micrófono…";
    renderTranscript();
    refresh();
    const active = () => !disposed && current === session && session.generation === generation && !session.controller.signal.aborted;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
        throw new Error("dashboard_demo_unsupported");
      }
      session.context = new AudioContext({ latencyHint: "interactive" });
      const microphone = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false,
      }).then((stream) => {
        session.stream = stream;
        if (!active()) stream.getTracks().forEach((track) => track.stop());
      });
      await Promise.all([session.context.resume(), microphone]);
      if (!active()) return;
      await session.context.audioWorklet.addModule(new URL("../lib/voice-capture-worklet.js", import.meta.url));
      if (!active()) return;
      for (const track of session.stream.getAudioTracks()) track.onended = () => fail(session, new Error("dashboard_demo_microphone_ended"));
      session.worklet = new AudioWorkletNode(session.context, "maio-demo-capture", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
      });
      session.worklet.onprocessorerror = () => fail(session, new Error("dashboard_demo_audio_processing_failed"));
      session.source = session.context.createMediaStreamSource(session.stream);
      session.source.connect(session.worklet);
      session.worklet.connect(session.context.destination);
      status.textContent = "Preparando la conexión de voz…";
      const ticket = await createDemoCall(session.controller.signal);
      if (!active()) return;
      const codec = createMuLawCodec(ticket.decodeTable);
      session.playback = voicePlayback(session.context, codec);
      const address = new URL(ticket.websocketPath, location.origin);
      address.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      session.socket = new WebSocket(address, ["maio-demo", ticket.ticket]);
      session.socket.onopen = () => { if (active()) status.textContent = "Conectando con el agente de Azure…"; };
      session.socket.onerror = () => fail(session, new Error("dashboard_demo_connection_failed"));
      session.socket.onclose = () => fail(session, new Error("dashboard_demo_connection_closed"));
      session.connectTimer = setTimeout(() => fail(session, new Error("dashboard_demo_connection_timeout")), 20_000);
      session.worklet.port.onmessage = ({ data }) => {
        if (!active()) return;
        if (data?.event === "error") { fail(session, new Error(safeCode(data.code))); return; }
        if (data?.event !== "frame" || !session.ready) return;
        try {
          if (!(data.samples instanceof Float32Array) || data.samples.length !== 160) throw new Error("dashboard_demo_invalid_audio");
          if (session.socket.readyState !== WebSocket.OPEN) throw new Error("dashboard_demo_connection_closed");
          if (session.socket.bufferedAmount > 16 * 1024) throw new Error("dashboard_demo_capture_backpressure");
          const bytes = codec.encode(data.samples);
          session.socket.send(JSON.stringify({ event: "media", media: { payload: btoa(String.fromCharCode(...bytes)) } }));
        } catch (error) { fail(session, error); }
      };
      session.socket.onmessage = ({ data }) => {
        if (!active()) return;
        try {
          if (typeof data !== "string" || data.length > 128 * 1024) throw new Error("dashboard_demo_invalid_message");
          const message = JSON.parse(data);
          if (!message || typeof message.event !== "string") throw new Error("dashboard_demo_invalid_message");
          switch (message.event) {
            case "ready": {
              if (session.ready || message.callId !== ticket.callId || message.submissionsAllowed !== false || message.maxDurationSeconds !== 180) {
                throw new Error("dashboard_demo_invalid_message");
              }
              clearTimeout(session.connectTimer);
              session.ready = true;
              session.started = Date.now();
              status.textContent = "En conversación · micrófono activo";
              session.worklet.port.postMessage({ event: "start" });
              session.durationTimer = setTimeout(() => {
                if (!active()) return;
                timer.textContent = "03:00 / 03:00";
                finish("Límite de 3 minutos alcanzado.", false);
              }, 180_000);
              session.clockTimer = setInterval(() => {
                if (!active()) return;
                const seconds = Math.min(180, Math.floor((Date.now() - session.started) / 1000));
                timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")} / 03:00`;
              }, 1000);
              break;
            }
            case "media": {
              // Provider greetings can arrive before ready; only microphone input is gated.
              if (typeof message.media?.payload !== "string" ||
                  !/^[A-Za-z0-9+/]{214}==$/.test(message.media.payload)) throw new Error("dashboard_demo_invalid_audio");
              const bytes = Uint8Array.from(atob(message.media.payload), (character) => character.charCodeAt(0));
              session.playback.push(bytes);
              break;
            }
            case "clear":
              session.playback.clear();
              break;
            case "transcript": {
              if (!validTranscriptEntry(message.entry)) throw new Error("dashboard_demo_invalid_message");
              const { speaker, text, timestamp, itemId, partial, startMs, endMs } = message.entry;
              const entry = { speaker, text, timestamp, itemId,
                ...(partial === undefined ? {} : { partial }), ...(startMs === undefined ? {} : { startMs, endMs }) };
              const previous = entries.findIndex((item) => item.itemId === itemId && item.speaker === speaker && item.timestamp === timestamp);
              if (previous < 0) entries.push(entry);
              else entries[previous] = entry;
              while (entries.length > 500 || new TextEncoder().encode(JSON.stringify(entries)).length > 256 * 1024) {
                entries.shift();
                limited = true;
              }
              renderTranscript();
              break;
            }
            case "tool":
              if (!["ok", "error"].includes(message.status)) throw new Error("dashboard_demo_invalid_message");
              tools.textContent = `${safeCode(message.name)} · ${message.status}${message.code ? ` · ${safeCode(message.code)}` : ""} · sin envíos a Prosper`;
              break;
            case "ended":
              finish(`Llamada finalizada · ${safeCode(message.reason)}`, false);
              break;
            case "error":
              fail(session, new Error(safeCode(message.code)));
              break;
            default:
              // Future informational events do not authorize audio or additional actions.
              break;
          }
        } catch (error) {
          fail(session, error instanceof SyntaxError ? new Error("dashboard_demo_invalid_message") : error);
        }
      };
    } catch (error) { fail(session, error); }
  }

  return {
    element, refresh, close,
    dispose() {
      close();
      disposed = true;
      transcript.dispose();
      element.remove();
    },
  };
}
