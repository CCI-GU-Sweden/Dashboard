# Microscope ticket inventory: design and implementation proposal

Status: the user confirmed creation of the three tables in the test environment on 23 October 2026. The pasted PostgreSQL table descriptions match the schema in this document, including the 5 MiB image limit. The dashboard implementation now includes the Tickets card, inventory, staff create/update workflows, and image upload/display. Production migration/deployment is not confirmed.

Prepared: 13 October 2026.

Connection and migration plan updated against the local `Omero-storage-collector` repository on 20 October 2026. Resource names below are documented configuration, not a live-cluster inspection.

Implementation and deployed-test-schema alignment updated on 23 October 2026. The schema evidence verifies table definitions, not live Secret mappings or runtime grants. **Do not rerun migration 001 in the test database that already has these tables.**

## Implemented dashboard behavior

The main **🎫 Tickets** card opens `/tickets` and shows three metrics from `/api/tickets/summary`:

| Metric | Definition | Evolution |
| --- | --- | --- |
| Total tickets | Reports opened up to the current instant. | Count and percentage change against the total 30 days ago. |
| Active tickets | Current `OPEN`, `IN_PROGRESS`, or `WAITING` reports. | Compared with status reconstructed at the 30-day cutoff from recorded events, or unchanged older rows. If historical state is missing, show “History incomplete” rather than inventing a comparison. |
| Resolved · last 30 days | Distinct tickets resolved in the trailing 30 days, including tickets subsequently reopened. | Compared with distinct resolutions in the preceding 30 days. Repeated resolutions of the same ticket within one period count once. Legacy rows with a resolution timestamp and no resolution event use that timestamp. |

Zero baselines show the count change without a fabricated percentage. The Tickets summary loads independently of the existing upload/storage summary, so a missing ticket connection does not break those cards.

Implemented files are `backend/ticket-db.js`, `backend/routes/tickets.js`, and `frontend/js/tickets.js`, with navigation/layout changes in `frontend/index.html`, `frontend/js/barplot.js`, and `frontend/css/styles.css`. The API uses parameterized PostgreSQL queries, transactional writes/history, row locks, and ticket versions to reject stale edits. Original reports remain immutable through the staff edit endpoint.

Multer handles bounded multipart uploads: at most five images per ticket, 5,242,880 bytes (5 MiB) per image, with PNG/JPEG signature checks and full pixel decoding through Sharp. Images must be single-frame and at most 20 megapixels. At most two upload requests are processed concurrently per application process. The existing API-wide rate limit also applies; the UI debounces searches and does not poll.

Images remain binary `bytea` values in the deployed five-column image table. Metadata routes exclude binary payloads; a ticket-scoped content endpoint serves image bytes with authentication, private caching, and `nosniff`. The browser fetches with its Bearer header, displays an object URL, and releases the URL when details are closed or the view changes. Initial ticket/images/history are committed together. Later image additions update the ticket version and append metadata to history in one transaction.

The shared login cannot verify individual staff identities. Forms require a self-reported staff name, recorded with a `staff-entered:` prefix. Confirm that the shared dashboard password is limited to staff before enabling staff writes for other audiences. Automatic contact-form ingestion and chat creation remain work in the separate contact application; this implementation creates manual reports with `source = DASHBOARD`.

The container now uses the UBI 9 Node.js 22 image and the project requires Node.js 22 or later. Patched Multer/Sharp releases are recorded in `backend/package-lock.json`; rebuild the image to deploy these dependencies. Keep existing `PG*` connection settings, and map `TICKET_PGUSER` / `TICKET_PGPASSWORD` from `filestats-collector-secret` as described below. If the main pool already connects as `filestats_collector`, it can be reused without extra ticket credential variables.

## 1. Purpose and placement

Add a standalone **🎫 Tickets** main card to the dashboard overview, alongside **Uploads**, **OMERO Storage**, and **Compute**. Clicking it opens a dedicated ticket view at `/tickets`, with the shared university header and login control:

```text
Dashboard overview
  Uploads | OMERO Storage | 🎫 Tickets | Compute

🎫 Tickets → /tickets
  Ticket inventory, filters, creation, status updates, and history
```

Use the ticket emoji **🎫** for the card, with an accessible text label. The broad **Tickets** name leaves room for future facility support and Crosslab integration. Crosslab connectivity is a later extension; this release focuses on microscope reports and staff-entered issues.

The ticket inventory will record user contact-form submissions and issues entered directly by staff. Staff will be able to search the inventory, create internal issues or major incidents, update status, and record resolution details. Each ticket represents one initial report; later chat replies belong to the existing chat system.

Use the existing **`omerofilestats` database on the `filestatistics-pg15` PostgreSQL service**, already used by the dashboard and `Omero-storage-collector`. Add `public.microscope_ticket` to that database and use the existing **`filestats_collector`** login for ticket access. Reuse its password from **`filestats-collector-secret`**; no new ticket database role or password is needed. This requires an additive table migration and grants, with no new database, PostgreSQL service, database pod, or persistent volume. Verify the deployed `PGDATABASE` and service name before applying the migration.

This statistics database is separate from the source OMERO database, `omerodb` on `omero-postgres-server`. `omero-stats-reader-secret` provides read-only access to that source database and is not a ticket credential.

The design adds three tables in the same database: `public.microscope_ticket` for the report, `public.microscope_ticket_event` for its history, and `public.microscope_ticket_image` for optional PNG/JPEG attachments. The history preserves status transitions, particularly when a resolved issue is reopened. Each image references its ticket through `ticket_id`, allowing several images per ticket.

## 2. Existing components and assumptions

The proposal is based on the current repository:

| Component | Existing location | Proposed use |
| --- | --- | --- |
| Existing PostgreSQL pool | `backend/db.js` | Provides the current dashboard connection and shared `PGHOST`, `PGPORT`, and `PGDATABASE` settings. |
| Ticket PostgreSQL pool | `backend/ticket-db.js` | Uses the same host/port/database with `TICKET_PGUSER` / `TICKET_PGPASSWORD` mapped from the existing collector Secret. Ticket routes connect as `filestats_collector`. |
| Express application | `backend/index.js` | Mount a dedicated ticket router. |
| Authentication | `backend/middleware/auth.js` | Protect staff ticket reads and writes. |
| Fileset API | `backend/routes/omero.js` | Reuse its validation, parameterized-query, pagination, and sorting patterns. |
| DataTables interface | `frontend/js/barplot.js` | Reuse the server-side DataTables approach in `initializeFilesetTable()`. |
| Main view switching | `activateView()`, `views`, and `viewPaths` in `frontend/js/barplot.js` | Add a standalone `tickets` view at `/tickets` and load its inventory when opened. |
| Layout and styling | `frontend/index.html`, `frontend/css/styles.css` | Add the 🎫 Tickets overview card, dedicated view, table, filter controls, and creation/status dialogs. |

The contact form and chat-opening code are not present in this repository. Their integration is an additional change in the application that handles the form. The chat provider and live database pod/container names remain deployment inputs. Connection, Secret, and role examples below come from the collector repository; confirm they match each deployed environment.

### Shared database configuration from the collector project

Reviewed sources in `D:\DATA\Simon\GitHub\Omero-storage-collector`:

- [Collector README](../Omero-storage-collector/README.md): connection settings, dashboard role, Secret mappings, and migration conventions.
- [Database setup](../Omero-storage-collector/db/README.md): administrator-run SQL and `oc cp` / `psql` workflow.
- [Collector CronJob](../Omero-storage-collector/k8s/omero-storage-collector.yaml) and [test Job](../Omero-storage-collector/k8s/write-test-job.yaml): statistics/source database separation and runtime Secret references.
- [Fresh-install schema](../Omero-storage-collector/db/schema.sql): existing collector tables. This file is not an upgrade script for an initialized database.

