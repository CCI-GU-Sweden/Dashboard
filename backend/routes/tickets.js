const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const { createHash } = require('crypto');
const { authMiddleware } = require('../middleware/auth');
const { getTicketPool } = require('../ticket-db');
const { getTicketCatalogue } = require('../ticket-catalogue');

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CANCELLED'];
const ACTIVE = STATUSES.slice(0, 3);
const TYPES = ['USER_REQUEST', 'USER_REPORT', 'INTERNAL_ISSUE', 'INCIDENT'];
const ISSUES = ['SOFTWARE', 'HARDWARE', 'CONNECTION', 'ACCESS_PERMISSIONS', 'ACQUISITION_IMAGE_QUALITY', 'OTHER'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;
const TIMEZONE = 'Europe/Stockholm';
const COLUMNS = `ticket_id, reporter_name, reporter_identifier, microscope, message,
  ticket_type, issue_type, priority, source, status, opened_at, resolved_at,
  resolution_note, assigned_to, chat_thread_id, chat_url, chat_state,
  created_at, updated_at, created_by, updated_by, version`;
const SORTS = {
  ticket_id: 't.ticket_id', opened_at: 't.opened_at', resolved_at: 't.resolved_at',
  updated_at: 't.updated_at', reporter_name: 't.reporter_name', microscope: 't.microscope',
  status: 't.status', issue_type: 't.issue_type',
  priority: `CASE t.priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 ELSE 1 END`,
};

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function scalar(value, label) {
  if (value !== undefined && value !== null && typeof value !== 'string') fail(`Invalid ${label}`);
  return value || '';
}
function text(value, label, max, required = false) {
  const result = scalar(value, label).trim();
  if (result.length > max || (required && !result)) fail(`${label} ${required ? 'is required and ' : ''}must not exceed ${max} characters`);
  return result || null;
}
function integer(value, fallback, max = 1000000) {
  if (value === undefined) return fallback;
  if (!['string', 'number'].includes(typeof value)) fail('Invalid pagination or version');
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))
      || Number(value) < 1 || Number(value) > max) fail('Invalid pagination or version');
  return Number(value);
}
function id(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)
      || BigInt(value) > 9223372036854775807n) fail('Invalid ticket or image ID');
  return value;
}
function choice(value, allowed, label, fallback) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) fail(`Invalid ${label}`);
  return value;
}
function selections(value, allowed, label, defaults = []) {
  if (value === undefined) return defaults;
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 100 || values.some((entry) => typeof entry !== 'string')) fail(`Invalid ${label}`);
  if (values.length === 1 && values[0] === 'all') return [];
  if (allowed && values.some((entry) => !allowed.includes(entry))) fail(`Invalid ${label}`);
  return [...new Set(values)];
}
function flag(value) {
  if (value === undefined || value === 'false') return false;
  if (value !== 'true') fail('Invalid filter flag');
  return true;
}
function onlyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid request body');
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail('Unexpected ticket field');
}
function actor(body, catalogue) { return `staff-entered: ${catalogue.resolve('staff', body.actor_name, { label: 'staff name' })}`; }
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Invalid calendar date');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('Invalid calendar date');
  return value;
}

