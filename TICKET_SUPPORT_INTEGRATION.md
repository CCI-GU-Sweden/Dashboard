# Connect the support page to dashboard tickets

The dashboard now accepts two flows from a trusted support-page **backend**. Both visible forms contain only name, microscope, and issue. The selected button supplies the submission kind; the backend supplies a stable submission UUID.

| Button / action | `submission_kind` | Stored ticket type | Initial status | Chat |
| --- | --- | --- | --- | --- |
| Request support | `SUPPORT_REQUEST` | `USER_REQUEST` | `OPEN` | `PENDING`; create chat after saving the ticket. |
| Report to CCI | `USER_REPORT` | `USER_REPORT` | `OPEN` for staff review | `NOT_REQUESTED`; do not create a chat. |

A user report explicitly means the user says they solved the issue. Its creation history records that statement. It does not set a resolution timestamp or count as a staff resolution. Staff can classify, prioritize, assign, add notes, close, or reopen reports in the dashboard. All new submissions use `source = CONTACT_FORM`, `issue_type = NULL`, `priority = NORMAL`, and no assignee. The public form cannot set those staff fields.

## What belongs in each application

```text
Browser form -> existing support backend -> dashboard integration API -> PostgreSQL
                        |
                        +-> existing staff webhook
                        +-> chat provider (support requests only)
```

The support backend keeps its current webhook/chat implementation. This dashboard creates tickets and stores returned chat references; it does not call the webhook or chat provider itself. The existing support-page repository has not been changed here. The dashboard displays saved submissions on refresh.

Never put the database password, shared dashboard password, or integration token in browser JavaScript. The browser posts to its own support backend; that backend authenticates to this API. No new PostgreSQL role/password is required for this integration.

## 1. Database and deployment prerequisites

The existing test database needs **`002_ticket_user_reports.sql`**, which adds `USER_REPORT` to the ticket-type constraint without recreating tables. Follow the beginner guide in the collector repository: [MICROSCOPE_TICKET_INTEGRATION_SETUP.md](../Omero-storage-collector/db/MICROSCOPE_TICKET_INTEGRATION_SETUP.md). Do not rerun 001 in test. A fresh database uses the updated collector migration 001, which already accepts this type. The actual dashboard database role needs its existing ticket/event/sequence grants.