| Setting | Documented configuration | Ticket use |
| --- | --- | --- |
| Test namespace | `core-omero-test` | Validate the migration and dashboard integration here first. |
| Statistics PostgreSQL service | `filestatistics-pg15` | Reuse as dashboard `PGHOST`. |
| Statistics port | `5432` | Reuse as `PGPORT`. |
| Statistics database | `omerofilestats` | Reuse as `PGDATABASE`; add the ticket tables to `public`. |
| PostgreSQL version baseline | PostgreSQL 15 or compatible | Check the deployed version before migration. |
| Existing dashboard role / Secret example | `filestats_dashboard` / `filestatistics-app-credentials` | Existing uploads/storage connection; ticket access uses the collector login below. |
| Ticket and collector role | `filestats_collector` | Reuse this existing role and add ticket-specific grants. |
| Ticket and collector Secret | `filestats-collector-secret` | Reuse its `username` / `password` keys for the ticket backend; no new PostgreSQL password. |
| Source OMERO reader Secret | `omero-stats-reader-secret` | Remains for OMERO extraction only. |

The collector uses `STATS_DB_HOST`, `STATS_DB_PORT`, and `STATS_DB_NAME`; this dashboard uses `PGHOST`, `PGPORT`, and `PGDATABASE`. Their values point to the same statistics service/database. The ticket pool uses those same `PG*` connection settings plus `TICKET_PGUSER` / `TICKET_PGPASSWORD` for the reused collector login. Injecting only `STATS_DB_*` variables into this dashboard would not configure its Node.js pools.

```text
filestatistics-pg15:5432 / omerofilestats / public
  Existing: imports, omero_fileset, storage_policy,
            group_storage_snapshot, collector_run
  Proposed: microscope_ticket, microscope_ticket_event (history),
            microscope_ticket_image (optional PNG/JPEG bytes)

Dashboard uploads/storage → existing PG* pool → existing dashboard login
Dashboard tickets → ticket pool, same database → filestats_collector
Contact backend → same filestats_collector login or authenticated ingestion API
Collector → existing STATS_DB_* connection → filestats_collector
```

The ticket history is the previously proposed companion table in this same database, not a second database. The collector runtime does not create/migrate tables and does not need changes to collect microscope tickets.

The ticket-specific pool keeps this credential change scoped to tickets. The existing dashboard pool continues serving uploads, storage, billing, and health with its current credentials. A second pool is an application connection configuration, not a new PostgreSQL database or role. If the deployed dashboard already uses `filestats_collector` for its main pool, ticket routes can reuse that pool instead.

Assume Kubernetes with OpenShift's `oc` CLI. The resource commonly intended by “SecretMap” is a Kubernetes **Secret**. A **ConfigMap** holds non-secret configuration. Credentials should continue to come from the existing Secret references; the JavaScript frontend must never receive them. See [Kubernetes Secrets](https://kubernetes.io/docs/concepts/configuration/secret/).

## 3. Ticket creation and chat workflow

### User contact form

1. The form collects the user's name, microscope, and initial message, plus an optional **Issue type** selection and optional PNG/JPEG attachments.
2. Its backend validates the submission and assigns a stable submission UUID. Reuse that UUID if the submission is retried.
3. Before launching the chat, the backend inserts a ticket with `source = CONTACT_FORM`, `ticket_type = USER_REQUEST`, `status = OPEN`, and a server-generated opening timestamp.

### Staff-created entries

An **Add ticket** button opens a dialog with:

- Reporter name, defaulting to the staff member's entered name for an internal report.
- Microscope, or “Facility-wide / not specific to one microscope”.
- Type: user request, internal issue, or incident.
- Issue type (optional): software, hardware, connection, access/permissions, acquisition/image quality, or other.
- Priority: low, normal, high, or critical.
- Initial message / issue description.
- Optional PNG/JPEG images, using the same upload limits and validation as the contact form.
- Optional assigned staff name and optional chat reference.

A “big issue” is an `INCIDENT`, usually with `HIGH` or `CRITICAL` priority. Keeping type and priority separate lets staff distinguish an urgent user request from a facility incident.

Staff-created tickets use `source = DASHBOARD`. They start `OPEN` with `chat_state = NOT_REQUESTED` unless staff explicitly request chat creation. Initial manual creation does not need automatic chat opening in the first release.

### Optional issue type in both creation forms

Add a single-select field labelled **Issue type (optional)** to the contact form and staff creation dialog. It describes the subject of the problem, separately from `ticket_type` (user request / internal issue / incident) and `priority` (urgency).

| Display label | Stored `issue_type` value | Examples |
| --- | --- | --- |
| Software | `SOFTWARE` | Application crashes, unexpected errors, or software configuration problems. |
| Hardware | `HARDWARE` | Stage, camera, illumination, controller, or other equipment faults. |
| Connection | `CONNECTION` | Network, remote desktop, instrument connection, or service connectivity failures. |
| Access / permissions | `ACCESS_PERMISSIONS` | Login failures, account access, or permission problems. |
| Acquisition / image quality | `ACQUISITION_IMAGE_QUALITY` | Focus, artifacts, poor signal, or acquisition results that need investigation. |
| Other | `OTHER` | An issue that does not fit the available categories. |

The last three choices are useful additions: access problems need different investigation from a network outage, and users may notice poor images before knowing whether hardware or software is responsible. Keep the list short and let staff refine the classification after investigating.

The initial selection is **Not specified** (an empty option), stored as SQL `NULL`. Users can submit without choosing a type. **Other** is an explicit selection, distinct from an unclassified report. Accept omitted, `null`, or blank values as `NULL`; validate all non-empty values against the list. Existing submissions without this new field remain valid.

Staff may set, change, or clear `issue_type` later without changing the original message. Record those changes in history and apply the same version checks as other staff edits. Do not infer or require a category from the message.

## 4. Status and time rules

| Status | Meaning | Resolution timestamp |
| --- | --- | --- |
| `OPEN` | Report received and awaiting action. | `NULL` |
| `IN_PROGRESS` | Staff are investigating or working on the issue. | `NULL` |
| `WAITING` | Waiting for the user, vendor, spare parts, or another dependency. | `NULL` |
| `RESOLVED` | Issue addressed; an optional closing note can explain the fix or workaround. | Required |
| `CANCELLED` | Duplicate, withdrawn report, or no action required; an optional closing note can explain why. | `NULL`; cancellation and its time are recorded in history. |

All active statuses can move to another active status, `RESOLVED`, or `CANCELLED`. Reopening a resolved or cancelled ticket moves it to `OPEN` or `IN_PROGRESS` and requires an explanation. A direct switch between `RESOLVED` and `CANCELLED` is rejected; reopen first.

The backend enforces these rules:

- `opened_at` is the initial reporting time and never changes during normal edits.
- `created_at` is the time the row entered this database. It differs from `opened_at` only for an explicit historical import.
- Resolving sets `resolved_at` using the database clock. A resolution/closing note is optional for both `RESOLVED` and `CANCELLED`, with a maximum of 2,000 characters.
- Keep the original report separate from the closing note. Store the latter in `resolution_note` for either closing status; an omitted or blank note becomes `NULL`. The limit is a maximum, with no minimum required length.
- Reopening clears `resolved_at` and the current `resolution_note`; the previous resolution or cancellation, its closing time, and any closing note remain in the event history.
- Editing an already resolved ticket's assignment or priority preserves its resolution timestamp.
- Repeating the current status is a no-op for status history. It must not reset resolution time.
- Every effective edit updates `updated_at` and increments `version`.
- A historical import may supply an earlier opening/resolution time through a separate controlled import path. Ordinary clients cannot backdate reports or provide resolution timestamps.

Store all timestamps as `timestamptz`, return ISO 8601 timestamps with an explicit UTC offset, and label the UI display timezone. A proposed facility default is `Europe/Stockholm`, consistent with the existing storage-policy date calculations. A viewer's local timezone could be a later preference. PostgreSQL stores timezone-aware timestamps as instants and converts their display according to timezone settings; see [PostgreSQL date/time types](https://www.postgresql.org/docs/current/datatype-datetime.html).

