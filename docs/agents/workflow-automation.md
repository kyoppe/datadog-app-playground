# Workflow Automation

Use this when a backend function needs to trigger a Datadog Workflow Automation workflow and poll for the result.

## Requirements

- Use a backend function, not frontend code. Backend functions can call `@datadog/action-catalog`.
- Use the generic HTTP action from `@datadog/action-catalog/http/http`.
- The HTTP action requires a Connection ID for an HTTP connection configured in your Datadog org. Find or create one at `/actions/connections` on your Datadog site (for example `https://app.datadoghq.com/actions/connections`).
- The target workflow must be published and must include an API trigger (`apiTrigger` in the workflow spec).
- Workflow inputs must match the workflow input schema exactly.

## Inspect the workflow first

Before wiring an app to a workflow, confirm its published shape:

```bash
workflow_id="<WORKFLOW_ID>"
api_base="https://api.datadoghq.com" # must match the app's site; see the table below
curl -sS --fail-with-body \
  "${api_base}/api/v2/workflows/${workflow_id}" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  -H "Accept: application/json" \
| jq "{
    id: .data.id,
    name: .data.attributes.name,
    published: .data.attributes.published,
    inputSchema: .data.attributes.spec.inputSchema,
    outputSchema: .data.attributes.spec.outputSchema,
    hasApiTrigger: any(.data.attributes.spec.triggers[]?; has(\"apiTrigger\"))
  }"
```

Confirm `published` is `true`, `hasApiTrigger` is `true`, and `inputSchema.parameters` matches the inputs the app will send.

## Trigger and poll pattern

Inputs go under `meta.payload`. Replace `YOUR_HTTP_CONNECTION_ID` with the ID from your Datadog org.

The API base URL must match the app's Datadog site, or the request fails with `We do not currently support requests to the given base url`. The example derives it from `datadogSite` in `datadog-app.config.json`, which defaults to US1 when unset:

| `datadogSite` | API base URL |
| --- | --- |
| unset or `datadoghq.com` (US1) | `https://api.datadoghq.com` |
| Other production sites, such as `datadoghq.eu` or `us3.datadoghq.com` | `https://api.<datadogSite>` |
| A custom org subdomain, such as `acme.datadoghq.com` | The API URL of the site it's on, such as `https://api.datadoghq.com` |

Custom subdomains of US3, US5, AP1, AP2 and UK1 orgs are on `datadoghq.com`, so the host doesn't show the org's datacenter. Such an org sets `datadogSite` to its datacenter site (for example `us3.datadoghq.com`).

```ts
// src/workflow.backend.ts
import { request } from '@datadog/action-catalog/http/http';

import datadogAppConfig from '../datadog-app.config.json';

const DATADOG_SITES = [
    'datadoghq.com',
    'us3.datadoghq.com',
    'us5.datadoghq.com',
    'datadoghq.eu',
    'ddog-gov.com',
    'us2.ddog-gov.com',
    'ap1.datadoghq.com',
    'ap2.datadoghq.com',
    'uk1.datadoghq.com',
];

function datadogApiBaseUrl(value: string) {
    // Accepts the forms the CLI accepts, such as https://Acme.datadoghq.com/.
    const site = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0] ?? '';
    // A custom org subdomain, such as acme.datadoghq.com, is not part of the API host.
    const matches = DATADOG_SITES.filter((known) => site === known || site.endsWith(`.${known}`));
    const datacenter = matches.sort((a, b) => b.length - a.length)[0] ?? site;
    return `https://api.${datacenter}`;
}

const DATADOG_HTTP_CONNECTION_ID = '<YOUR_HTTP_CONNECTION_ID>';
const DATADOG_API_BASE_URL = datadogApiBaseUrl(
    (datadogAppConfig as { datadogSite?: string }).datadogSite ?? 'datadoghq.com',
);
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
const INITIAL_POLL_DELAY_MS = 250;
const POLL_DELAY_MULTIPLIER = 1.05;

