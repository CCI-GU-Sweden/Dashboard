# CCI Import Dashboard

This is a simple dashboard made to display how much data and files are transiting through the CCI Upload app.

## Why

The CCI Upload app is used at the CCI, University of Gothenburg, to upload microscope images on an Omero server. This app can be found here [link](https://github.com/CCI-GU-Sweden/Omero_GU/tree/test/main), and can convert some Electron Microscope image format to Ome-Tiff, and extract some metadata to automatically tag and annotate images. When doing this, the app will also record usage (anonymously) in a postgreSQL database.

This dashboard read such usage and display simple statistics, such as the number of files imported, the average size and classify these by microscope and time period (Week, Month or Year).

This app is designed to be deployed on OpenShift and to setup some environment variables (connection credential to the postgreSQL).

## How

The backend is split into database, authentication middleware, and route modules. Its API is organized as follows:

- `/api/secure` is used to enter the shared password.
- `/api/summary` returns the Uploads overview plus the latest OMERO fileset count, total storage, and daily billable SEK, with changes from the closest snapshot at least one month earlier.
- `/api/uploads/summary` returns upload statistics for the selected microscope, time period, and data type.
- `/api/uploads/history` returns the chart history for the same upload filters.
- `/api/uploads/scopes` and `/api/uploads/microscopes` return the available upload scopes (currently, a scope identifies a microscope).
- `/api/omero/history` returns total and billable daily storage from `group_storage_snapshot`, in either decimal GB or öre per day. Group histories include zero-valued points on later collector dates when a group no longer has stored data, so deleted data does not leave a stale-looking final value.
- `/api/omero/groups` returns the OMERO groups available in the snapshot history.
- `/api/omero/groups/ranking` returns the top 10, 25, or 50 groups by current billable storage. It can filter the current snapshot by policy type and includes billable/free storage, change from the selected comparison period, billable fileset count, and daily charge.
- `/api/omero/billing` sums the stored daily charge for every group over an inclusive `startDate` / `endDate` range. Results are sorted by bill descending and support top 10, 25, 50, or all rows for CSV export. Fractional GB and fractional SEK are retained, and no minimum invoice threshold is imposed.
- `/api/omero/collector-runs` returns the latest 10, 25, or 50 collector audit records, including status, duration inputs, inventory/change counts, deletion suppression, and errors.
- `/api/omero/summary` returns seven latest-snapshot metrics and their changes from the selected comparison date.
- `/api/omero/filesets` returns a searchable, filterable, sortable page of `public.omero_fileset` rows. It accepts `search`, `group_id`, `status`, `imported`, `size`, `billing`, `page`, `pageSize`, `sort`, and `order` query parameters. `billing` supports policy-derived `billable` and `overdue` filters.
- `/api/omero/filesets/:filesetId` returns expandable detail metadata: OMERO project/dataset locations, first and last collection sightings, uncontained-image and missing-run counts, and source filenames. Stored source `client_path` values are intentionally excluded.
- `GET /api/omero/policies` returns effective-dated storage-policy history. `POST /api/omero/policies` schedules a policy change, inserts its new history row, and closes the preceding period in one transaction.
- `/api/tickets/summary` returns total tickets, active tickets, and distinct tickets resolved during the last 30 days, with rolling comparisons.
- `GET /api/tickets` returns the paginated inventory with name, microscope, message, status, issue/ticket type, priority, assignment, source, chat-state, and date filters. Detail, event-history, and image-metadata routes are under `/api/tickets/:ticketId`.
- `POST /api/tickets` creates a manual ticket (JSON, or multipart with an `images` field). `PATCH /api/tickets/:ticketId` updates status/classification/assignment using its current `version`. Staff names are self-reported with the existing shared login.
- `POST /api/tickets/:ticketId/images` adds PNG/JPEG attachments; `GET /api/tickets/:ticketId/images/:imageId` serves authenticated image content. The limit is five images per ticket, 5 MiB and 20 megapixels per image. Binary content is excluded from inventory and metadata responses.

The frontend opens on an overview of Uploads, OMERO Storage, Tickets, and Compute. Each card opens its own mutually exclusive dashboard view while keeping the shared university header and login control visible. Upload details are loaded only when the Uploads view is opened, and authentication is retained in the current browser tab.

The OMERO Storage view graphs the daily total and billable series. In storage mode, values use decimal GB (`1 GB = 1,000,000,000 bytes`) to match collector billing. In öre mode, Total is the daily charge if all stored bytes were billable at each snapshot's applied rate, while Billable uses the stored `daily_charge_ore` value.

The OMERO data area includes fileset inventory, storage policies, billing, and collector health tabs. Billing provides an inclusive date range, a descending horizontal top-10/25/50 chart, and an all-groups CSV download. The fileset table has expandable details for its current OMERO project/dataset locations plus collector timestamps. Only explicitly allow-listed OMERO metadata is returned; source `client_path` values and server filesystem paths are not exposed.

The dashboard reads these tables through its existing statistics-database `PG*` connection. That PostgreSQL role needs `SELECT` on `public.group_storage_snapshot`, `public.omero_fileset`, and `public.collector_run`, plus `SELECT`, `INSERT`, and `UPDATE` on `public.storage_policy` and sequence usage for `storage_policy_policy_id_seq`. Do not use `omero-stats-reader-secret` here: that credential reads the source OMERO database, while these tables belong to `omerofilestats`.

## Tickets: test deployment and database connection

The test database already contains `microscope_ticket`, `microscope_ticket_event`, and `microscope_ticket_image`. The supplied table descriptions match this implementation. **Do not rerun migration 001 in that database.** Use the verification queries in the [collector setup guide](../Omero-storage-collector/db/MICROSCOPE_TICKETS_SETUP.md) to check the existing `filestats_collector` grants. Full schema and workflow details are in [MICROSCOPE_TICKETS_PROPOSAL.md](MICROSCOPE_TICKETS_PROPOSAL.md).

By default, Tickets reuses the exact same PostgreSQL pool as OMERO Storage: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`. Keep the existing Secret mappings; no ticket-specific environment variables or additional password are required.

Migration 001 grants ticket access to `filestats_collector`. The running test deployment is **`core-omero-test` / `dashboard-test`** and its actual database role was confirmed as **`filestats_dashboard`** on 2026-10-23. An administrator must give that existing role the ticket table/sequence grants in [proposal section 7](MICROSCOPE_TICKETS_PROPOSAL.md#7-updating-postgresql-permissions); granting only `filestats_collector` access does not give the dashboard role access. Apply only the grants, **not the table migration again**, then refresh Tickets. No password change or dashboard restart is needed for these grants.

Alternatively, to deliberately connect only Tickets as `filestats_collector` while keeping another role for uploads/storage, add both optional entries to the dashboard container's existing `env` list:

```yaml
- name: TICKET_PGUSER
  valueFrom:
    secretKeyRef:
      name: filestats-collector-secret
      key: username
- name: TICKET_PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: filestats-collector-secret
      key: password
```

For this optional override, edit the test deployment with `oc -n core-omero-test edit deployment/dashboard-test`, then merge both entries under the dashboard container's `env`. The Secret must exist in the dashboard's namespace. Set both override variables or remove both to use the shared connection; a partial pair reports a configuration error. Insufficient ticket grants are reported independently of uploads/storage.

Build a new dashboard image using the updated Dockerfile (UBI 9 / Node.js 22) and dependencies, deploy it with the existing test-image workflow, then check `oc -n core-omero-test rollout status deployment/dashboard-test`. Local development requires Node.js 22+: run `npm ci` and `npm start` in `backend`. Credentials belong in the process environment, not Git.

The card shows total tickets and active tickets compared with 30 days ago, plus distinct resolutions in the last 30 days compared with the preceding 30 days. Historical active counts use recorded status events; missing older history is labelled incomplete. New manual reports start Open, support optional issue categories/images, and can be resolved or cancelled without a closing note. Reopening requires an explanation and preserves the previous closing information in history.

**Add update** records troubleshooting attempts and follow-ups as append-only history entries, each with a staff name, server timestamp, and up to 2,000 characters. It keeps the original report and earlier notes intact, without changing status or closing details. Use **Edit ticket** for status, assignment, priority, or category changes. A stale update form offers **Reload latest** while preserving its draft. This feature uses the existing event table and grants: no schema change or rerun of the collector SQL migration is needed, including for a fresh production schema. See the proposal for API details and the actual runtime role's required grants.

Multer bounds multipart uploads, and Sharp checks full PNG/JPEG decoding with a 20-megapixel limit. Images are stored as PostgreSQL `bytea`. Configure any route/proxy request limit to allow a five-image multipart request (up to 25 MiB of image bytes plus form overhead; 30 MiB accommodates that request). Browsers fetch image content with the login Bearer header; tokens are not embedded in image links. The current API-wide request rate limit remains in effect.

`TICKET_CHAT_HOSTS` can optionally list trusted HTTPS chat hosts, comma-separated, to enable validated chat links in details. Automatic contact-form/chat integration is separate work in the contact application. The existing shared login is treated as staff access; it does not verify individual staff names.

Run `npm test` in `backend` for validation and existing-route tests. PostgreSQL integration tests are opt-in using `TICKET_TEST_DATABASE_URL` (runtime role) and `TICKET_TEST_ADMIN_URL` (test administrator) against a **dedicated disposable test database**; they create fixture reports and adjust their dates. Do not point them at deployed test or production data.

## Ticket staff and microscope catalogue

Tickets uses [ticket-catalogue.configmap.yaml](ticket-catalogue.configmap.yaml) for microscope, staff-author, assignment, and assigned-staff filter dropdowns. All configured entries are available even before they have tickets. Reporter name/identifier remain free text for people contacting staff. The API validates selections and resolves IDs, exact names, or configured aliases to stable IDs, ignoring case and outer/repeated whitespace. Unknown values are rejected; LSM 880 and LSM 980 are never fuzzy-matched.

The existing `microscope` and `assigned_to` columns store catalogue IDs; staff attribution is `staff-entered: <staff_id>`. The UI displays configured names. Keep IDs stable when renaming entries, never reuse them, and retain entries referenced by older tickets. Staff selection remains self-reported under the shared login. No SQL migration is required. No conversion of older free-text ticket values is included.

Creating the ConfigMap does not mount it into the container. From the repository root, attach it to the existing test deployment using the supplied strategic merge patch, which preserves the image, credentials, probes, and other settings:

```powershell
oc -n core-omero-test apply -f ticket-catalogue.configmap.yaml
oc patch deployment dashboard-test --type=strategic --patch-file ticket-catalogue.deployment-patch.yaml
oc -n core-omero-test rollout status deployment/dashboard-test
```

Deploy a rebuilt dashboard image containing these code/dependency changes using the normal image workflow; the commands above do not build or replace the image. The patch mounts the ConfigMap read-only at `/etc/dashboard/ticket-catalogue`. The backend reads the **inner `catalogue.yaml` file** at `/etc/dashboard/ticket-catalogue/catalogue.yaml`; it does not read the full Kubernetes manifest. For production, apply the ConfigMap in the production namespace and adjust the patch's container name and command's deployment name to match that workload. See [Kubernetes ConfigMap volumes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/#add-configmap-data-to-a-volume).

The validated catalogue is cached after first use. After editing entries, apply the ConfigMap, restart the dashboard, then reload the browser or click Tickets **Refresh**:

```powershell
oc -n core-omero-test apply -f ticket-catalogue.configmap.yaml
oc -n core-omero-test rollout restart deployment/dashboard-test
oc -n core-omero-test rollout status deployment/dashboard-test
```

Missing, malformed, duplicate, or ambiguous configuration reports an actionable error; there is no free-text fallback. Optional `aliases: ["LSM980"]` on an entry allows that exact spelling. Aliases must not collide with another entry's ID, name, or aliases in the same list. `GET /api/tickets/filter-options` returns configured staff/microscope arrays of `{id, name}`. Future contact integrations must follow the same ID convention.

For local development, set `TICKET_CATALOGUE_PATH` to a file containing the inner catalogue YAML (not the ConfigMap manifest). From `backend`, after `npm ci`:

```powershell
$env:TICKET_CATALOGUE_PATH = Join-Path $env:TEMP 'dashboard-ticket-catalogue.yaml'
node -e "const fs = require('fs'); const YAML = require('yaml'); const config = YAML.parse(fs.readFileSync('../ticket-catalogue.configmap.yaml', 'utf8')); fs.writeFileSync(process.env.TICKET_CATALOGUE_PATH, config.data['catalogue.yaml']);"
npm start
```

## Security

Access to the database is done by setting up the correct credentials in OpenShift.  
A shared password is require to allow the backend to connect to the database (password different from the database password).  
A jsonwebtoken (JWT) is monitoring the session with a token. Session duration is set to 1 hour.  
A rate limiter to 100 API calls every 15 min.  

## Deployement

Tag the version from text server. Adjust the sha256 to the desired build (check in the yaml)

´´´text
oc tag core-omero-test/dashboard-test@sha256:... core-omero-prod/dashboard:stable
´´´

Then deploy it in prod

´´´text
oc set image deployment/dashboard `
  dashboard=image-registry.openshift-image-registry.svc:5000/core-omero-prod/dashboard:stable `
  -n core-omero-prod
´´´

and restart the pod to make it update

´´´text
oc rollout status deployment/dashboard -n core-omero-prod
´´´