## 5. Table name, fields, and types

### Primary table: `public.microscope_ticket`

Each row is one report, regardless of whether it originated in the contact form or the dashboard.

| Column | PostgreSQL type | Required / default | Explanation |
| --- | --- | --- | --- |
| `ticket_id` | `bigint`, generated identity | Primary key | Stable ticket number; return as a string in JSON to avoid JavaScript integer precision loss. |
| `reporter_name` | `varchar(200)` | Required | User's name or staff reporter's name. Store it separately from the staff editor. |
| `reporter_identifier` | `varchar(254)` | Optional | Stable user ID or email if the contact app already has it; do not add a mandatory form field. |
| `microscope` | `varchar(150)` | Optional | Canonical microscope name; `NULL` means facility-wide / not applicable. |
| `message` | `text` | Required, 1–20,000 characters | Original report, kept immutable in the normal edit API. |
| `ticket_type` | `varchar(30)` | `USER_REQUEST` | `USER_REQUEST`, `INTERNAL_ISSUE`, or `INCIDENT`. |
| `issue_type` | `varchar(30)` | Optional, `NULL` | Problem category: `SOFTWARE`, `HARDWARE`, `CONNECTION`, `ACCESS_PERMISSIONS`, `ACQUISITION_IMAGE_QUALITY`, or `OTHER`. Independent of `ticket_type`. |
| `priority` | `varchar(10)` | `NORMAL` | `LOW`, `NORMAL`, `HIGH`, or `CRITICAL`. |
| `source` | `varchar(20)` | Required | `CONTACT_FORM` or `DASHBOARD`. |
| `source_event_id` | `varchar(200)` | Optional in SQL; required by create APIs | Stable creation request UUID for retry deduplication. |
| `status` | `varchar(20)` | `OPEN` | Current workflow status. |
| `opened_at` | `timestamptz` | `now()` | Date/time of first report. |
| `resolved_at` | `timestamptz` | Optional | Current resolution time; present only for `RESOLVED`. |
| `resolution_note` | `text` | Optional, maximum 2,000 characters | Closing explanation for `RESOLVED` or `CANCELLED`: fix, workaround, or reason for cancellation. Separate from the original message; blank input is stored as `NULL`. |
| `assigned_to` | `varchar(200)` | Optional | Staff member currently handling the ticket. |
| `chat_thread_id` | `varchar(200)` | Optional | Provider's thread/conversation reference. |
| `chat_url` | `text` | Optional, maximum 2,000 characters | Link to the existing staff conversation; never a login token. |
| `chat_state` | `varchar(20)` | `NOT_REQUESTED` | `NOT_REQUESTED`, `PENDING`, `OPEN`, or `FAILED`. |
| `created_at` | `timestamptz` | `now()` | Database insertion time. |
| `updated_at` | `timestamptz` | `now()` | Most recent edit. |
| `created_by` | `varchar(200)` | Required | Creator label or authenticated identity. |
| `updated_by` | `varchar(200)` | Required | Most recent editor label or authenticated identity. |
| `version` | `integer` | `1` | Optimistic concurrency token for edits. |

Prefer stable microscope identifiers if a shared instrument registry exists. For the first release, reuse the contact form's canonical names and normalize whitespace/case at ingestion. The dashboard's upload microscope list can suggest names, but it is not a complete instrument registry: a microscope with no uploads must still be available. Renaming instruments should not silently split filters; define aliases or migrate names explicitly.

Do not create a foreign key to OMERO filesets, groups, or upload rows: a microscope issue can exist without any image import. The nullable microscope field covers facility-wide incidents. Multiple affected instruments could use a relation table in a future version.

### Recommended history table: `public.microscope_ticket_event`

| Column | Type | Purpose |
| --- | --- | --- |
| `event_id` | `bigint`, generated identity | Event key. |
| `ticket_id` | `bigint` | Foreign key to the ticket. |
| `event_type` | `varchar(30)` | `CREATED`, `STATUS_CHANGED`, `UPDATED`, or `CHAT_UPDATED`. |
| `old_status`, `new_status` | `varchar(20)` | Status before and after the action, when applicable. |
| `note` | `text` | Staff explanation; maximum 2,000 characters. Closing events copy the optional closing note here. |
| `changes` | `jsonb` | Allow-listed old/new values for changed fields, including prior resolution metadata. |
| `actor` | `varchar(200)` | Authenticated identity or explicitly labelled self-reported staff name. |
| `occurred_at` | `timestamptz` | Event time, default `now()`. |

Write events and the ticket mutation in the same transaction. Applications receive no event `UPDATE` or `DELETE` privilege. This is application history, not a tamper-proof audit trail: the table owner and database administrators can still modify it. Avoid copying the initial message into every event.

### Image table: `public.microscope_ticket_image`

| Column | PostgreSQL type | Purpose |
| --- | --- | --- |
| `image_id` | `bigint`, generated identity | Unique image ID; return as a string in JSON. |
| `ticket_id` | `bigint NOT NULL` | Foreign key to `microscope_ticket.ticket_id`, with `ON DELETE RESTRICT`. |
| `filename` | `varchar(255) NOT NULL` | Non-empty display filename; the backend stores a safe basename without a directory path. |
| `extension` | `varchar(4) NOT NULL` | Lowercase `png`, `jpg`, or `jpeg`, without a leading dot. |
| `image_data` | `bytea NOT NULL` | Actual binary image bytes; maximum 5 MiB (5,242,880 bytes). |

One ticket has zero or more image rows. The image table's `ticket_id` is the link; neither the ticket nor the history table needs another image-ID column or a separate association table. API detail responses may expose image IDs through a metadata query, without storing a duplicate list on the ticket.