const jsonHeaders = [
    { key: 'Accept', value: ['application/json'] },
    { key: 'Content-Type', value: ['application/json'] },
];

type WorkflowInstanceResponse = {
    data?: {
        id?: string;
        attributes?: {
            endTimestamp?: string | null;
            outputs?: unknown;
            instanceStatus?: { detailsKind?: string; displayName?: string };
        };
    };
};

type WorkflowRunResult = {
    instanceId?: string;
    statusKind?: string;
    displayStatus?: string;
    outputs?: unknown;
    body: unknown;
};

function workflowInstancesUrl(workflowId: string) {
    return `${DATADOG_API_BASE_URL}/api/v2/workflows/${workflowId}/instances`;
}

function isRunningStatus(statusKind?: string) {
    return !statusKind || statusKind === 'IN_PROGRESS';
}

function toRunResult(body: unknown): WorkflowRunResult {
    const response = body as WorkflowInstanceResponse | undefined;
    return {
        instanceId: response?.data?.id,
        statusKind: response?.data?.attributes?.instanceStatus?.detailsKind,
        displayStatus: response?.data?.attributes?.instanceStatus?.displayName,
        outputs: response?.data?.attributes?.outputs,
        body,
    };
}

export async function triggerWorkflow(
    workflowId: string,
    payload: Record<string, unknown>,
): Promise<WorkflowRunResult> {
    const response = await request({
        connectionId: DATADOG_HTTP_CONNECTION_ID,
        inputs: {
            verb: 'POST',
            url: workflowInstancesUrl(workflowId),
            requestHeaders: jsonHeaders,
            responseParsing: 'json',
            errorOnStatus: ['400-599'],
            body: JSON.stringify({ meta: { payload } }),
        },
    });
    return toRunResult(response.body);
}

export async function pollWorkflowInstance(
    workflowId: string,
    instanceId: string,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<WorkflowRunResult> {
    const expiresAt = Date.now() + timeoutMs;
    let delay = INITIAL_POLL_DELAY_MS / POLL_DELAY_MULTIPLIER;

    while (Date.now() < expiresAt) {
        delay *= POLL_DELAY_MULTIPLIER;
        const jitter = delay * 0.4 * (Math.random() - 0.5);
        await new Promise<void>((resolve) => setTimeout(resolve, delay + jitter));

        const response = await request({
            connectionId: DATADOG_HTTP_CONNECTION_ID,
            inputs: {
                verb: 'GET',
                url: `${workflowInstancesUrl(workflowId)}/${instanceId}`,
                requestHeaders: jsonHeaders,
                responseParsing: 'json',
                errorOnStatus: ['400-403', '405-599'],
            },
        });

        // A just-started instance can return 404 INSTANCE_NOT_FOUND until it is queryable.
        if (response.status === 404) {
            continue;
        }

        const result = toRunResult(response.body);
        if (!isRunningStatus(result.statusKind)) {
            return result;
        }
    }

    throw new Error(`Workflow instance ${instanceId} did not finish in time`);
}
```

Status kinds are uppercase. Treat `statusKind === "SUCCEEDED"` as success. All other terminal statuses (`INSTANCE_ERROR`, `STEP_ERROR`, `CANCELED`) are failures — return the full response body so the caller can inspect `errorDetail` and partial outputs.

## Troubleshooting

- `input parameter not in workflow input schema`: update `meta.payload` keys to match `inputSchema.parameters`.
- `Expected trigger type TRIGGER_TYPE_API not found`: add and publish an API trigger on the workflow.
- `We do not currently support requests to the given base url`: the API base URL doesn't match the app's site; see the table in [Trigger and poll pattern](#trigger-and-poll-pattern).
- 401/403: confirm `DD_API_KEY` and `DD_APP_KEY` are set with Actions API Access, and the app site matches the API host.