function buildTicketQuery(query, catalogue) {
  const values = [];
  const filters = [];
  const add = (value) => { values.push(value); return `$${values.length}`; };
  const contains = (value, columns, label, extra = () => []) => {
    const term = text(value, label, 200);
    if (term) {
      const pattern = add(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
      filters.push(`(${[...columns.map((column) => `${column} ILIKE ${pattern}`), ...extra(term)].join(' OR ')})`);
    }
  };
  contains(query.search, ['t.ticket_id::text', 't.reporter_name', 't.microscope', 't.message'], 'Search', (term) => {
    const ids = catalogue.microscopes.filter((entry) => entry.name.toLowerCase().includes(term.toLowerCase())).map((entry) => entry.id);
    return ids.length ? [`t.microscope = ANY(${add(ids)}::text[])`] : [];
  });
  contains(query.reporter, ['t.reporter_name'], 'Reporter search');
  contains(query.message, ['t.message'], 'Message search');
  const statuses = selections(query.status, STATUSES, 'status', ACTIVE);
  if (statuses.length) filters.push(`t.status = ANY(${add(statuses)}::text[])`);
  const microscopes = selections(query.microscope, null, 'microscope').map((value) => catalogue.resolve('microscopes', value, { label: 'microscope' }));
  const microscopeFilters = [];
  if (microscopes.length) microscopeFilters.push(`t.microscope = ANY(${add(microscopes)}::text[])`);
  if (flag(query.facilityWide)) microscopeFilters.push('t.microscope IS NULL');
  if (microscopeFilters.length) filters.push(`(${microscopeFilters.join(' OR ')})`);
  for (const [key, column, allowed] of [['type', 'ticket_type', TYPES], ['priority', 'priority', PRIORITIES]]) {
    const selected = selections(query[key], allowed, key);
    if (selected.length) filters.push(`t.${column} = ANY(${add(selected)}::text[])`);
  }
  const issues = selections(query.issueType, ISSUES, 'issue type');
  const issueFilters = [];
  if (issues.length) issueFilters.push(`t.issue_type = ANY(${add(issues)}::text[])`);
  if (flag(query.issueTypeUnspecified)) issueFilters.push('t.issue_type IS NULL');
  if (issueFilters.length) filters.push(`(${issueFilters.join(' OR ')})`);
  const source = choice(query.source, ['all', 'CONTACT_FORM', 'DASHBOARD'], 'source', 'all');
  if (source !== 'all') filters.push(`t.source = ${add(source)}`);
  const chat = choice(query.chatState, ['all', 'NOT_REQUESTED', 'PENDING', 'OPEN', 'FAILED'], 'chat state', 'all');
  if (chat !== 'all') filters.push(`t.chat_state = ${add(chat)}`);
  if (flag(query.unassigned)) {
    if (text(query.assignedTo, 'Assigned staff', 200)) fail('Choose assigned staff or unassigned');
    filters.push('t.assigned_to IS NULL');
  } else if (query.assignedTo) filters.push(`t.assigned_to = ${add(catalogue.resolve('staff', query.assignedTo, { label: 'assigned staff' }))}`);
  const dateField = choice(query.dateField, ['opened_at', 'resolved_at', 'updated_at'], 'date field', 'opened_at');
  const start = scalar(query.startDate, 'start date');
  const end = scalar(query.endDate, 'end date');
  if (start) filters.push(`t.${dateField} >= (${add(validDate(start))}::date::timestamp AT TIME ZONE '${TIMEZONE}')`);
  if (end) filters.push(`t.${dateField} < ((${add(validDate(end))}::date + 1)::timestamp AT TIME ZONE '${TIMEZONE}')`);
  if (start && end && start > end) fail('Start date must be before the end date');
  const sort = choice(query.sort, Object.keys(SORTS), 'sort', 'opened_at');
  const order = choice(query.order, ['asc', 'desc'], 'sort direction', 'desc');
  return {
    page: integer(query.page, 1), pageSize: integer(query.pageSize, 50, 100),
    values, where: filters.length ? `WHERE ${filters.join(' AND ')}` : '',
    orderBy: `${SORTS[sort]} ${order.toUpperCase()} NULLS LAST, t.ticket_id DESC`,
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES, fields: 16, fieldSize: 24000, parts: 21 },
}).array('images', MAX_IMAGES);