The migration indexes `(ticket_id, image_id)`, validates the extension and basic PNG/JPEG signature, and rejects empty or oversized image data. `bytea` stores binary data directly; see [PostgreSQL binary types](https://www.postgresql.org/docs/15/datatype-binary.html). The future upload backend must decode and validate the image as well; a signature check alone does not establish that the whole file is a valid image.

Proposed application limits are five optional images per ticket and 5 MiB per image. The byte limit is enforced in SQL; the image-count limit belongs in the backend, checked under a parent-ticket lock. Use the existing `UPDATED` event for attachment metadata (`image_id`, filename, size); do not put image bytes into event JSON. Image records are insert/read only for the runtime role; image removal/replacement needs a separately designed workflow.

## 6. Creating the extra tables

The shared-database migration is maintained with the database setup in `Omero-storage-collector`: [db/migrations/001_microscope_tickets.sql](../Omero-storage-collector/db/migrations/001_microscope_tickets.sql). It combines the following table definitions and the section 7 grants in **one transaction**. There is no separate grants migration or new runtime role to create.

Follow the beginner-oriented [db/MICROSCOPE_TICKETS_SETUP.md](../Omero-storage-collector/db/MICROSCOPE_TICKETS_SETUP.md) for login, pod/container selection, SQL execution, permissions checks, and a test that rolls back its sample rows. The SQL file checks the target database, writable server, existing collector role, and absence of ticket tables before creating them. The user has now applied setup in the test environment and supplied matching `\d` output for all three tables; run only the verification/connection steps there. Use the migration once for a different database that does not already contain these tables.

The image table was included in 001 before the user's test setup. It is present in the supplied test schema, with the PNG/JPEG signature constraint, a 5,242,880-byte maximum, and the ticket foreign key. No further image-table migration is required for that test database. If an older image-free version exists in another environment, retain its data and prepare an additive image-only migration there instead of replaying 001.

Use that migration as the authoritative SQL source. The definitions below explain the design. The existing `db/schema.sql` remains the collector's fresh-install baseline; do not rerun it to add tickets to the live database. A fresh environment that needs tickets should receive the baseline and collector-role setup first, then this additional ticket migration once.

Run it once using the statistics database's owner/migration role. Runtime dashboard credentials should not receive `CREATE TABLE` or schema ownership. Use migration tracking; do not use `CREATE TABLE IF NOT EXISTS` as a substitute for checking an existing schema. PostgreSQL documents identity columns and check constraints in [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html).

```sql
BEGIN;

CREATE TABLE public.microscope_ticket (
    ticket_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reporter_name varchar(200) NOT NULL
        CHECK (char_length(btrim(reporter_name)) > 0),
    reporter_identifier varchar(254),
    microscope varchar(150)
        CHECK (microscope IS NULL OR char_length(btrim(microscope)) > 0),
    message text NOT NULL
        CHECK (char_length(btrim(message)) > 0 AND char_length(message) <= 20000),
    ticket_type varchar(30) NOT NULL DEFAULT 'USER_REQUEST'
        CHECK (ticket_type IN ('USER_REQUEST', 'INTERNAL_ISSUE', 'INCIDENT')),
    issue_type varchar(30)
        CHECK (issue_type IN (
            'SOFTWARE', 'HARDWARE', 'CONNECTION', 'ACCESS_PERMISSIONS',
            'ACQUISITION_IMAGE_QUALITY', 'OTHER'
        )),
    priority varchar(10) NOT NULL DEFAULT 'NORMAL'
        CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
    source varchar(20) NOT NULL
        CHECK (source IN ('CONTACT_FORM', 'DASHBOARD')),
    source_event_id varchar(200)
        CHECK (source_event_id IS NULL OR char_length(btrim(source_event_id)) > 0),
    status varchar(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CANCELLED')),
    opened_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolution_note text CHECK (
        resolution_note IS NULL
        OR (char_length(btrim(resolution_note)) > 0
            AND char_length(resolution_note) <= 2000)
    ),
    assigned_to varchar(200),
    chat_thread_id varchar(200),
    chat_url text CHECK (char_length(chat_url) <= 2000),
    chat_state varchar(20) NOT NULL DEFAULT 'NOT_REQUESTED'
        CHECK (chat_state IN ('NOT_REQUESTED', 'PENDING', 'OPEN', 'FAILED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by varchar(200) NOT NULL CHECK (char_length(btrim(created_by)) > 0),
    updated_by varchar(200) NOT NULL CHECK (char_length(btrim(updated_by)) > 0),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    CONSTRAINT microscope_ticket_source_event_uq UNIQUE (source, source_event_id),
    CONSTRAINT microscope_ticket_resolution_state_ck CHECK (
        (status = 'RESOLVED' AND resolved_at IS NOT NULL)
        OR
        (status <> 'RESOLVED' AND resolved_at IS NULL)
    ),
    CONSTRAINT microscope_ticket_closing_note_state_ck CHECK (
        status IN ('RESOLVED', 'CANCELLED') OR resolution_note IS NULL
    ),
    CONSTRAINT microscope_ticket_resolution_time_ck CHECK (
        resolved_at IS NULL OR resolved_at >= opened_at
    ),
    CONSTRAINT microscope_ticket_update_time_ck CHECK (updated_at >= created_at)
);

CREATE INDEX microscope_ticket_opened_idx
    ON public.microscope_ticket (opened_at DESC, ticket_id DESC);
CREATE INDEX microscope_ticket_status_opened_idx
    ON public.microscope_ticket (status, opened_at DESC, ticket_id DESC);
CREATE INDEX microscope_ticket_microscope_opened_idx
    ON public.microscope_ticket (microscope, opened_at DESC, ticket_id DESC);
CREATE INDEX microscope_ticket_resolved_idx
    ON public.microscope_ticket (resolved_at DESC, ticket_id DESC)
    WHERE resolved_at IS NOT NULL;

CREATE TABLE public.microscope_ticket_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id bigint NOT NULL REFERENCES public.microscope_ticket(ticket_id),
    event_type varchar(30) NOT NULL
        CHECK (event_type IN ('CREATED', 'STATUS_CHANGED', 'UPDATED', 'CHAT_UPDATED')),
    old_status varchar(20)
        CHECK (old_status IN ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CANCELLED')),
    new_status varchar(20)
        CHECK (new_status IN ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CANCELLED')),
    note text CHECK (char_length(note) <= 2000),
    changes jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(changes) = 'object'),
    actor varchar(200) NOT NULL CHECK (char_length(btrim(actor)) > 0),
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX microscope_ticket_event_history_idx
    ON public.microscope_ticket_event (ticket_id, occurred_at, event_id);

CREATE TABLE public.microscope_ticket_image (
    image_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id bigint NOT NULL
        REFERENCES public.microscope_ticket(ticket_id) ON DELETE RESTRICT,
    filename varchar(255) NOT NULL CHECK (char_length(btrim(filename)) > 0),
    extension varchar(4) NOT NULL CHECK (extension IN ('png', 'jpg', 'jpeg')),
    image_data bytea NOT NULL,
    CONSTRAINT microscope_ticket_image_size_ck CHECK (
        octet_length(image_data) BETWEEN 1 AND 5242880
    ),
    CONSTRAINT microscope_ticket_image_signature_ck CHECK (
        (extension = 'png'
            AND substring(image_data FROM 1 FOR 8) = decode('89504e470d0a1a0a', 'hex'))
        OR
        (extension IN ('jpg', 'jpeg')
            AND substring(image_data FROM 1 FOR 3) = decode('ffd8ff', 'hex'))
    )
);

CREATE INDEX microscope_ticket_image_ticket_idx
    ON public.microscope_ticket_image (ticket_id, image_id);

COMMIT;
```

The database checks protect valid states. The backend additionally enforces allowed transitions, immutable opening/original-message fields, editor attribution, and version increments. The defaults do not automatically update `updated_at`: every writer must set it explicitly. If future applications write beyond these two trusted services, introduce database triggers or controlled functions for those invariants.

The unique `(source, source_event_id)` pair deduplicates retries without merging distinct reports that happen to contain the same text. PostgreSQL permits multiple ordinary unique-key rows containing `NULL`; creation APIs therefore require a UUID even though the schema allows legacy rows without one.

### Optional substring-search indexes

For a small inventory, case-insensitive `ILIKE` searches are sufficient. Add trigram indexes once realistic data and query plans justify them. This is a separate optional migration, so lack of extension availability does not prevent the first release:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX microscope_ticket_reporter_trgm_idx
    ON public.microscope_ticket USING gin (reporter_name gin_trgm_ops);
CREATE INDEX microscope_ticket_message_trgm_idx
    ON public.microscope_ticket USING gin (message gin_trgm_ops);
```

The extension must be installed by an authorized database role. GIN trigram indexes can accelerate `LIKE`/`ILIKE` substring searches, though very short search terms can remain expensive. Exact microscope filtering uses the ordinary microscope index. See [PostgreSQL pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html).

## 7. Updating PostgreSQL permissions

Use the existing **`filestats_collector`** role for ticket reads and writes. Keep its existing permissions on collector tables and storage policies. Add only the ticket-table/sequence grants below; do not create another PostgreSQL role or password, change the collector password, or grant schema ownership.

The shared role already has permissions to modify collector inventory, snapshots, and storage policies. A backend using this login has those existing permissions as well as the new ticket permissions. This is the chosen credential-reuse arrangement; ticket routes must still validate input and expose only the intended ticket operations.

The one-time migration already includes these additive grants. It must run as the table/sequence owner or an authorized administrator in the statistics database. The SQL below explains the permissions; do not run a second grant file after applying the migration:

```sql
BEGIN;

GRANT CONNECT ON DATABASE omerofilestats TO filestats_collector;
GRANT USAGE ON SCHEMA public TO filestats_collector;

GRANT SELECT, INSERT ON TABLE public.microscope_ticket TO filestats_collector;
GRANT UPDATE (
    status, resolved_at, resolution_note, priority, assigned_to, issue_type,
    chat_thread_id, chat_url, chat_state, updated_at, updated_by, version
) ON TABLE public.microscope_ticket TO filestats_collector;
GRANT SELECT, INSERT ON TABLE public.microscope_ticket_event TO filestats_collector;
GRANT SELECT, INSERT ON TABLE public.microscope_ticket_image TO filestats_collector;

GRANT USAGE ON SEQUENCE public.microscope_ticket_ticket_id_seq
    TO filestats_collector;
GRANT USAGE ON SEQUENCE public.microscope_ticket_event_event_id_seq
    TO filestats_collector;
GRANT USAGE ON SEQUENCE public.microscope_ticket_image_image_id_seq
    TO filestats_collector;

COMMIT;
```

Verify the generated sequence names with `pg_get_serial_sequence()` after creation. Explicitly scope grants to these new objects; do not broaden permissions on all tables or change existing fileset/policy privileges. Sequence privileges are separate grant targets; see [PostgreSQL GRANT](https://www.postgresql.org/docs/current/sql-grant.html).

The same role can look up duplicate submissions, create tickets/events/images, and update chat references. Column grants protect original report fields during updates. Do not add `DELETE`, `TRUNCATE`, event/image updates, or schema creation rights, and keep table ownership with the administrator/migration account. Check existing role membership and `PUBLIC` grants because additive grants cannot remove privileges already held.

When the contact backend writes directly to PostgreSQL, it also uses `filestats_collector` with the existing collector Secret and must insert the `CREATED` event in the same transaction, applying the same chat/version rules as the dashboard API. Because both backends share one database identity, their application code enforces the distinction between staff status updates and contact/chat updates; PostgreSQL cannot distinguish those applications by role.

Alternatively, submit through a service-authenticated ingestion endpoint owned by the dashboard, keeping the PostgreSQL credentials in that backend. Both approaches use the same existing PostgreSQL login. Choose based on connectivity; never expose the database credentials or staff shared password to contact-form clients.

## 8. API design

Add `backend/routes/tickets.js` and mount it at `/api/tickets` in `backend/index.js`. Its queries use the ticket pool in `backend/ticket-db.js`, connected as `filestats_collector` to the same statistics database. If the existing pool already uses that role, reuse it as described in section 2. This dedicated namespace matches the standalone Tickets area. Add `/tickets` to the application's explicit frontend routes so direct navigation and browser refresh open the ticket view.

| Method and route | Purpose |
| --- | --- |
| `GET /api/tickets` | Paginated, filtered, sorted list with counts. |
| `GET /api/tickets/summary` | Three card metrics and rolling 30-day comparisons; independent of `/api/summary`. |
| `GET /api/tickets/filter-options` | Canonical microscope options and fixed status/ticket-type/issue-type/priority lists. Register before `/:ticketId`. |
| `GET /api/tickets/:ticketId` | Full message, chat reference, and ticket metadata. |
| `GET /api/tickets/:ticketId/events` | Paginated event history. |
| `GET /api/tickets/:ticketId/images` | Image metadata only: IDs, filenames, extensions, and byte lengths. |
| `GET /api/tickets/:ticketId/images/:imageId` | Authenticated binary image content, scoped to the specified ticket. |
| `POST /api/tickets/:ticketId/images` | Validated multipart upload; insert image/history and update ticket version atomically. |
| `POST /api/tickets` | Create a staff-entered ticket; backend forces `source = DASHBOARD`. |
| `PATCH /api/tickets/:ticketId` | Change status, assignment, priority, or optional issue type with concurrency protection. |

Protect all staff endpoints with `authMiddleware`. If service ingestion is chosen, add a separate endpoint such as `POST /api/integrations/microscope-tickets` with separate service authentication, input allow-lists, and rate limiting. Its backend forces `source = CONTACT_FORM`. Do not make contact ingestion a public, unrestricted ticket-write endpoint.

### Create example

```json
{
  "reporter_name": "CCI staff",
  "microscope": "Microscope A",
  "message": "Stage movement fails during acquisition; instrument unavailable.",
  "ticket_type": "INCIDENT",
  "issue_type": "HARDWARE",
  "priority": "CRITICAL",
  "assigned_to": "Staff member",
  "source_event_id": "20a90e48-42dd-45ac-b0d7-21f023263d26",
  "actor_name": "Staff member"
}
```

The server supplies IDs, status, timestamps, source, and creator metadata. A successful creation returns `201` with the ticket. A replay with the same UUID and identical creation payload returns `200` and the existing ticket. Reusing the UUID with a different initial payload returns `409`. Disable the submit button while saving and retain the UUID for a retry.

Both creation paths accept the optional `issue_type` field. Return it in list/detail responses, and include it in creation and subsequent update history. In PATCH requests, omission leaves the category unchanged; an explicit `null` or blank value clears it. A creation retry must not overwrite any later staff classification.

For optional images, use a bounded multipart creation path carrying the same validated fields and image files; keep JSON creation available for reports without files. Configure multipart file/count/body limits and the OpenShift route limits consistently. The current Express JSON parser does not handle multipart uploads. Validate decoded PNG/JPEG content and dimensions, normalize filename/extension, and pass binary buffers as SQL parameters. Insert an initial ticket, its images, and creation history in one short transaction; failure of an image insert must roll back that new submission. Deduplicated creation retries return the existing ticket and attachments rather than appending the initial images again.

For later image uploads, lock the parent ticket, enforce the five-image count limit, insert the image plus an `UPDATED` event containing metadata, and update the ticket version/time in the same transaction. Image-list queries explicitly exclude `image_data`; fetch binary content only through the content endpoint, with the same authorization as ticket details. Return verified `image/png` or `image/jpeg`, safe filename headers, `X-Content-Type-Options: nosniff`, and private caching appropriate to support data. There is no image delete/replace API in the initial version.

Implement replay handling with the unique key and `INSERT ... ON CONFLICT (source, source_event_id) DO NOTHING`, followed by a lookup. Do not use an upsert that overwrites a ticket's current status or original message. Insert a `CREATED` event only when a new ticket was actually created.

### Resolve example

The closing note is optional; omitting `resolution_note` from this request is also valid:

```json
{
  "version": 3,
  "status": "RESOLVED",
  "resolution_note": "Stage controller restarted and test acquisition completed.",
  "actor_name": "Staff member"
}
```

In a short transaction: load the ticket with `SELECT ... FOR UPDATE`, compare the submitted version with the stored version, validate the transition, update it, insert its event, and commit. A stale version returns `409` with an instruction to reload. Return `404` for a missing ticket. The row lock serializes writers while the version check prevents a stale staff dialog from overwriting a newer change.

For resolution or cancellation, accept an optional `resolution_note` (maximum 2,000 characters), store it on the ticket, and copy it into the closing event's `note`. Normalize omitted, empty, or whitespace-only closing notes to `NULL`; never block closing solely because no note was supplied. Accept this field only when closing a ticket. For reopening, require a separate non-empty `change_note` (maximum 2,000 characters) and store it in the event's `note`; preserve the previous closing note in the event's `changes` before clearing it from the ticket. Allow only `version`, `status`, `resolution_note`, `change_note`, `priority`, `assigned_to`, `issue_type`, and the current authentication mode's actor input in the staff PATCH body; reject unexpected fields. Chat metadata changes use the trusted integration path, not a general staff patch.

The contact app's chat-link updates must also lock the ticket, update only chat fields, increment `version`, and create a chat event. They must preserve status, opening time, and resolution details.

Return `400` for invalid filters or input, `401` for an expired/absent login, `403` for denied authorization, `409` for version/idempotency conflicts, and a generic `500` for unexpected failures. Log detailed database errors server-side without names/messages, passwords, or tokens. Database grant failures are deployment problems; expose an actionable staff-safe message rather than raw PostgreSQL diagnostics.

### Current authentication limitation

The existing JWT contains only `{ access: true }`; the shared-password login cannot verify which staff member performed an action or distinguish read access from edit access. For a minimal release, explicitly restrict the shared login to staff and require a self-reported `actor_name`, stored as a labelled value such as `staff-entered: Staff member`. Never treat that name as verified identity.

If the shared login is also used by non-staff, add a separate staff authorization gate before enabling writes. Individual authentication with verified identity and staff role claims is the better long-term model. Keep `API_TOKEN` and `JWT_SECRET` explicitly configured in production rather than relying on the code's fallback values.

## 9. Extensive filtering and search

Perform filtering in PostgreSQL across the complete inventory. Filtering only the currently loaded browser page would give incomplete results.

| Filter | API parameter | Behavior |
| --- | --- | --- |
| Global partial search | `search` | Case-insensitive substring across reporter name, microscope, initial message, and ticket ID. |
| Reporter name | `reporter` | Independent case-insensitive substring search on `reporter_name`. |
| Microscope | Repeated `microscope` | Exact canonical-name selection; OR within the selected microscopes. |
| Facility-wide issues | `facilityWide=true` | Include `microscope IS NULL`; combine with selected microscopes using OR. |
| Message contains | `message` | Independent case-insensitive substring search on the initial message. |
| Status | Repeated `status` | One or more statuses; OR within this filter. |
| Ticket type | Repeated `type` | User requests, internal issues, and/or incidents. |
| Issue type | Repeated `issueType`; `issueTypeUnspecified=true` | Software, hardware, connection, access/permissions, acquisition/image quality, or other. OR within selections; include `issue_type IS NULL` when unspecified is selected. |
| Priority | Repeated `priority` | One or more urgency levels. |
| Source | `source` | Contact form, dashboard, or all. |
| Assigned staff | `assignedTo`, `unassigned` | Partial staff-name match or explicit unassigned selection; reject conflicting values. |
| Date field | `dateField` | `opened_at` (default), `resolved_at`, or `updated_at`. |
| Date interval | `startDate`, `endDate` | Optional inclusive calendar bounds in the labelled facility timezone. |
| Chat state | `chatState` | Especially useful for finding failed/pending chat openings. |
| Ordering | `sort`, `order` | Allow-listed columns; `asc` or `desc`. |
| Pagination | `page`, `pageSize` | Default 50; offer 25/50/100; cap page size at 100. |

Different filter categories combine with **AND**. Multiple choices within a category combine with **OR**. For example: `(OPEN OR IN_PROGRESS) AND Microscope A AND message contains "laser"`.

Default view: active statuses (`OPEN`, `IN_PROGRESS`, `WAITING`), all microscopes, no date restriction, newest opening first. Reset returns to that explicit default. Provide an **All statuses** option to search historical resolutions and cancellations.

Provide opening-date presets such as today, last 7 calendar days, last 30 calendar days, and custom range. Specify that “last 7 calendar days” includes today plus the preceding six dates. Changing the date field preserves custom bounds but makes the selected field visible.

For inclusive date-only bounds, calculate an inclusive lower boundary and an exclusive next-day upper boundary. For example, a single-day opening filter becomes:

```sql
opened_at >= ($1::date::timestamp AT TIME ZONE 'Europe/Stockholm')
AND opened_at < (($2::date + 1)::timestamp AT TIME ZONE 'Europe/Stockholm')
```

This uses midnight boundaries in the facility timezone and handles daylight-saving days without assuming each day lasts 24 hours. If only one date bound is supplied, apply only that bound. Validate real ISO dates and reject reversed intervals. `resolved_at` date filtering naturally excludes unresolved rows.

Bind all user values with `pg` parameters. Build date-field and sort expressions from fixed allow-lists. Escape `%`, `_`, and the escape character when constructing literal substring patterns, so a user's message search is not accidentally interpreted as SQL wildcard syntax. A search limit of 200 characters is reasonable for each partial-search field.

Example request:

```text
GET /api/tickets?status=OPEN&status=IN_PROGRESS&microscope=Microscope%20A&message=laser&dateField=opened_at&startDate=2026-10-01&endDate=2026-10-13&page=1&pageSize=50&sort=opened_at&order=desc
```

Example response shape:

```json
{
  "data": [],
  "page": 1,
  "pageSize": 50,
  "total": 238,
  "filteredTotal": 0,
  "totalPages": 0
}
```

`total` counts tickets within the caller's authorized scope before filters, and `filteredTotal` counts the same scope after filters. Use identical conditions for data and filtered counts. Add `ticket_id` as a stable sort tie-breaker. Priority sorting must use an explicit rank (`CRITICAL`, `HIGH`, `NORMAL`, `LOW`) rather than alphabetical text order. Pagination is adequate for the first release; changing records may shift pages, so use a consistent database snapshot for data/count queries where needed.

## 10. JavaScript table and staff interaction

The overview includes `ticketsCard`, and the separate `ticketsView` contains `ticketTable`. **🎫 Tickets** appears on the card and view heading. `tickets` is registered in `views`, `/tickets` in `viewPaths`, and the card opens `activateView('tickets')`. The isolated `window.ticketDashboard` module handles loading, forms, filters, history, and previews. It reuses the existing visual style and DataTables dependency.

Support direct `/tickets` navigation, browser back/forward, and return to the overview through the shared header. Load the inventory when the Tickets view opens and preserve its filters while switching between main views. The card displays the three statistics defined above. Keep any future Crosslab features within this standalone area, with their integration designed separately.

Suggested visible columns:

| Column | Display |
| --- | --- |
| Expand / ticket ID | Opens full details and history. |
| Opened | Date and time in the labelled facility timezone. |
| Reporter | Original user's or staff reporter's name. |
| Microscope | Canonical name or “Facility-wide”. |
| Ticket type / priority | Clear text badges. |
| Issue type | Category label or “Not specified”. |
| Message | Short plain-text preview; full text in expanded details. |
| Status | Status badge and explicit **Update status** action. |
| Assigned to | Staff name or “Unassigned”. |
| Resolved | Resolution date/time or an em dash. |
| Actions | Update, reopen, and optional **Open chat**. |

Put name, microscope, message, status, and date filters in an always-visible row. Put ticket type, issue type (including “Not specified”), priority, assignment, source, and chat state under **More filters**, with a visible count of active additional filters. Show a readable summary of the current selection and a **Reset filters** button.

Initialize the table with `serverSide: true`. Adapt the API response to DataTables' `draw`, `recordsTotal`, `recordsFiltered`, and `data` shape as the current fileset table does. Reset pagination to page one when filters change. Preserve filters and the current page after edits where possible; if a ticket disappears because it is now resolved under the active-status filter, show “Ticket resolved; hidden by current filters”.

Debounce text searches by roughly 350 ms, cancel obsolete requests or ignore older responses, and refresh on Tickets view opening or an explicit **Refresh** action. Avoid aggressive polling: the current backend limits `/api` to 100 requests per 15 minutes, shared across dashboard operations.

Expanded details show the complete original message, chat reference/state, opening and resolution timestamps, assignment, and paginated event history. Show the closing note beside the closing date: `resolved_at` for resolution, or the cancellation event's `occurred_at` for cancellation. If no note was supplied, display “No closing note provided”.

Include an optional image selector in creation forms and an attachment area in expanded details. Load metadata first, then fetch image bytes as needed for previews/downloads. The current login uses a Bearer token: fetch binary content with that header and display a browser object URL, revoking it when finished. A plain `<img src>` request does not automatically include the existing Bearer header, and access tokens must not be placed in image URLs.

The update dialog displays the current version. For resolution or cancellation, show a textarea labelled **Resolution / closing note (optional)** with `maxlength="2000"`, a character counter, and help text such as “What was fixed, any workaround, or why this ticket is being closed.” Staff can save without a note. Reopening still requires its separate explanation. Do not apply a successful-looking status change before the API confirms the save.

Use text rendering (`DataTable.render.text()` / `textContent`) for names, messages, and notes. Do not inject user text as HTML. Validate chat links against configured HTTPS provider hosts; reject arbitrary schemes and token-bearing links. External chat links use `rel="noopener noreferrer"` when opened in a new tab.

Maintain a keyboard-operable overview card with an accessible text label for its emoji, labelled filter controls, keyboard-operable dialogs, visible save/error feedback, and focus restoration when dialogs close. Empty filtered results should explain that no tickets match and provide a reset action. Authentication expiry should preserve unsaved dialog content while the user logs in again.

## 11. Kubernetes / OpenShift deployment and migration

### Reuse the existing application connection

The backend already reads `PG*` environment variables. Start by confirming the existing service, workloads, and Secret references without printing Secret data:

```powershell
oc project core-omero-test
oc get service filestatistics-pg15
oc get deployment dashboard -o jsonpath='{.spec.template.spec.containers[*].envFrom}'
oc get deployment dashboard -o jsonpath='{.spec.template.spec.containers[*].env[*].valueFrom}'
oc describe secret filestats-collector-secret
oc get cronjob omero-storage-collector -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[*].env[*].valueFrom}'
```

Use the actual namespace and deployment name. Keep the deployment's existing `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` mappings. Add these explicit mappings for ticket access to the dashboard container's existing `env` list:

```yaml
env:
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

