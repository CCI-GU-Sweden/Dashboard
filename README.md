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

The ticket backend reuses `PGHOST`, `PGPORT`, and `PGDATABASE` (the existing `omerofilestats` database). Add these entries to the dashboard container's existing `env` list, preserving all current settings:

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

For the test namespace, edit the deployment with `oc -n core-omero-test edit deployment/dashboard`, then merge the entries under the dashboard container's `env`. If the main connection already uses `PGUSER=filestats_collector`, the existing pool can be reused without these two ticket variables. No new PostgreSQL login or password is required. The Secret must exist in the dashboard's namespace. If the ticket connection is missing or its grants are insufficient, the Tickets area reports the configuration error independently of uploads/storage.

Build a new dashboard image using the updated Dockerfile (UBI 9 / Node.js 22) and dependencies, deploy it with the existing test-image workflow, then check `oc -n core-omero-test rollout status deployment/dashboard`. Local development requires Node.js 22+: run `npm ci` and `npm start` in `backend`. Credentials belong in the process environment, not Git.

The card shows total tickets and active tickets compared with 30 days ago, plus distinct resolutions in the last 30 days compared with the preceding 30 days. Historical active counts use recorded status events; missing older history is labelled incomplete. New manual reports start Open, support optional issue categories/images, and can be resolved or cancelled without a closing note. Reopening requires an explanation and preserves the previous closing information in history.

Multer bounds multipart uploads, and Sharp checks full PNG/JPEG decoding with a 20-megapixel limit. Images are stored as PostgreSQL `bytea`. Configure any route/proxy request limit to allow a five-image multipart request (up to 25 MiB of image bytes plus form overhead; 30 MiB accommodates that request). Browsers fetch image content with the login Bearer header; tokens are not embedded in image links. The current API-wide request rate limit remains in effect.

`TICKET_CHAT_HOSTS` can optionally list trusted HTTPS chat hosts, comma-separated, to enable validated chat links in details. Automatic contact-form/chat integration is separate work in the contact application. The existing shared login is treated as staff access; it does not verify individual staff names.

Run `npm test` in `backend` for validation and existing-route tests. PostgreSQL integration tests are opt-in using `TICKET_TEST_DATABASE_URL` (runtime role) and `TICKET_TEST_ADMIN_URL` (test administrator) against a **dedicated disposable test database**; they create fixture reports and adjust their dates. Do not point them at deployed test or production data.

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
