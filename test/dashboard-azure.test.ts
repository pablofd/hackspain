import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardAzure, callTraceQuery } from "../src/dashboard/azure.js";
import { dashboardConfig } from "./dashboard-fixtures.js";

const resource = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/test";
const workspace = "22222222-2222-4222-8222-222222222222";

test("Azure metrics use supported names, the deployment filter and FULL aggregation; absent is not zero", async () => {
  const requests: URL[] = [];
  const settings = dashboardConfig("/tmp", { AZURE_MONITOR_RESOURCE_ID: resource });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-monitor-token");
    if (url.pathname.endsWith("/metricDefinitions")) return Response.json({ value: [
      { name: { value: "AudioPromptTokens" }, supportedAggregationTypes: ["Total"], dimensions: [{ value: "ModelDeploymentName" }] },
      { name: { value: "AudioCompletionTokens" }, supportedAggregationTypes: ["Total"], dimensions: [{ value: "ModelDeploymentName" }] },
      { name: { value: "AzureOpenAITimeToResponse" }, supportedAggregationTypes: ["Average"], dimensions: [{ value: "ModelDeploymentName" }] },
    ] });
    assert.equal(url.searchParams.get("interval"), "FULL");
    assert.equal(url.searchParams.get("$filter"), "ModelDeploymentName eq 'synthetic-voice'");
    if (url.searchParams.get("aggregation") === "Total") return Response.json({ value: [
      { name: { value: "AudioPromptTokens" }, timeseries: [{ data: [{ total: 0 }] }] },
      { name: { value: "AudioCompletionTokens" }, timeseries: [{ data: [{}] }] },
    ] });
    return Response.json({ value: [{ name: { value: "AzureOpenAITimeToResponse" }, timeseries: [{ data: [{ average: 125.5 }] }] }] });
  };
  const azure = new DashboardAzure(settings, request, async (scope) => {
    assert.equal(scope, "https://management.azure.com/.default");
    return "test-monitor-token";
  });
  const result = await azure.openAi();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data?.metrics.find((metric) => metric.name === "AudioPromptTokens"),
    { name: "AudioPromptTokens", unit: "tokens", value: 0, status: "ok" });
  assert.equal(result.data?.metrics.find((metric) => metric.name === "AudioCompletionTokens")?.value, null);
  assert.equal(result.data?.metrics.find((metric) => metric.name === "AudioCompletionTokens")?.status, "no_data");
  assert.equal(result.data?.metrics.find((metric) => metric.name === "AzureOpenAIRequests")?.status, "unsupported");
  assert.equal(result.data?.metrics.find((metric) => metric.name === "AzureOpenAITimeToResponse")?.value, 125.5);
  await azure.openAi();
  assert.equal(requests.length, 3);
  assert.equal((await azure.speech()).status, "not_used");
});

test("Monitor permission failures are explicit and never expose upstream messages", async () => {
  const azure = new DashboardAzure(dashboardConfig("/tmp", { AZURE_MONITOR_RESOURCE_ID: resource }),
    async () => new Response("PRIVATE_AZURE_ERROR", { status: 403 }), async () => "test");
  const result = await azure.openAi();
  assert.equal(result.status, "error");
  assert.equal(result.code, "azure_monitor_http_403");
  assert.equal(result.data, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AZURE_ERROR/);
});

test("Foundry traces correlate by operation ID and only return whitelisted metrics", async () => {
  const settings = dashboardConfig("/tmp", { AZURE_MONITOR_WORKSPACE_ID: workspace });
  const request: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, "api.loganalytics.azure.com");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as { query: string; timespan: string };
    assert.equal(body.timespan, "P7D");
    assert.match(body.query, /join kind=inner calls on OperationId/);
    assert.match(body.query, /AppRoleName == "hackspain-cachopo"/);
    assert.doesNotMatch(body.query, /transcript|national_id/);
    return Response.json({ tables: [{
      columns: ["callId", "startedAt", "responseCount", "responseDurationTotalMs", "responseDurationP50Ms",
        "responseDurationP95Ms", "inputTokens", "outputTokens", "inputSamples", "outputSamples", "privateField"]
        .map((name) => ({ name })),
      rows: [["test-call", new Date().toISOString(), 2, 400, 200, 300, 0, 12, 0, 2, "PRIVATE_TRACE"]],
    }] });
  };
  const azure = new DashboardAzure(settings, request, async (scope) => {
    assert.equal(scope, "https://api.loganalytics.io/.default");
    return "test";
  });
  const result = await azure.traces();
  assert.equal(result.status, "ok");
  assert.equal(result.data?.[0]?.inputTokens, null);
  assert.equal(result.data?.[0]?.outputTokens, 12);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TRACE|privateField/);
  assert.match(callTraceQuery('service" | take 999 //'), /AppRoleName == "service\\" \| take 999 \/\/"/);
});

test("a partial Log Analytics result is not presented as complete telemetry", async () => {
  const azure = new DashboardAzure(dashboardConfig("/tmp", { AZURE_MONITOR_WORKSPACE_ID: workspace }),
    async () => Response.json({ tables: [{ columns: [], rows: [] }], error: { code: "PartialError" } }),
    async () => "test");
  const result = await azure.traces();
  assert.equal(result.status, "error");
  assert.equal(result.code, "azure_logs_partial_response");
});

test("separate Speech resource usage never becomes per-call ASR accuracy or sentiment", async () => {
  const azure = new DashboardAzure(dashboardConfig("/tmp", { AZURE_SPEECH_RESOURCE_ID: resource }),
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/metricDefinitions")) return Response.json({ value: [
        { name: { value: "AudioSecondsTranscribed" }, supportedAggregationTypes: ["Total"], dimensions: [] },
      ] });
      assert.equal(url.searchParams.get("$filter"), null);
      return Response.json({ value: [{ name: { value: "AudioSecondsTranscribed" }, timeseries: [{ data: [{ total: 45 }] }] }] });
    }, async () => "test");
  const result = await azure.speech();
  assert.equal(result.status, "ok");
  assert.equal(result.data?.scope, "external_speech_resource_not_voice_agent");
  assert.equal(result.data?.metrics[0]?.value, 45);
  assert.doesNotMatch(JSON.stringify(result), /sentiment|asr_accuracy/);
});