Expected non-secret connection values are `PGHOST=filestatistics-pg15`, `PGPORT=5432`, and `PGDATABASE=omerofilestats`; the collector Secret's `username` should identify `filestats_collector`. Preserve working host/port/database references if they already come from a Secret, ConfigMap, or explicit environment settings. A separate non-secret ConfigMap can provide `TICKET_DISPLAY_TIMEZONE=Europe/Stockholm`.

The implemented `backend/ticket-db.js` reads `host`, `port`, and `database` from `PGHOST`, `PGPORT`, and `PGDATABASE`, and `user` / `password` from `TICKET_PGUSER` / `TICKET_PGPASSWORD`. Both ticket credential variables are required when using its dedicated pool. If both are absent and `PGUSER=filestats_collector`, it reuses `backend/db.js`; it never falls back to an unrelated main-pool login. Database connections retain the existing `pg`/PostgreSQL client TLS configuration rather than disabling TLS for the new pool.

The existing collector maps `filestats-collector-secret`'s same `username` and `password` keys to `STATS_DB_USER` / `STATS_DB_PASSWORD`. The ticket backend reuses those credential values through Node.js-specific environment names. Use explicit `secretKeyRef` mappings rather than `envFrom`, since keys named `username` / `password` would not configure either Node.js pool by themselves. No new ticket database Secret or PostgreSQL password is required in this namespace.

