export function voicePlayback(context, codec) {
  const sources = new Set();
  let next = context.currentTime;
  return {
    push(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length !== 160) throw new Error("dashboard_demo_invalid_audio");
      if (context.state !== "running") throw new Error("dashboard_demo_audio_suspended");
      const start = Math.max(context.currentTime + 0.015, next);
      if (start + 0.02 - context.currentTime > 2 || sources.size >= 100) throw new Error("dashboard_demo_playback_backpressure");
      const buffer = context.createBuffer(1, bytes.length, 8000);
      buffer.copyToChannel(codec.decode(bytes), 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => { sources.delete(source); source.disconnect(); };
      source.start(start);
      sources.add(source);
      next = start + buffer.duration;
    },
    clear() {
      for (const source of sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      sources.clear();
      next = context.currentTime;
    },
  };
}
