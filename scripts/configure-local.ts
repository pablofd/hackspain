import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readEnvironment } from "../src/config.js";
import { AppError } from "../src/errors.js";

try {
  const { values } = parseArgs({ options: {
    endpoint: { type: "string" }, "record-audio": { type: "boolean" }, "output-gain-db": { type: "string" },
  } });
  const outputGain = values["output-gain-db"] === undefined ? undefined : Number(values["output-gain-db"]);
  if (outputGain !== undefined && (!Number.isFinite(outputGain) || outputGain < 0 || outputGain > 12)) {
    throw new AppError("invalid_output_gain", "Output gain must be between 0 and 12 dB.");
  }
  const environment = readEnvironment();
  const endpoint = values.endpoint ?? environment.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) throw new AppError("missing_endpoint", "Use --endpoint https://your-resource.openai.azure.com or configure .env.lang.");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".openai.azure.com") ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new AppError("invalid_endpoint");
  }
  let contents = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
  const updated: string[] = [];
  const set = (name: string, value: string) => {
    const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, "m");
    const line = `${name}=${JSON.stringify(value)}`;
    contents = pattern.test(contents)
      ? contents.replace(pattern, () => line)
      : `${contents}${contents.endsWith("\n") || !contents ? "" : "\n"}${line}\n`;
    updated.push(name);
  };
  if (values.endpoint || !environment.AZURE_OPENAI_ENDPOINT) set("AZURE_OPENAI_ENDPOINT", url.origin);
  if (!environment.VOICE_ENDPOINT_TOKEN) set("VOICE_ENDPOINT_TOKEN", randomBytes(32).toString("base64url"));
  if (values["record-audio"]) {
    set("CALL_RECORDING_ENABLED", "true");
    set("CALL_AUDIO_RECORDING_ENABLED", "true");
  }
  if (outputGain !== undefined) set("VOICE_OUTPUT_GAIN_DB", String(outputGain));
  writeFileSync(".env.local", contents, { mode: 0o600 });
  chmodSync(".env.local", 0o600);
  if (existsSync(".env.lang")) chmodSync(".env.lang", 0o600);
  console.log(JSON.stringify({ configured: true, updated, values: "not displayed" }));
} catch (error) {
  console.error(error instanceof AppError ? error.message : "Configuration failed; values are not displayed.");
  process.exitCode = 1;
}
