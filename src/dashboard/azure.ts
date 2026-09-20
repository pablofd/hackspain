import { DefaultAzureCredential } from "@azure/identity";
import { z } from "zod";
import { AppError } from "../errors.js";
import { idSchema } from "../prosper-types.js";
import type { DashboardConfig } from "./config.js";
import { cached, observe, requestJson, unavailable } from "./source.js";

const definitionsSchema = z.object({ value: z.array(z.object({
  name: z.object({ value: z.string() }),
  supportedAggregationTypes: z.array(z.string()),
  dimensions: z.array(z.object({ value: z.string() })).optional(),
})).max(1000) });
const metricsSchema = z.object({ value: z.array(z.object({
  name: z.object({ value: z.string() }),
  errorCode: z.string().optional(),
  timeseries: z.array(z.object({ data: z.array(z.object({
    total: z.number().finite().nonnegative().nullish(),
    average: z.number().finite().nonnegative().nullish(),
  })).max(1) })).max(1),
})).max(20) });
const logResponseSchema = z.object({
  tables: z.array(z.object({
    columns: z.array(z.object({ name: z.string() })),
    rows: z.array(z.array(z.unknown())).max(200),
  })).min(1),
  error: z.unknown().optional(),
});
const traceSchema = z.object({
  callId: idSchema,
  startedAt: z.iso.datetime({ offset: true }),
  responseCount: z.number().int().positive(),
  responseDurationTotalMs: z.number().nonnegative(),
  responseDurationP50Ms: z.number().nonnegative(),
  responseDurationP95Ms: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  inputSamples: z.number().int().nonnegative(),
  outputSamples: z.number().int().nonnegative(),
});
export type CallTrace = z.infer<typeof traceSchema>;

export interface CloudMetric {
  name: string;
  unit: string;
  value: number | null;
  status: "ok" | "no_data" | "unsupported" | "error";
}

const openAiMetrics = [
  ["AzureOpenAIRequests", "requests", "Total"],
  ["ProcessedPromptTokens", "tokens", "Total"],
  ["GeneratedTokens", "tokens", "Total"],
  ["AudioPromptTokens", "tokens", "Total"],
  ["AudioCompletionTokens", "tokens", "Total"],
  ["RealtimeUsageTime", "seconds", "Total"],
  ["AzureOpenAITimeToResponse", "ms", "Average"],
] as const;
const speechMetrics = [
  ["AudioSecondsTranscribed", "seconds", "Total"],
  ["SynthesizedCharacters", "characters", "Total"],
  ["Latency", "ms", "Average"],
] as const;
type MetricSpec = readonly (readonly [string, string, "Total" | "Average"])[];

export function callTraceQuery(service: string): string {
  return `let spans = union AppRequests, AppDependencies
| where AppRoleName == ${JSON.stringify(service)};
let calls = spans
| where Name == "invoke_agent cachopo"
| extend callId = tostring(Properties["prosper.call_id"])
| where isnotempty(callId)
| summarize arg_max(TimeGenerated, callId) by OperationId
| project OperationId, callId, startedAt = TimeGenerated;
spans
| where Name == "chat"
| extend input = tolong(Properties["gen_ai.usage.input_tokens"]), output = tolong(Properties["gen_ai.usage.output_tokens"])
| summarize responseCount = count(), responseDurationTotalMs = sum(DurationMs),
    responseDurationP50Ms = percentile(DurationMs, 50), responseDurationP95Ms = percentile(DurationMs, 95),
    inputTokens = sum(input), outputTokens = sum(output),
    inputSamples = countif(isnotnull(input)), outputSamples = countif(isnotnull(output)) by OperationId
| join kind=inner calls on OperationId
| project callId, startedAt, responseCount, responseDurationTotalMs,
    responseDurationP50Ms, responseDurationP95Ms, inputTokens, outputTokens, inputSamples, outputSamples
| order by startedAt desc
| take 200`;
}

export class DashboardAzure {
  private credential: DefaultAzureCredential | undefined;

  constructor(
    private readonly config: DashboardConfig,
    private readonly request: typeof fetch = fetch,
    private readonly token: (scope: string, signal: AbortSignal) => Promise<string> = async (scope, signal) => {
      this.credential ??= new DefaultAzureCredential(
        config.voice.AZURE_CLIENT_ID ? { managedIdentityClientId: config.voice.AZURE_CLIENT_ID } : {},
      );
      try {
        const result = await this.credential.getToken(scope, { abortSignal: signal });
        if (!result) throw new AppError("azure_monitor_authentication_failed");
        return result.token;
      } catch { throw new AppError("azure_monitor_authentication_failed"); }
    },
  ) {}