async function validateImages(files = []) {
  const images = [];
  for (const file of files) {
    if (!file.buffer.length || file.buffer.length > MAX_IMAGE_BYTES) fail('Images must be non-empty and at most 5 MiB', 413);
    const png = file.buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = file.buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    if (!png && !jpeg) fail('Only PNG and JPEG images are supported');
    try {
      const decoder = sharp(file.buffer, { limitInputPixels: 20000000, failOn: 'warning' });
      const metadata = await decoder.metadata();
      if (!['png', 'jpeg'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error('Unsupported image');
      await decoder.stats(); // Decode pixels, not just the file header.
    } catch { fail('Image cannot be decoded as a single PNG/JPEG of at most 20 megapixels'); }
    const extension = png ? 'png' : 'jpeg';
    const basename = path.win32.basename(path.posix.basename(file.originalname)).replace(/[\x00-\x1f\x7f]/g, '_');
    const stem = basename.replace(/\.[^.]*$/, '').trim().slice(0, 240) || 'image';
    images.push({ filename: `${stem}.${extension}`, extension, data: file.buffer });
  }
  return images;
}

function publicTicket(row) {
  if (!row) return row;
  const result = { ...row };
  result.chat_url = null;
  if (row.chat_url) {
    try {
      const url = new URL(row.chat_url);
      const hosts = (process.env.TICKET_CHAT_HOSTS || '').split(',').map((host) => host.trim()).filter(Boolean);
      if (url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password
          && ![...url.searchParams.keys()].some((key) => /token|password|secret|auth/i.test(key))) result.chat_url = url.href;
    } catch { /* Untrusted chat metadata is never turned into an unsafe link. */ }
  }
  return result;
}

async function addImages(client, ticketId, images) {
  const metadata = [];
  for (const image of images) {
    const result = await client.query(`INSERT INTO public.microscope_ticket_image
      (ticket_id, filename, extension, image_data) VALUES ($1::bigint, $2, $3, $4)
      RETURNING image_id, filename, extension, octet_length(image_data) AS size_bytes`,
    [ticketId, image.filename, image.extension, image.data]);
    metadata.push(result.rows[0]);
  }
  return metadata;
}
async function event(client, ticketId, type, oldStatus, newStatus, note, changes, who) {
  await client.query(`INSERT INTO public.microscope_ticket_event
    (ticket_id, event_type, old_status, new_status, note, changes, actor)
    VALUES ($1::bigint, $2, $3, $4, $5, $6::jsonb, $7)`,
  [ticketId, type, oldStatus, newStatus, note, JSON.stringify(changes), who]);
}

const SUMMARY_SQL = `WITH clock AS (
  SELECT now() AS current_time, now() - interval '30 days' AS cutoff,
         now() - interval '60 days' AS earlier
), historical AS (
  SELECT t.*, COALESCE(h.new_status, CASE WHEN t.updated_at <= c.cutoff THEN t.status END) AS previous_status
  FROM public.microscope_ticket t CROSS JOIN clock c
  LEFT JOIN LATERAL (
    SELECT e.new_status FROM public.microscope_ticket_event e
    WHERE e.ticket_id = t.ticket_id AND e.occurred_at <= c.cutoff AND e.new_status IS NOT NULL
    ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1
  ) h ON true
), resolutions AS (
  SELECT ticket_id, occurred_at AS resolved_time FROM public.microscope_ticket_event
  WHERE new_status = 'RESOLVED' AND old_status IS DISTINCT FROM 'RESOLVED'
  UNION ALL
  SELECT t.ticket_id, t.resolved_at FROM public.microscope_ticket t
  WHERE t.resolved_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.microscope_ticket_event e WHERE e.ticket_id = t.ticket_id AND e.new_status = 'RESOLVED'
  )
)
SELECT c.cutoff AS comparison_at,
  count(*) FILTER (WHERE t.opened_at <= c.current_time)::int AS total,
  count(*) FILTER (WHERE t.opened_at <= c.cutoff)::int AS previous_total,
  count(*) FILTER (WHERE t.status IN ('OPEN','IN_PROGRESS','WAITING'))::int AS active,
  CASE WHEN count(*) FILTER (WHERE t.opened_at <= c.cutoff AND t.previous_status IS NULL) > 0 THEN NULL
    ELSE count(*) FILTER (WHERE t.opened_at <= c.cutoff AND t.previous_status IN ('OPEN','IN_PROGRESS','WAITING'))::int
    END AS previous_active,
  (SELECT count(DISTINCT r.ticket_id)::int FROM resolutions r
    WHERE r.resolved_time > c.cutoff AND r.resolved_time <= c.current_time) AS resolved,
  (SELECT count(DISTINCT r.ticket_id)::int FROM resolutions r
    WHERE r.resolved_time > c.earlier AND r.resolved_time <= c.cutoff) AS previous_resolved
FROM clock c LEFT JOIN historical t ON true GROUP BY c.cutoff, c.current_time, c.earlier`;

function createTicketsRouter({ pool, catalogue } = {}) {
  const router = express.Router();
  const database = () => pool || getTicketPool();
  const catalog = () => catalogue || getTicketCatalogue();
  const route = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error); } };
  const transaction = async (callback, readOnly = false) => {
    const client = await database().connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  };
  let inFlightUploads = 0;
  const parseUpload = (req, res, next) => {
    if (inFlightUploads >= 2) return res.status(429).json({ error: 'Image uploads are busy. Please retry shortly.' });
    inFlightUploads += 1;
    let released = false;
    const release = () => { if (!released) { released = true; inFlightUploads -= 1; } };
    res.once('finish', release); res.once('close', release);
    upload(req, res, next);
  };
  router.use(authMiddleware);
  router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

  router.get('/summary', route(async (req, res) => {
    const { rows } = await database().query(SUMMARY_SQL);
    const row = rows[0];
    const metric = (name) => {
      const value = Number(row[name]);
      const previous = row[`previous_${name}`] === null ? null : Number(row[`previous_${name}`]);
      return { value, previous, change: previous === null ? null : value - previous,
        change_percent: previous ? Math.round((value - previous) / previous * 1000) / 10 : null };
    };
    res.json({ comparison_at: row.comparison_at, total: metric('total'), active: metric('active'), resolved: metric('resolved') });
  }));
  router.get('/filter-options', route(async (req, res) => {
    const { microscopes, staff } = catalog();
    res.json({ microscopes, staff, statuses: STATUSES, types: TYPES,
      issueTypes: ISSUES, priorities: PRIORITIES, timezone: TIMEZONE,
      maxImageBytes: MAX_IMAGE_BYTES, maxImages: MAX_IMAGES });
  }));
  router.get('/', route(async (req, res) => {
    const options = buildTicketQuery(req.query, catalog());
    const { page, pageSize, where, values, orderBy } = options;
    const result = await transaction(async (client) => {
      const total = await client.query('SELECT count(*)::int AS count FROM public.microscope_ticket');
      const filtered = await client.query(`SELECT count(*)::int AS count FROM public.microscope_ticket t ${where}`, values);
      const rows = await client.query(`SELECT t.ticket_id, t.reporter_name, t.microscope,
        left(t.message, 180) AS message_preview, t.ticket_type, t.issue_type, t.priority,
        t.status, t.opened_at, t.resolved_at, t.assigned_to, t.version,
        (SELECT count(*)::int FROM public.microscope_ticket_image i WHERE i.ticket_id = t.ticket_id) AS image_count
        FROM public.microscope_ticket t ${where} ORDER BY ${orderBy}
        LIMIT $${values.length + 1}::int OFFSET $${values.length + 2}::int`,
      [...values, pageSize, (page - 1) * pageSize]);
      return { data: rows.rows, total: total.rows[0].count, filteredTotal: filtered.rows[0].count };
    }, true);
    res.json({ ...result, page, pageSize, totalPages: Math.ceil(result.filteredTotal / pageSize) });
  }));
  router.get('/:ticketId/events', route(async (req, res) => {
    const ticketId = id(req.params.ticketId);
    const page = integer(req.query.page, 1);
    const pageSize = integer(req.query.pageSize, 25, 100);
    const result = await database().query(`SELECT event_id, event_type, old_status, new_status,
      note, changes, actor, occurred_at, count(*) OVER()::int AS total
      FROM public.microscope_ticket_event WHERE ticket_id = $1::bigint
      ORDER BY occurred_at DESC, event_id DESC LIMIT $2 OFFSET $3`, [ticketId, pageSize, (page - 1) * pageSize]);
    res.json({ data: result.rows.map(({ total, ...row }) => row), total: result.rows[0]?.total || 0, page, pageSize });
  }));
  router.get('/:ticketId/images', route(async (req, res) => {
    const { rows } = await database().query(`SELECT image_id, filename, extension, octet_length(image_data) AS size_bytes
      FROM public.microscope_ticket_image WHERE ticket_id = $1::bigint ORDER BY image_id`, [id(req.params.ticketId)]);
    res.json({ data: rows });
  }));
  router.get('/:ticketId/images/:imageId', route(async (req, res) => {
    const { rows } = await database().query(`SELECT image_data, extension FROM public.microscope_ticket_image
      WHERE ticket_id = $1::bigint AND image_id = $2::bigint`, [id(req.params.ticketId), id(req.params.imageId)]);
    if (!rows.length) fail('Image not found for this ticket', 404);
    res.set('Content-Type', rows[0].extension === 'png' ? 'image/png' : 'image/jpeg');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `inline; filename="ticket-image-${req.params.imageId}.${rows[0].extension}"`);
    res.send(rows[0].image_data);
  }));
  router.get('/:ticketId', route(async (req, res) => {
    const { rows } = await database().query(`SELECT ${COLUMNS},
      CASE WHEN t.status IN ('RESOLVED','CANCELLED') THEN (
        SELECT e.occurred_at FROM public.microscope_ticket_event e
        WHERE e.ticket_id=t.ticket_id AND e.new_status=t.status AND e.old_status IS DISTINCT FROM e.new_status
        ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1
      ) END AS closed_at
      FROM public.microscope_ticket t WHERE ticket_id = $1::bigint`, [id(req.params.ticketId)]);
    if (!rows.length) fail('Ticket not found', 404);
    res.json(publicTicket(rows[0]));
  }));
  router.post('/', parseUpload, route(async (req, res) => {
    const body = req.body;
    onlyFields(body, ['reporter_name', 'reporter_identifier', 'microscope', 'message', 'ticket_type',
      'issue_type', 'priority', 'assigned_to', 'source_event_id', 'actor_name']);
    const catalogue = catalog();
    const who = actor(body, catalogue);
    const requestId = scalar(body.source_event_id, 'Submission ID');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) fail('A submission UUID is required');
    const fields = {
      reporter_name: text(body.reporter_name, 'Reporter', 200, true),
      reporter_identifier: text(body.reporter_identifier, 'Reporter identifier', 254),
      microscope: catalogue.resolve('microscopes', body.microscope, { optional: true, label: 'microscope' }),
      message: text(body.message, 'Message', 20000, true),
      ticket_type: choice(body.ticket_type, TYPES, 'ticket type', 'USER_REQUEST'),
      issue_type: choice(text(body.issue_type, 'Issue type', 30) ?? undefined, ISSUES, 'issue type', null),
      priority: choice(body.priority, PRIORITIES, 'priority', 'NORMAL'),
      assigned_to: catalogue.resolve('staff', body.assigned_to, { optional: true, label: 'assigned staff' }),
    };
    const images = await validateImages(req.files);
    const hash = createHash('sha256').update(JSON.stringify({ ...fields, actor: who,
      images: images.map((image) => [image.filename, createHash('sha256').update(image.data).digest('hex')]) })).digest('hex');
    const result = await transaction(async (client) => {
      const inserted = await client.query(`INSERT INTO public.microscope_ticket
        (reporter_name, reporter_identifier, microscope, message, ticket_type, issue_type,
         priority, assigned_to, source, source_event_id, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DASHBOARD',$9,$10,$10)
        ON CONFLICT (source, source_event_id) DO NOTHING RETURNING ${COLUMNS}`,
      [...Object.values(fields), requestId, who]);
      if (!inserted.rows.length) {
        const existing = await client.query(`SELECT ${COLUMNS} FROM public.microscope_ticket
          WHERE source = 'DASHBOARD' AND source_event_id = $1`, [requestId]);
        const ticket = existing.rows[0];
        const audit = await client.query(`SELECT changes ->> 'request_hash' AS hash FROM public.microscope_ticket_event
          WHERE ticket_id = $1::bigint AND event_type = 'CREATED' ORDER BY event_id LIMIT 1`, [ticket.ticket_id]);
        if (audit.rows[0]?.hash !== hash) fail('This submission ID was already used with different data. Start a new ticket.', 409);
        return { ticket, created: false };
      }
      const ticket = inserted.rows[0];
      const metadata = await addImages(client, ticket.ticket_id, images);
      await event(client, ticket.ticket_id, 'CREATED', null, 'OPEN', null,
        { request_hash: hash, initial: fields, images: metadata }, who);
      return { ticket, created: true };
    });
    res.status(result.created ? 201 : 200).json(publicTicket(result.ticket));
  }));
  router.patch('/:ticketId', route(async (req, res) => {
    const ticketId = id(req.params.ticketId);
    const body = req.body;
    onlyFields(body, ['version', 'status', 'resolution_note', 'change_note', 'priority', 'assigned_to', 'issue_type', 'actor_name']);
    const catalogue = catalog();
    const who = actor(body, catalogue);
    const version = integer(body.version, null, 2147483647);
    if (!version) fail('Current ticket version is required');
    const result = await transaction(async (client) => {
      const locked = await client.query(`SELECT ${COLUMNS} FROM public.microscope_ticket WHERE ticket_id = $1::bigint FOR UPDATE`, [ticketId]);
      const old = locked.rows[0];
      if (!old) fail('Ticket not found', 404);
      if (old.version !== version) fail('This ticket changed since you opened it. Reload its details before saving.', 409);
      const status = choice(body.status, STATUSES, 'status', old.status);
      const changedStatus = status !== old.status;
      const wasClosed = ['RESOLVED', 'CANCELLED'].includes(old.status);
      const closing = changedStatus && ['RESOLVED', 'CANCELLED'].includes(status);
      const reopening = changedStatus && wasClosed;
      if (reopening && !['OPEN', 'IN_PROGRESS'].includes(status)) fail('Reopen a closed ticket to Open or In progress first');
      const changeNote = text(body.change_note, 'Change note', 2000);
      if (reopening && !changeNote) fail('Explain why the ticket is being reopened');
      if (body.resolution_note !== undefined && !closing) fail('Closing notes are accepted when resolving or cancelling a ticket');
      const next = {
        status,
        priority: choice(body.priority, PRIORITIES, 'priority', old.priority),
        assigned_to: body.assigned_to === undefined ? old.assigned_to : catalogue.resolve('staff', body.assigned_to, { optional: true, label: 'assigned staff' }),
        issue_type: body.issue_type === undefined ? old.issue_type
          : choice(text(body.issue_type, 'Issue type', 30) ?? undefined, ISSUES, 'issue type', null),
        resolution_note: closing ? text(body.resolution_note, 'Closing note', 2000) : reopening ? null : old.resolution_note,
      };
      if (!Object.entries(next).some(([key, value]) => value !== old[key])) return old;
      const updated = await client.query(`UPDATE public.microscope_ticket
        SET status=$2::varchar, priority=$3, assigned_to=$4, issue_type=$5, resolution_note=$6,
        resolved_at=CASE WHEN $7::boolean THEN CASE WHEN $2::varchar='RESOLVED' THEN now() ELSE NULL END
          WHEN $8::boolean THEN NULL ELSE resolved_at END,
        updated_at=now(), updated_by=$9, version=version+1
        WHERE ticket_id=$1::bigint RETURNING ${COLUMNS}`,
      [ticketId, next.status, next.priority, next.assigned_to, next.issue_type, next.resolution_note, closing, reopening, who]);
      const ticket = updated.rows[0];
      const changes = {};
      for (const key of [...Object.keys(next), 'resolved_at']) {
        if (JSON.stringify(old[key]) !== JSON.stringify(ticket[key])) changes[key] = { before: old[key], after: ticket[key] };
      }
      await event(client, ticketId, changedStatus ? 'STATUS_CHANGED' : 'UPDATED', old.status, status,
        closing ? next.resolution_note : changeNote, changes, who);
      return ticket;
    });
    res.json(publicTicket(result));
  }));
  router.post('/:ticketId/notes', route(async (req, res) => {
    const ticketId = id(req.params.ticketId);
    onlyFields(req.body, ['version', 'note', 'actor_name']);
    const who = actor(req.body, catalog());
    const note = text(req.body.note, 'Progress update', 2000, true);
    const version = integer(req.body.version, null, 2147483647);
    if (!version) fail('Current ticket version is required');
    const result = await transaction(async (client) => {
      const locked = await client.query('SELECT status, version FROM public.microscope_ticket WHERE ticket_id=$1::bigint FOR UPDATE', [ticketId]);
      const ticket = locked.rows[0];
      if (!ticket) fail('Ticket not found', 404);
      if (ticket.version !== version) fail('This ticket changed. Reload latest before adding your update; your draft will be kept.', 409);
      await event(client, ticketId, 'UPDATED', ticket.status, ticket.status, note,
        { update_kind: 'PROGRESS_NOTE' }, who);
      const updated = await client.query(`UPDATE public.microscope_ticket
        SET version=version+1, updated_at=now(), updated_by=$2
        WHERE ticket_id=$1::bigint RETURNING ${COLUMNS}`, [ticketId, who]);
      return updated.rows[0];
    });
    res.status(201).json(publicTicket(result));
  }));
  router.post('/:ticketId/images', parseUpload, route(async (req, res) => {
    const ticketId = id(req.params.ticketId);
    onlyFields(req.body, ['version', 'actor_name']);
    const who = actor(req.body, catalog());
    const version = integer(req.body.version, null, 2147483647);
    if (!version) fail('Current ticket version is required');
    const images = await validateImages(req.files);
    if (!images.length) fail('Select at least one PNG/JPEG image');
    const result = await transaction(async (client) => {
      const locked = await client.query('SELECT status, version FROM public.microscope_ticket WHERE ticket_id=$1::bigint FOR UPDATE', [ticketId]);
      const ticket = locked.rows[0];
      if (!ticket) fail('Ticket not found', 404);
      if (ticket.version !== version) fail('This ticket changed. Reload its details before uploading.', 409);
      const count = await client.query('SELECT count(*)::int AS count FROM public.microscope_ticket_image WHERE ticket_id=$1::bigint', [ticketId]);
      if (count.rows[0].count + images.length > MAX_IMAGES) fail('A ticket can contain at most five images');
      const metadata = await addImages(client, ticketId, images);
      await client.query('UPDATE public.microscope_ticket SET version=version+1, updated_at=now(), updated_by=$2 WHERE ticket_id=$1::bigint', [ticketId, who]);
      await event(client, ticketId, 'UPDATED', ticket.status, ticket.status, null, { images_added: metadata }, who);
      return { data: metadata, version: version + 1 };
    });
    res.status(201).json(result);
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ error: 'Upload up to five PNG/JPEG files, each at most 5 MiB, using the images field.' });
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23514' && error.constraint === 'microscope_ticket_ticket_type_check') return res.status(503).json({ error: 'User reports need the ticket-type database update. Apply migration 002_ticket_user_reports.sql once to this existing database.' });
    if (['23514', '22001', '22003', '22P02'].includes(error.code)) return res.status(400).json({ error: 'Ticket data does not satisfy the database limits.' });
    if (error.code === '42501') return res.status(503).json({ error: 'The current database role lacks ticket permissions. Ask an administrator to apply the ticket grants in proposal section 7; do not rerun migration 001.' });
    if (error.code === '42P01') return res.status(503).json({ error: 'Ticket tables are unavailable in this database. Check the test/production connection.' });
    console.error('Ticket request failed:', error.code || error.name);
    return res.status(500).json({ error: 'Unable to complete the ticket request. Please retry.' });
  });
  return router;
}

module.exports = {
  createTicketsRouter, buildTicketQuery, validateImages, SUMMARY_SQL,
  ticketOperations: { fail, text, onlyFields, id, integer, choice, event, publicTicket },
};