Keep the [catalogue ConfigMap mount](README.md#ticket-staff-and-microscope-catalogue) and existing PostgreSQL environment settings. Build/deploy the updated dashboard image. The service endpoints remain unavailable with `503` until a sufficiently long integration token is configured.

## 2. Create a backend-only service token

Use a different token from the staff dashboard password/JWT secret. The API expects a non-whitespace Bearer token of at least 32 bytes. The following PowerShell example uses Node.js to write 32 random bytes as hexadecimal into a temporary file without printing them. It creates one Secret in the test namespace:

```powershell
$ticketTokenFile = Join-Path $env:TEMP ('ticket-integration-' + [guid]::NewGuid().ToString('N') + '.txt')
$env:TICKET_INTEGRATION_TOKEN_FILE = $ticketTokenFile
node -e "require('fs').writeFileSync(process.env.TICKET_INTEGRATION_TOKEN_FILE, require('crypto').randomBytes(32).toString('hex'));"
if ($LASTEXITCODE -ne 0) { throw 'Token generation failed.' }
oc -n core-omero-test create secret generic ticket-support-integration --from-file="TICKET_INTEGRATION_TOKEN=$ticketTokenFile"
if ($LASTEXITCODE -ne 0) { throw 'Secret creation failed. Resolve the error before continuing.' }
Remove-Item -LiteralPath $ticketTokenFile
Remove-Item Env:TICKET_INTEGRATION_TOKEN_FILE
```

If the Secret already exists, reuse the intended existing Secret rather than generating a different value for each backend. To rotate it later, update the shared Secret through your normal Secret management process and roll out both backends together. Do not commit token files or Secret values to Git.

Map its key into the dashboard container and check the rollout:

```powershell
oc -n core-omero-test set env deployment/dashboard-test --containers=dashboard-test --from=secret/ticket-support-integration
oc -n core-omero-test rollout status deployment/dashboard-test
```

Map that same Secret/key into the **support application's backend container**, replacing these placeholders with its actual deployment/container names:

```powershell
oc -n core-omero-test set env deployment/REPLACE_WITH_SUPPORT_DEPLOYMENT --containers=REPLACE_WITH_SUPPORT_CONTAINER --from=secret/ticket-support-integration
```

This provides `TICKET_INTEGRATION_TOKEN`. The support backend also needs `DASHBOARD_TICKETS_URL`, the full URL of the integration endpoint, for example `https://YOUR_TEST_DASHBOARD_HOST/api/integrations/microscope-tickets`. Use the actual dashboard Route, or its approved internal service URL. Configure network access between the applications. A backend in another namespace needs its own namespaced Secret containing the same intended service token. Never point the production support app at test PostgreSQL or the test dashboard.

## 3. Populate the microscope selector

The support backend can request:

```http
GET /api/integrations/microscope-tickets/microscopes
Authorization: Bearer <integration-token>
```

It returns `{ "microscopes": [{ "id": "lsm_980", "name": "LSM 980" }, ...] }`. Proxy only this list to the browser for its dropdown; staff names and tokens are not included. Submit IDs such as `lsm_980`. Exact configured display names/aliases also resolve, with normalized case/whitespace. Unknown microscopes are rejected rather than guessed. LSM 880 and LSM 980 remain distinct. This service catalogue endpoint does not require the staff login.

## 4. Create either submission

Use the same endpoint for both buttons:

```http
POST /api/integrations/microscope-tickets
Authorization: Bearer <integration-token>
Content-Type: application/json
```

```json
{
  "source_event_id": "20a90e48-42dd-45ac-b0d7-21f023263d26",
  "submission_kind": "SUPPORT_REQUEST",
  "reporter_name": "Alex",
  "microscope": "lsm_980",
  "message": "The acquisition software cannot connect."
}
```

For **Report to CCI**, change only `submission_kind` to `USER_REPORT` and submit the user's issue description. No additional visible fields are needed. The backend maps the existing form's `name` to `reporter_name` and its `issue` to `message`.

These five fields are the entire accepted body. A name (up to 200 characters), a valid microscope, and an issue (up to 20,000 characters) are required. Staff names, priority, classification, source, status, and assignment are not accepted. This initial contact endpoint accepts JSON only; staff can add optional images through the existing dashboard workflow.

A new submission returns `201`:

```json
{
  "ticket_id": "42",
  "source_event_id": "20a90e48-42dd-45ac-b0d7-21f023263d26",
  "submission_kind": "SUPPORT_REQUEST",
  "status": "OPEN",
  "chat_state": "PENDING",
  "chat_required": true,
  "version": 1,
  "created": true
}
```

For user reports, `chat_state` is `NOT_REQUESTED` and `chat_required` is false. Ticket IDs are strings because PostgreSQL uses bigint.

Generate the UUID once per real submission and retain it with the same payload until the outcome is known. Retrying identical normalized data with that UUID returns `200`, the existing ticket's current state, and `created: false`. Reusing the UUID for changed data or a different button action returns `409`. Initial report/history insertion is transactional. Replays never overwrite later staff edits.

The `created` flag is about the database insertion, not confirmation that the webhook or chat already ran. Retain webhook/chat progress in the support backend and use the UUID/ticket ID as its deduplication key. If the chat provider supports idempotency, reuse the same key there. The API cannot guarantee exactly-once delivery to an external webhook/chat service.

## 5. Continue the existing webhook/chat flow

Only after the ticket API confirms the save should the support backend continue its staff notification/chat steps. Include the ticket number in the notification. For user reports, send the appropriate report notification and skip chat creation. For support requests, create/recover the chat when `chat_required` is true.

After a chat opens, record its reference:

```http
PATCH /api/integrations/microscope-tickets/42/chat
Authorization: Bearer <integration-token>
Content-Type: application/json
```

```json
{
  "version": 1,
  "chat_state": "OPEN",
  "chat_thread_id": "provider-conversation-id",
  "chat_url": "https://YOUR_ALLOWED_CHAT_HOST/conversations/provider-conversation-id"
}
```

At least one of `chat_thread_id` or `chat_url` is required for `OPEN`. `chat_url` is optional: if supplied, it must be HTTPS on a hostname configured in the dashboard's comma-separated `TICKET_CHAT_HOSTS`, without URL credentials or token/auth/password/secret query parameters. A thread reference alone works without configuring a link hostname.

If opening the chat fails, retain the ticket and record `{ "version": 1, "chat_state": "FAILED" }` through the same endpoint. Do not insert another ticket. Retry the chat using the same submission identity. Staff can filter pending/failed chats in the dashboard.

Chat callbacks lock the row, update only chat fields plus audit/version metadata, and append a `CHAT_UPDATED` event. They preserve the original report and all staff status/classification/priority decisions. A stale callback returns `409`; fetch the latest receipt with `GET /api/integrations/microscope-tickets/submissions/<source_event_id>` and retry using its version. That endpoint returns no report text or reporter name. An identical callback is idempotent, even if the submitted version is now old. Once a chat is `OPEN`, this integration cannot replace its reference or mark it failed. Chat callbacks for user reports or manual dashboard tickets return `404`.

## 6. Small server-side JavaScript example

Run this in the support **backend**, not in browser JavaScript. `submissionId` must come from the saved submission/retry state, rather than generating a new UUID on every network attempt.

```js
async function ticketApi(path = '', { method = 'GET', body } = {}) {
  const response = await fetch(process.env.DASHBOARD_TICKETS_URL.replace(/\/$/, '') + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.TICKET_INTEGRATION_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'Ticket API request failed');
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  return result;
}

async function saveForm({ submissionId, name, microscope, issue, reportOnly }) {
  return ticketApi('', { method: 'POST', body: {
    source_event_id: submissionId,
    submission_kind: reportOnly ? 'USER_REPORT' : 'SUPPORT_REQUEST',
    reporter_name: name,
    microscope,
    message: issue,
  } });
}
```

Use the returned receipt in the existing backend flow. Do not show “ticket saved” if the call failed. If webhook/chat creation later fails, keep the confirmed ticket number and tell the user which step failed rather than presenting the whole submission as unsaved. Handle a timeout as an uncertain outcome: retry the same UUID/payload or look up its receipt, rather than creating a new identity.

## Errors and access boundaries

`400`: invalid input/JSON; `401`: missing/wrong service token; `404`: unknown submission or ineligible chat target; `409`: UUID payload conflict, stale version, or replacement of an existing chat; `413`: JSON too large; `415`: non-JSON write; `429`: rate limit; `503`: missing token/catalogue/schema/grants; `500`: unexpected save failure. Retry transient failures with the same UUID and backoff, respecting `Retry-After` on `429`. Do not retry invalid input unchanged.

Integration requests have their own limit of 100 authenticated requests per 15 minutes per apparent client IP, separate from staff API limits. Cache the microscope list in the support backend. The service token permits only microscope-list reads, minimal receipt reads, contact submission creation, and eligible chat-reference callbacks. It cannot use staff endpoints, read ticket messages/history/images, or edit staff classification/status. Staff JWTs do not authenticate service routes. Staff writes continue to use their existing login.
