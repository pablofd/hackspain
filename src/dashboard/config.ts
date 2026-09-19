import { resolve } from "node:path";
import { z } from "zod";
import { parseConfig, readEnvironment, type Config } from "../config.js";
import { AppError } from "../errors.js";

const optional = (schema: z.ZodString) => z.preprocess((value) => value === "" ? undefined : value, schema.optional());
const resourceId = z.string().regex(
  /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[A-Za-z0-9_-]+$/i,
);
const settings = z.object({
  DASHBOARD_HOST: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().min(0).max(65535).default(4321),
  DASHBOARD_TOKEN: z.string().min(32).max(256).regex(/^\S+$/),
  DASHBOARD_VOICE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === "/" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  }).default("http://127.0.0.1:7860"),
  DASHBOARD_RECORDS_DIR: z.string().min(1).default(".local/calls"),
  DASHBOARD_HISTORY_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  AZURE_MONITOR_RESOURCE_ID: optional(resourceId),
  AZURE_MONITOR_WORKSPACE_ID: optional(z.string().uuid()),
  AZURE_SPEECH_RESOURCE_ID: optional(resourceId),
});

export type DashboardConfig = z.infer<typeof settings> & { voice: Config };

export function parseDashboardConfig(environment: NodeJS.ProcessEnv, directory = process.cwd()): DashboardConfig {
  const parsed = settings.safeParse(environment);
  if (!parsed.success) {
    throw new AppError("dashboard_invalid_configuration",
      `Check configuration fields: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ")}`);
  }
  const voice = parseConfig(environment);
  if ([voice.VOICE_ENDPOINT_TOKEN, voice.PROSPER_API_KEY, voice.AZURE_OPENAI_API_KEY]
    .includes(parsed.data.DASHBOARD_TOKEN)) {
    throw new AppError("dashboard_token_must_be_separate");
  }
  return {
    ...parsed.data,
    DASHBOARD_RECORDS_DIR: resolve(directory, parsed.data.DASHBOARD_RECORDS_DIR),
    voice,
  };
}

export function loadDashboardConfig(): DashboardConfig {
  const directory = resolve(process.env.DASHBOARD_ENV_DIR ?? process.cwd());
  return parseDashboardConfig(readEnvironment(directory), directory);
}