For a directly connected contact backend, reference this same Secret and map its keys into the connection variable names that backend expects. It also connects as `filestats_collector` to the same statistics database. With service-authenticated API ingestion, the contact backend needs an integration credential instead of database credentials. Neither path uses the source OMERO reader Secret.

Secrets are namespace-scoped. In the same namespace, the short service name `filestatistics-pg15` resolves to the existing database service. For an application in another namespace, use the actual service DNS name, such as `filestatistics-pg15.core-omero-test.svc` for the documented test namespace, arrange allowed network access, and provision that application's Secret in its own namespace. Use production database/Secret values for production; do not point production tickets at the test database.

Updating database grants alone does not require changing the Secret or restarting the collector. Adding the proposed ticket environment mappings and application code requires a dashboard rollout. If the collector password is rotated later, all backends sharing these credentials must pick up the change; environment-injected Secret values require new pods. Do not give owner credentials to the running dashboard to make migration convenient.

### Apply the migration using the collector's administrator workflow

Follow the collector's established approach: copy a reviewed SQL migration into the existing statistics PostgreSQL pod and execute it as an authorized administrator against `omerofilestats`. Do not execute the collector's entire fresh-install `db/schema.sql` on this initialized database.

The creation commands in this subsection and the optional Job subsection are reference instructions for a database that does not yet have these tables. The user's test database already has them: skip creation there and use the verification/connection steps.