  readonly openAi = cached(60_000, () => this.config.AZURE_MONITOR_RESOURCE_ID
    ? observe("azure_monitor", () => this.metrics(
      this.config.AZURE_MONITOR_RESOURCE_ID!, openAiMetrics,
      this.config.voice.VOICE_CONNECTOR === "live"
        ? this.config.voice.AZURE_OPENAI_LIVE_DEPLOYMENT : this.config.voice.AZURE_OPENAI_DEPLOYMENT,
    ))
    : Promise.resolve(unavailable<Awaited<ReturnType<DashboardAzure["metrics"]>>>(
      "not_configured", "azure_monitor_resource_not_configured")));

  readonly speech = cached(60_000, () => this.config.AZURE_SPEECH_RESOURCE_ID
    ? observe("azure_speech", () => this.metrics(this.config.AZURE_SPEECH_RESOURCE_ID!, speechMetrics))
    : Promise.resolve(unavailable<Awaited<ReturnType<DashboardAzure["metrics"]>>>(
      "not_used", "voice_agent_does_not_use_azure_speech")));

  readonly traces = cached(60_000, () => this.config.AZURE_MONITOR_WORKSPACE_ID
    ? observe("foundry_traces", () => this.readTraces())
    : Promise.resolve(unavailable<CallTrace[]>("not_configured", "azure_monitor_workspace_not_configured")));

  private async metrics(resource: string, specs: MetricSpec, deployment?: string) {
    const signal = AbortSignal.timeout(10_000);
    const authorization = await this.token("https://management.azure.com/.default", signal);
    const base = `https://management.azure.com${resource}/providers/Microsoft.Insights/`;
    const definitions = await requestJson(this.request, new URL(`${base}metricDefinitions?api-version=2018-01-01`),
      definitionsSchema, "azure_monitor", { Authorization: `Bearer ${authorization}` }, signal);
    const end = new Date();
    const start = new Date(end.getTime() - this.config.DASHBOARD_HISTORY_DAYS * 86_400_000);
    const metrics: CloudMetric[] = specs.map(([name, unit, aggregation]) => {
      const definition = definitions.value.find((entry) => entry.name.value === name);
      const supported = definition?.supportedAggregationTypes.includes(aggregation) &&
        (!deployment || definition.dimensions?.some((dimension) => dimension.value === "ModelDeploymentName"));
      return { name, unit, value: null, status: supported ? "no_data" : "unsupported" };
    });
    for (const aggregation of ["Total", "Average"] as const) {
      const names = specs.filter(([name, , kind]) => kind === aggregation &&
        metrics.find((metric) => metric.name === name)?.status !== "unsupported").map(([name]) => name);
      if (!names.length) continue;
      const url = new URL(`${base}metrics`);
      url.search = new URLSearchParams({
        "api-version": "2023-10-01", metricnames: names.join(","), aggregation,
        interval: "FULL", timespan: `${start.toISOString()}/${end.toISOString()}`,
        ...(deployment ? { "$filter": `ModelDeploymentName eq '${deployment.replaceAll("'", "''")}'` } : {}),
      }).toString();
      const result = await requestJson(this.request, url, metricsSchema, "azure_monitor",
        { Authorization: `Bearer ${authorization}` }, signal);
      for (const name of names) {
        const metric = metrics.find((entry) => entry.name === name)!;
        const data = result.value.find((entry) => entry.name.value === name);
        if (!data || (data.errorCode && data.errorCode !== "Success")) {
          metric.status = "error";
          continue;
        }
        const point = data.timeseries[0]?.data[0];
        const value = aggregation === "Total" ? point?.total : point?.average;
        if (value != null) { metric.value = value; metric.status = "ok"; }
      }
    }
    return {
      start: start.toISOString(), end: end.toISOString(), deployment: deployment ?? null,
      scope: deployment ? "deployment_not_call" : "external_speech_resource_not_voice_agent", metrics,
    };
  }

  private async readTraces(): Promise<CallTrace[]> {
    const signal = AbortSignal.timeout(10_000);
    const authorization = await this.token("https://api.loganalytics.io/.default", signal);
    const url = new URL(`https://api.loganalytics.azure.com/v1/workspaces/${this.config.AZURE_MONITOR_WORKSPACE_ID}/query`);
    const result = await requestJson(this.request, url, logResponseSchema, "azure_logs",
      { Authorization: `Bearer ${authorization}` }, signal, {
        query: callTraceQuery(this.config.voice.OTEL_SERVICE_NAME),
        timespan: `P${this.config.DASHBOARD_HISTORY_DAYS}D`,
      });
    if (result.error !== undefined) throw new AppError("azure_logs_partial_response");
    const table = result.tables[0]!;
    return table.rows.map((row) => {
      if (row.length !== table.columns.length) throw new AppError("azure_logs_invalid_response");
      const value = Object.fromEntries(table.columns.map((column, index) => [column.name, row[index]]));
      const parsed = traceSchema.safeParse(value);
      if (!parsed.success) throw new AppError("azure_logs_invalid_response");
      return {
        ...parsed.data,
        inputTokens: parsed.data.inputSamples ? parsed.data.inputTokens : null,
        outputTokens: parsed.data.outputSamples ? parsed.data.outputTokens : null,
      };
    });
  }
}
