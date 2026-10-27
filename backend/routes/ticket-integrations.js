const express = require('express');
const rateLimit = require('express-rate-limit');
const { createHash, timingSafeEqual } = require('crypto');
const { getTicketPool } = require('../ticket-db');
const { getTicketCatalogue } = require('../ticket-catalogue');
const { ticketOperations } = require('./tickets');

const { fail, text, onlyFields, id, integer, choice, event, publicTicket } = ticketOperations;
const ACTOR = 'integration: support-page';
const KINDS = ['SUPPORT_REQUEST', 'USER_REPORT'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function submissionId(value) {
  const result = text(value, 'Submission UUID', 36, true);
  if (!UUID.test(result)) fail('A valid submission UUID is required');
  return result.toLowerCase();
}
function receipt(ticket, created) {
  return {
    ticket_id: ticket.ticket_id,
    source_event_id: ticket.source_event_id,
    submission_kind: ticket.ticket_type === 'USER_REPORT' ? 'USER_REPORT' : 'SUPPORT_REQUEST',
    status: ticket.status,
    chat_state: ticket.chat_state,
    chat_required: ticket.ticket_type === 'USER_REQUEST'
      && ['OPEN', 'IN_PROGRESS', 'WAITING'].includes(ticket.status)
      && ['PENDING', 'FAILED'].includes(ticket.chat_state),
    version: ticket.version,
    ...(created === undefined ? {} : { created }),
  };
}

function createTicketIntegrationRouter({ pool, catalogue, token } = {}) {
  const router = express.Router();
  const database = () => pool || getTicketPool();
  const catalog = () => catalogue || getTicketCatalogue();
  const route = (handler) => async (req, res, next) => {
    try { await handler(req, res); } catch (error) { next(error); }
  };
  const transaction = async (callback) => {
    const client = await database().connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const configured = token === undefined ? process.env.TICKET_INTEGRATION_TOKEN : token;
    if (typeof configured !== 'string' || Buffer.byteLength(configured) < 32 || /\s/.test(configured)) {
      return res.status(503).json({ error: 'Contact-form ticket integration is not configured. Set TICKET_INTEGRATION_TOKEN from a Kubernetes Secret (at least 32 bytes).' });
    }
    const supplied = req.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!supplied || Buffer.byteLength(supplied) !== Buffer.byteLength(configured)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(configured))) {
      return res.status(401).json({ error: 'Unauthorized integration request' });
    }
    next();
  });
  router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100,
    message: { error: 'Too many ticket integration requests. Retry after the indicated delay.' } }));
  router.use((req, res, next) => {
    if (['POST', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Send the submission as application/json' });
    }
    next();
  });
  router.use(express.json({ limit: '128kb' }));

  router.get('/microscopes', route(async (req, res) => {
    res.json({ microscopes: catalog().microscopes });
  }));
  router.get('/submissions/:submissionId', route(async (req, res) => {
    const result = await database().query(`SELECT ticket_id, source_event_id, ticket_type, status, chat_state, version
      FROM public.microscope_ticket WHERE source='CONTACT_FORM' AND source_event_id=$1`, [submissionId(req.params.submissionId)]);
    if (!result.rows.length) fail('Submission not found', 404);
    res.json(receipt(result.rows[0]));
  }));
  router.post('/', route(async (req, res) => {
    onlyFields(req.body, ['source_event_id', 'submission_kind', 'reporter_name', 'microscope', 'message']);
    const requestId = submissionId(req.body.source_event_id);
    const kind = choice(req.body.submission_kind, KINDS, 'submission kind', null);
    if (!kind) fail('Choose SUPPORT_REQUEST or USER_REPORT');
    const fields = {
      reporter_name: text(req.body.reporter_name, 'Name', 200, true),
      microscope: catalog().resolve('microscopes', req.body.microscope, { label: 'microscope' }),
      message: text(req.body.message, 'Issue', 20000, true),
      ticket_type: kind === 'USER_REPORT' ? 'USER_REPORT' : 'USER_REQUEST',
    };
    const hash = createHash('sha256').update(JSON.stringify({ ...fields, submission_kind: kind })).digest('hex');
    const result = await transaction(async (client) => {
      const inserted = await client.query(`INSERT INTO public.microscope_ticket
        (reporter_name, microscope, message, ticket_type, source, source_event_id,
         status, priority, issue_type, assigned_to, chat_state, created_by, updated_by)
        VALUES ($1,$2,$3,$4,'CONTACT_FORM',$5,'OPEN','NORMAL',NULL,NULL,$6,$7,$7)
        ON CONFLICT (source, source_event_id) DO NOTHING
        RETURNING ticket_id, source_event_id, ticket_type, status, chat_state, version`,
      [fields.reporter_name, fields.microscope, fields.message, fields.ticket_type, requestId,
        kind === 'SUPPORT_REQUEST' ? 'PENDING' : 'NOT_REQUESTED', ACTOR]);
      if (!inserted.rows.length) {
        const existing = await client.query(`SELECT ticket_id, source_event_id, ticket_type, status, chat_state, version
          FROM public.microscope_ticket WHERE source='CONTACT_FORM' AND source_event_id=$1`, [requestId]);
        const ticket = existing.rows[0];
        const audit = await client.query(`SELECT changes ->> 'request_hash' AS hash FROM public.microscope_ticket_event
          WHERE ticket_id=$1::bigint AND event_type='CREATED' ORDER BY event_id LIMIT 1`, [ticket.ticket_id]);
        if (audit.rows[0]?.hash !== hash) fail('This submission UUID was already used with different data', 409);
        return { ticket, created: false };
      }
      const ticket = inserted.rows[0];
      await event(client, ticket.ticket_id, 'CREATED', null, 'OPEN',
        kind === 'USER_REPORT' ? 'User reports that the issue was solved without staff assistance; awaiting staff review.' : null,
        { request_hash: hash, submission_kind: kind, user_reported_resolved: kind === 'USER_REPORT', initial: fields }, ACTOR);
      return { ticket, created: true };
    });
    res.status(result.created ? 201 : 200).json(receipt(result.ticket, result.created));
  }));
  router.patch('/:ticketId/chat', route(async (req, res) => {
    const ticketId = id(req.params.ticketId);
    onlyFields(req.body, ['version', 'chat_state', 'chat_thread_id', 'chat_url']);
    const version = integer(req.body.version, null, 2147483647);
    if (!version) fail('Current ticket version is required');
    const state = choice(req.body.chat_state, ['OPEN', 'FAILED'], 'chat state', null);
    if (!state) fail('Choose OPEN or FAILED for the chat state');
    const thread = text(req.body.chat_thread_id, 'Chat reference', 200);
    const rawUrl = text(req.body.chat_url, 'Chat URL', 2000);
    const url = rawUrl ? publicTicket({ chat_url: rawUrl }).chat_url : null;
    if (rawUrl && !url) fail('Chat URL must use an allowed HTTPS host from TICKET_CHAT_HOSTS and contain no credentials or token parameters');
    if (state === 'OPEN' && !thread && !url) fail('An open chat requires a thread reference or allowed URL');
    if (state === 'FAILED' && (thread || url)) fail('A failed chat must not include chat references');
    const result = await transaction(async (client) => {
      const locked = await client.query(`SELECT ticket_id, source_event_id, source, ticket_type,
        status, chat_state, chat_thread_id, chat_url, version FROM public.microscope_ticket
        WHERE ticket_id=$1::bigint FOR UPDATE`, [ticketId]);
      const ticket = locked.rows[0];
      if (!ticket || ticket.source !== 'CONTACT_FORM' || ticket.ticket_type !== 'USER_REQUEST') fail('Support request not found', 404);
      if (ticket.chat_state === state && ticket.chat_thread_id === thread && ticket.chat_url === url) return ticket;
      if (ticket.version !== version) fail('Ticket changed. Fetch the submission receipt and retry with its current version.', 409);
      if (ticket.chat_state === 'OPEN') fail('This support request already has an open chat; its reference cannot be replaced by this integration.', 409);
      const updated = await client.query(`UPDATE public.microscope_ticket
        SET chat_state=$2, chat_thread_id=$3, chat_url=$4, version=version+1, updated_at=now(), updated_by=$5
        WHERE ticket_id=$1::bigint
        RETURNING ticket_id, source_event_id, ticket_type, status, chat_state, version`,
      [ticketId, state, thread, url, ACTOR]);
      await event(client, ticketId, 'CHAT_UPDATED', ticket.status, ticket.status, null, {
        chat_state: { before: ticket.chat_state, after: state },
        chat_thread_id: { before: ticket.chat_thread_id, after: thread },
        chat_url: { before: ticket.chat_url, after: url },
      }, ACTOR);
      return updated.rows[0];
    });
    res.json(receipt(result));
  }));
  router.use((req, res) => res.status(404).json({ error: 'Integration endpoint not found' }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Ticket submission is too large' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON submission' });
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23514' && error.constraint === 'microscope_ticket_ticket_type_check') {
      return res.status(503).json({ error: 'User reports need migration 002_ticket_user_reports.sql applied to this existing database' });
    }
    if (['23514', '22001', '22003', '22P02'].includes(error.code)) return res.status(400).json({ error: 'Submission does not satisfy the ticket database limits' });
    if (error.code === '42501') return res.status(503).json({ error: 'The database role needs the ticket table and sequence grants in proposal section 7' });
    if (error.code === '42P01') return res.status(503).json({ error: 'Ticket tables are unavailable in the configured database' });
    console.error('Ticket integration failed:', error.code || error.name);
    res.status(500).json({ error: 'Unable to save the submission. Retry using the same submission UUID.' });
  });
  return router;
}

module.exports = { createTicketIntegrationRouter };
