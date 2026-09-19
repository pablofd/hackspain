import assert from "node:assert/strict";
import { test } from "node:test";
import { ngrokOptions } from "../scripts/tunnel-ngrok.js";

test("ngrok requires its own token without printing configuration values", () => {
  assert.throws(() => ngrokOptions({}), /Configure NGROK_AUTHTOKEN/);
  assert.throws(() => ngrokOptions({ NGROK_AUTHTOKEN: "secret with spaces" }), (error: unknown) =>
    error instanceof Error && !error.message.includes("secret with spaces"));
});

test("ngrok forwards to the local agent without passing clinic or Azure secrets", () => {
  const options = ngrokOptions({
    NGROK_AUTHTOKEN: "synthetic-ngrok-token", NGROK_URL: "", PORT: "7861", PATH: "/usr/bin",
    PROSPER_API_KEY: "private-clinic-key", AZURE_OPENAI_API_KEY: "private-azure-key",
    VOICE_ENDPOINT_TOKEN: "private-endpoint-token", AI_GATEWAY_API_KEY: "unused-gateway-key",
  });
  assert.equal(options.port, 7861);
  assert.ok(options.args.includes("http://127.0.0.1:7861"));
  assert.ok(options.args.includes("--inspect=false"));
  assert.ok(!options.args.includes("--url"));
  assert.ok(!options.args.join(" ").includes("synthetic-ngrok-token"));
  assert.deepEqual(options.env, { PATH: "/usr/bin", NGROK_AUTHTOKEN: "synthetic-ngrok-token" });
});

test("ngrok accepts an assigned HTTPS origin and rejects unsafe or malformed endpoints", () => {
  const options = ngrokOptions({
    NGROK_AUTHTOKEN: "synthetic-token", NGROK_URL: "https://example.ngrok-free.app",
  });
  assert.equal(options.port, 7860);
  assert.deepEqual(options.args.slice(-2), ["--url", "https://example.ngrok-free.app"]);
  for (const url of ["http://example.test", "https://user:pass@example.test", "https://example.test/ws", "https://example.test?token=secret"]) {
    assert.throws(() => ngrokOptions({ NGROK_AUTHTOKEN: "synthetic-token", NGROK_URL: url }));
  }
  assert.throws(() => ngrokOptions({ NGROK_AUTHTOKEN: "synthetic-token", PORT: "0" }));
  assert.throws(() => ngrokOptions({ NGROK_AUTHTOKEN: "synthetic-token", PORT: "65536" }));
});