The complete beginner walkthrough is [the collector's ticket setup guide](../Omero-storage-collector/db/MICROSCOPE_TICKETS_SETUP.md). For the short version, run from the collector checkout:

```powershell
Set-Location 'D:\DATA\Simon\GitHub\Omero-storage-collector'
oc project core-omero-test
oc get pods
```

Identify the actual pod serving `filestatistics-pg15` and its PostgreSQL container. The pod name is not the service name. Set `$statisticsPod` to that inspected pod name and `$statisticsContainer` to its PostgreSQL container name, then:

```powershell
oc cp .\db\migrations\001_microscope_tickets.sql "${statisticsPod}:/tmp/001_microscope_tickets.sql" -c $statisticsContainer
oc exec -it $statisticsPod -c $statisticsContainer -- psql -X -U postgres -d omerofilestats -v ON_ERROR_STOP=1 -f /tmp/001_microscope_tickets.sql
if ($LASTEXITCODE -ne 0) { throw 'Ticket migration failed. Read the error before continuing.' }
```

`postgres` is the administrator account used in the collector's database README. Substitute the authorized migration account if the deployed cluster uses another one. Use the existing approved authentication method; enter any requested password interactively. The single SQL file creates tables and grants permissions together, and checks that `filestats_collector` already exists. There is no new runtime role to provision.

This workflow needs no new migration Secret when existing authorized administrator access is available. Record which migration was applied and to which environment. Do not give these administrator credentials to the dashboard or collector runtime.

### Alternative: a one-time migration Job

For a repeatable deployment pipeline, a dedicated migration Job can connect to the same existing statistics database. Use a PostgreSQL client image approved for the cluster. A separate migration Secret is needed only for this execution method if one is not already available. `statistics-postgres-migration` below is a **proposed** Secret with `username` / `password` keys for an authorized migration account; it is not a resource found in the collector manifests.

The manual setup guide is the first-release execution path. If a Job-based pipeline is desired later, the same single SQL migration can be mounted through a ConfigMap. From the collector repository:

```powershell
oc create configmap microscope-ticket-migration-v1 `
  --from-file=001_microscope_tickets.sql=db/migrations/001_microscope_tickets.sql `
  --dry-run=client -o yaml | oc apply -f -
```

Example Job manifest, to save as a future `k8s/microscope-ticket-migration-v1.yaml` in the collector repository. Replace the image placeholder with an approved PostgreSQL-client image pinned to a digest, and confirm the database host and migration credential reference:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: microscope-ticket-migration-v1
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migration
          image: APPROVED_POSTGRES_CLIENT_IMAGE_BY_DIGEST
          command: ["psql"]
          args:
            - "-X"
            - "-v"
            - "ON_ERROR_STOP=1"
            - "-f"
            - "/migration/001_microscope_tickets.sql"
          env:
            - name: PGHOST
              value: filestatistics-pg15
            - name: PGPORT
              value: "5432"
            - name: PGDATABASE
              value: omerofilestats
            - name: PGUSER
              valueFrom:
                secretKeyRef:
                  name: statistics-postgres-migration
                  key: username
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: statistics-postgres-migration
                  key: password
          volumeMounts:
            - name: migration-sql
              mountPath: /migration
              readOnly: true
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
      volumes:
        - name: migration-sql
          configMap:
            name: microscope-ticket-migration-v1
```

The client image must work under the namespace's OpenShift security constraints and have network access to the existing PostgreSQL service. Preserve the database's existing TLS requirements, using appropriate client settings/certificate mounts; do not introduce weaker connection settings.

`psql -X` ignores startup customization and `ON_ERROR_STOP=1` stops on SQL errors. The single SQL file uses an explicit transaction encompassing both DDL and grants, so a failure before commit rolls back both. Its existing-table check prevents blind repeat execution. If connection loss leaves commit status uncertain, inspect tables and grants before deciding what to run. Use `backoffLimit: 0` for this manual one-time Job and record migration application state. See [psql](https://www.postgresql.org/docs/current/app-psql.html) and [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/).

Apply and inspect:

```powershell
oc apply -f k8s/microscope-ticket-migration-v1.yaml
oc wait --for=condition=complete job/microscope-ticket-migration-v1 --timeout=120s
oc logs job/microscope-ticket-migration-v1
```

If the wait expires or the Job fails, inspect its status and logs before taking further action. Do not automatically drop tables or rerun the migration. For SQL checks below, connect from an approved database/client pod with the intended runtime `PG*` settings, for example `oc exec -it <client-pod> -- psql -X`; do not put passwords in command arguments.

### Verify permissions and rollout order

```sql
SELECT current_database(), current_user;
SELECT pg_get_serial_sequence('public.microscope_ticket', 'ticket_id');
SELECT pg_get_serial_sequence('public.microscope_ticket_event', 'event_id');
SELECT pg_get_serial_sequence('public.microscope_ticket_image', 'image_id');
SELECT has_table_privilege(current_user, 'public.microscope_ticket', 'SELECT');
SELECT has_table_privilege(current_user, 'public.microscope_ticket', 'INSERT');
SELECT has_column_privilege(current_user, 'public.microscope_ticket', 'status', 'UPDATE');
SELECT has_sequence_privilege(
    current_user, 'public.microscope_ticket_ticket_id_seq', 'USAGE'
);
```

Run these checks through the ticket connection and confirm `current_user = 'filestats_collector'` and `current_database() = 'omerofilestats'`. If the contact backend connects directly, verify that it uses this same role. Confirm ticket reads/inserts, status/category/chat updates, and event inserts are permitted, while original-message updates, event updates, and destructive ticket operations are denied. With shared credentials, limiting contact/chat operations is an application responsibility, not a difference in PostgreSQL grants. Check event sequence usage as well. Perform a disposable write/update test in the test environment; roll back its transaction or retain it as clearly labelled test data.

Recommended rollout sequence:

1. Confirm that the dashboard's `PG*` settings and the collector's `STATS_DB_*` settings target the same intended statistics service/database. Verify the ticket credential mappings reuse `filestats-collector-secret` and identify `filestats_collector`. Check database version, microscope vocabulary, and chat provider behavior.
2. In the already-initialized test database, verify the three tables, role grants, and connection mapping without rerunning 001. Apply the collector-repository migration only to another database that has not received it, once per database.
3. Deploy the dashboard ticket API and UI, initially with integration disabled.
4. Deploy the contact-form integration and exercise submission, chat failure, retry, and resolution flows.
5. Repeat migration/grants in the production namespace against the production statistics database, using production resource names and credentials.
6. Deploy the reviewed dashboard/contact-app images using the repository's existing image-promotion process.
7. Observe ticket creation, errors, response times, and staff edits; verify the OMERO fileset and storage-policy features still work.

Schema-first deployment is additive: old dashboard versions can continue using their existing tables. If application rollout fails, revert the application image and disable contact ingestion while retaining the new tables and ticket data. Export/backup reports before any deliberate cleanup; an application rollback must not delete submitted issues.

## 12. Privacy, scope, and later extensions

User names, free-form messages, and uploaded screenshots are identifiable support data, unlike the dashboard's anonymous upload statistics. Limit inventory/image access to appropriate staff, avoid logging report bodies or image bytes, and agree on retention with the facility. Store optional PNG/JPEG uploads only in the dedicated image table; do not copy chat transcripts or image bytes into ticket/event fields. The reporter identifier remains optional. Stored images increase database size and backup/restore volume; at the proposed limits, each ticket may hold up to 25 MiB of image bytes plus overhead.

CSV export can be added later using the same server-side filters, with a bounded or streamed result and spreadsheet-formula escaping. Summary counts, median time to resolution, incident counts by microscope, notifications, external attachment storage for larger volumes, and multi-microscope incidents are later extensions. Any resolution-duration report must define how reopened tickets are counted; the event history enables that calculation.

Keeping original report text immutable is useful for support history. If correction or anonymization becomes necessary, provide a specific controlled workflow rather than a general “edit any field” endpoint.

## 13. Implementation checklist and acceptance criteria

The work spans the shared statistics database, the database-management files in `Omero-storage-collector`, this dashboard, and the contact-form application.

| Work area | Deliverable |
| --- | --- |
| Database / collector repository | `db/migrations/001_microscope_tickets.sql` includes ticket/history/image tables, indexes, and collector-role grants in one transaction; `db/MICROSCOPE_TICKETS_SETUP.md` provides the beginner guide and image smoke test. Apply once to existing `omerofilestats` and record completion. No collector-runtime changes are required. |
| Backend | `backend/routes/tickets.js`, mount in `backend/index.js`, and ticket pool wired to `filestats_collector` using the existing collector Secret. Validated queries, transactional writes/history, version conflicts, and staff access enforcement. |
| Frontend | Standalone 🎫 Tickets overview card and `/tickets` view, server-side DataTable, full filter controls, create/update dialogs, history, and safe chat links. |
| Contact app | Stable submission UUID, ticket persistence, chat-reference storage, retry handling, and integration authentication or the reused `filestats_collector` credentials for direct database ingestion. |
| OpenShift | Reuse `filestatistics-pg15` and `filestats-collector-secret`; add the ticket credential mappings to the dashboard. No new ticket PostgreSQL role or password. Use existing administrator access or an optional migration Job with separate administrative credentials, then stage deployment. |
| Documentation | API/permission additions to README and an operator migration/recovery procedure. |

Before enabling production ingestion, verify these meaningful behaviors:

- Ticket queries connect to the intended `omerofilestats` database as `filestats_collector`, reusing `filestats-collector-secret`. The existing uploads/storage connection continues working, and no new ticket PostgreSQL login or password is introduced.
- The 🎫 Tickets main card opens its own view; direct `/tickets` navigation, refresh, back/forward, and return to the overview work.
- One contact submission creates one ticket with the correct name, microscope, initial message, and server opening time.
- A ticket accepts zero or more optional PNG/JPEG images. Each image links to an existing ticket; invalid formats, mismatched signatures, empty files, and files over 5 MiB are rejected. The backend also verifies decoding/dimensions and enforces the five-image limit under a ticket lock.
- The runtime role can insert/read images and allocate image IDs but cannot mutate/delete/truncate them. The image FK prevents orphan rows, and an invalid initial image insert rolls back its new ticket submission.
- Image metadata responses omit binary data. Image content requires ticket authorization, checks the ticket/image pairing, and displays using the Bearer-authenticated preview flow.
- Both creation forms accept a listed issue type or no selection. Missing/blank types become `NULL`, “Other” remains distinct, and unknown values are rejected.
- Staff can reclassify or clear the issue type with version protection and a history event. Issue-type filters, including “Not specified”, work across the full inventory.
- A retry creates no second ticket or second creation event; UUID reuse with altered data is rejected.
- A chat failure leaves a searchable ticket and a visible failed/pending state; retry links the existing ticket.
- Staff can create an internal issue and a critical incident without any corresponding upload/fileset.
- Resolution and cancellation succeed with or without a closing note. Resolution records its timestamp, and cancellation records its closing time in the event history.
- Closing notes up to 2,000 characters are accepted, longer notes are rejected, and blank notes become `NULL`. The original report remains unchanged.
- Reopening clears the current closing note and resolution timestamp while preserving the previous closing status, time, and optional note in history.
- Two staff editing the same version cannot silently overwrite each other; the second save receives a conflict.
- Contact-app chat updates cannot overwrite staff status changes.
- Name, microscope, literal partial-message, date, and multi-status filters work across all database rows and combine as documented.
- Date filters include the complete selected local day, including daylight-saving transitions; unresolved rows do not match resolution-date intervals.
- Malicious HTML in a message displays as text, unsupported chat URLs are rejected, and SQL-like input is handled as data.
- Unauthenticated requests fail; non-staff cannot write if the dashboard is available to a broader audience.
- Role tests verify permitted inserts/updates and denied destructive/original-message/event-history mutations.
- Existing fileset inventory, policy editing, billing, and health views continue working.

The current dashboard implementation provides the card, inventory, staff create/update flows, filtering, history, and image upload/display against the supplied test schema. Configure the ticket database credentials and deploy the rebuilt container to exercise it in that environment. Automatic contact-form persistence/chat integration remains separate application work, along with any later individual staff authentication or Crosslab integration.
