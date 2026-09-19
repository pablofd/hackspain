import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { AppError } from "./errors.js";

const optionalValue = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const httpsOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === "/";
});

const configSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(7860),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(20).default(20),
  VOICE_CONNECTOR: z.enum(["realtime", "live"]).default("realtime"),
  AZURE_OPENAI_ENDPOINT: httpsOrigin.refine((value) =>
    new URL(value).hostname.endsWith(".openai.azure.com")),
  AZURE_OPENAI_DEPLOYMENT: z.string().min(1).default("gpt-realtime-1.5"),
  AZURE_OPENAI_API_VERSION: z.string().min(1).default("2024-10-01-preview"),
  AZURE_OPENAI_VOICE: z.string().min(1).default("coral"),
  AZURE_OPENAI_TRANSCRIPTION_MODEL: z.string().min(1).default("whisper-1"),
  AZURE_OPENAI_LIVE_DEPLOYMENT: z.string().min(1).default("gpt-live-1"),
  AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT: z.string().min(1).default("gpt-5.4-mini"),
  AZURE_OPENAI_LIVE_VOICE: z.string().min(1).default("coral"),
  AZURE_OPENAI_API_KEY: optionalValue,
  AZURE_CLIENT_ID: optionalValue,
  PROSPER_API_BASE_URL: httpsOrigin.default("https://hackspain.getprosperapp.com"),
  PROSPER_API_KEY: z.string().min(1),
  VOICE_ENDPOINT_TOKEN: z.string().min(32).regex(/^\S+$/),
  VOICE_OUTPUT_GAIN_DB: z.coerce.number().min(0).max(12).default(0),
  VOICE_LIVE_OUTPUT_GAIN_DB: z.coerce.number().min(0).max(12).default(0),
  APPLICATIONINSIGHTS_CONNECTION_STRING: optionalValue,
  OTEL_SERVICE_NAME: z.string().min(1).default("hackspain-cachopo"),
  CALL_RECORDING_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  CALL_AUDIO_RECORDING_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CALL_RECORDING_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
}).refine((value) => !value.CALL_AUDIO_RECORDING_ENABLED || value.CALL_RECORDING_ENABLED, {
  path: ["CALL_AUDIO_RECORDING_ENABLED"],
  message: "Audio recording requires CALL_RECORDING_ENABLED=true.",
});

export type Config = z.infer<typeof configSchema>;

export function readEnvironment(
  directory = process.cwd(),
  shell: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const read = (filename: string): Record<string, string> => {
    const path = join(directory, filename);
    if (!existsSync(path)) return {};
    return Object.fromEntries(
      Object.entries(parseEnv(readFileSync(path, "utf8")))
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  };
  const lang = read(".env.lang");
  const local = read(".env.local");
  const azure = Object.fromEntries(
    Object.entries(lang).filter(([name]) => name.startsWith("AZURE_OPENAI_")),
  );
  const definedShell = Object.fromEntries(
    Object.entries(shell).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const overrides = { ...local, ...definedShell };
  if (overrides.AZURE_OPENAI_ENDPOINT && azure.AZURE_OPENAI_ENDPOINT) {
    try {
      if (new URL(overrides.AZURE_OPENAI_ENDPOINT).origin !== new URL(azure.AZURE_OPENAI_ENDPOINT).origin) {
        delete azure.AZURE_OPENAI_API_KEY;
      }
    } catch {
      throw new AppError("invalid_configuration", "Check configuration fields: AZURE_OPENAI_ENDPOINT");
    }
  }
  return { ...azure, ...overrides };
}

export function parseConfig(environment: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new AppError("invalid_configuration", `Check configuration fields: ${fields.join(", ")}`);
  }
  return result.data;
}

export function loadConfig(): Config {
  return parseConfig(readEnvironment());
}
