const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const YAML = require('yaml');
const { parseTicketCatalogue } = require('../ticket-catalogue');
const { createTicketIntegrationRouter } = require('../routes/ticket-integrations');
const { createTicketsRouter } = require('../routes/tickets');

const serviceToken = 'local-test-integration-token-at-least-32-bytes';
const staffToken = jwt.sign({ access: true }, process.env.JWT_SECRET || 'supersecret');
const catalogue = parseTicketCatalogue(YAML.stringify({ staff: [{ id: 'simon', name: 'Simon' }],
  microscopes: [{ id: 'lsm_980', name: 'LSM 980' }, { id: 'lsm_880', name: 'LSM 880' }] }));
function submission(overrides = {}) {
  return { source_event_id: randomUUID(), submission_kind: 'SUPPORT_REQUEST',
    reporter_name: 'External reporter', microscope: 'lsm_980', message: 'Controller unavailable', ...overrides };
}
async function serve(pool, token = serviceToken) {
  const app = express();
  app.use('/integration', createTicketIntegrationRouter({ pool, catalogue, token }));
  app.use(express.json());
  app.use('/staff', createTicketsRouter({ pool, catalogue }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
async function request(url, method = 'GET', body, token = serviceToken) {
  const response = await fetch(url, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}

test('service authentication is separate from staff access and runs before body parsing', async () => {
  let queries = 0;
  const unexpected = () => { queries += 1; throw new Error('Unexpected database access'); };
  const server = await serve({ query: unexpected, connect: unexpected });
  const disabled = await serve({}, '');
  try {
    assert.equal((await request(`${disabled.url}/integration/microscopes`)).status, 503);
    for (const token of ['', 'wrong', staffToken]) {
      assert.equal((await request(`${server.url}/integration`, 'POST', submission(), token)).status, 401);
    }
    const untrusted = await fetch(`${server.url}/integration`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{malformed' });
    assert.equal(untrusted.status, 401);
    assert.equal((await request(`${server.url}/staff/filter-options`)).status, 401);
    assert.equal((await request(`${server.url}/integration/1`, 'GET')).status, 404);
    const options = await request(`${server.url}/integration/microscopes`);
    assert.equal(options.status, 200);
    assert.deepEqual(options.data, { microscopes: catalogue.microscopes });
    assert.equal(queries, 0);
  } finally { await server.close(); await disabled.close(); }
});

test('integration accepts only the simple form and submission identity, with bounded JSON', async () => {
  let connections = 0;
  const server = await serve({ connect: () => { connections += 1; throw new Error('Unexpected write'); } });
  const url = `${server.url}/integration`;
  try {
    for (const override of [
      { status: 'RESOLVED' }, { priority: 'CRITICAL' }, { issue_type: 'SOFTWARE' },
      { assigned_to: 'simon' }, { actor_name: 'simon' }, { source: 'DASHBOARD' },
      { reporter_name: ' ' }, { microscope: 'LSM 990' }, { microscope: '' },
      { message: ' ' }, { message: 'x'.repeat(20001) }, { submission_kind: 'INCIDENT' },
      { submission_kind: undefined }, { source_event_id: undefined }, { source_event_id: 'invalid' },
    ]) assert.equal((await request(url, 'POST', submission(override))).status, 400);
    const malformed = await fetch(url, { method: 'POST', headers: {
      Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' }, body: '{malformed' });
    assert.equal(malformed.status, 400);
    const large = await fetch(url, { method: 'POST', headers: {
      Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(140000) }) });
    assert.equal(large.status, 413);
    const wrongType = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}` }, body: 'text' });
    assert.equal(wrongType.status, 415);
    for (const body of [
      { version: 1, chat_state: 'PENDING' },
      { version: 1, chat_state: 'OPEN' },
      { version: 1, chat_state: 'FAILED', chat_thread_id: 'unexpected' },
      { version: 1, chat_state: 'OPEN', chat_url: 'http://chat.example.test/thread' },
      { version: 1, chat_state: 'OPEN', chat_url: 'https://user:pass@chat.example.test/thread' },
      { version: 1, chat_state: 'OPEN', chat_url: 'https://chat.example.test/thread?token=secret' },
    ]) assert.equal((await request(`${url}/1/chat`, 'PATCH', body)).status, 400);
    assert.equal(connections, 0);
  } finally { await server.close(); }
});

test('contact integration against PostgreSQL: support requests, user reports, retries and chat updates', {
  skip: !process.env.TICKET_TEST_DATABASE_URL || !process.env.TICKET_TEST_ADMIN_URL,
}, async (suite) => {
  const pool = new Pool({ connectionString: process.env.TICKET_TEST_DATABASE_URL });
  const admin = new Pool({ connectionString: process.env.TICKET_TEST_ADMIN_URL });
  const server = await serve(pool);
  const api = `${server.url}/integration`;
  const staff = `${server.url}/staff`;
  try {
    await suite.test('support and self-solved reports remain open with different types and chat intent', async () => {
      for (const kind of ['SUPPORT_REQUEST', 'USER_REPORT']) {
        const input = submission({ submission_kind: kind, microscope: ' lSm 980 ' });
        const created = await request(api, 'POST', input);
        assert.equal(created.status, 201, JSON.stringify(created.data));
        assert.equal(created.data.status, 'OPEN');
        assert.equal(created.data.submission_kind, kind);
        assert.equal(created.data.chat_required, kind === 'SUPPORT_REQUEST');
        assert.equal(created.data.chat_state, kind === 'SUPPORT_REQUEST' ? 'PENDING' : 'NOT_REQUESTED');
        assert.equal(created.data.reporter_name, undefined);
        const stored = await admin.query('SELECT * FROM public.microscope_ticket WHERE ticket_id=$1', [created.data.ticket_id]);
        const ticket = stored.rows[0];
        assert.equal(ticket.source, 'CONTACT_FORM');
        assert.equal(ticket.ticket_type, kind === 'USER_REPORT' ? 'USER_REPORT' : 'USER_REQUEST');
        assert.equal(ticket.microscope, 'lsm_980');
        assert.equal(ticket.priority, 'NORMAL');
        assert.equal(ticket.issue_type, null);
        assert.equal(ticket.assigned_to, null);
        assert.equal(ticket.resolved_at, null);
        assert.equal(ticket.created_by, 'integration: support-page');
        const events = await admin.query('SELECT * FROM public.microscope_ticket_event WHERE ticket_id=$1', [ticket.ticket_id]);
        assert.equal(events.rowCount, 1);
        assert.equal(events.rows[0].changes.user_reported_resolved, kind === 'USER_REPORT');
        const lookup = await request(`${api}/submissions/${input.source_event_id}`);
        assert.equal(lookup.status, 200);
        assert.equal(lookup.data.ticket_id, ticket.ticket_id);
        if (kind === 'USER_REPORT') assert.equal((await request(`${api}/${ticket.ticket_id}/chat`, 'PATCH', {
          version: 1, chat_state: 'OPEN', chat_thread_id: 'must-not-open',
        })).status, 404);
      }
    });
    await suite.test('concurrent duplicates create one ticket/event and changed payload conflicts', async () => {
      const input = submission();
      const responses = await Promise.all([request(api, 'POST', input), request(api, 'POST', input)]);
      assert.deepEqual(responses.map((result) => result.status).sort(), [200, 201]);
      assert.equal(responses[0].data.ticket_id, responses[1].data.ticket_id);
      const ticketId = responses[0].data.ticket_id;
      assert.equal((await request(api, 'POST', { ...input, message: 'Changed report' })).status, 409);
      assert.equal((await request(api, 'POST', { ...input, submission_kind: 'USER_REPORT' })).status, 409);
      const events = await admin.query('SELECT event_id FROM public.microscope_ticket_event WHERE ticket_id=$1', [ticketId]);
      assert.equal(events.rowCount, 1);
      await request(`${staff}/${ticketId}`, 'PATCH', { version: 1, actor_name: 'simon',
        status: 'IN_PROGRESS', issue_type: 'HARDWARE', priority: 'HIGH' }, staffToken);
      const replay = await request(api, 'POST', input);
      assert.equal(replay.status, 200);
      assert.equal(replay.data.status, 'IN_PROGRESS');
      assert.equal(replay.data.version, 2);
      const stored = (await admin.query('SELECT priority, issue_type FROM public.microscope_ticket WHERE ticket_id=$1', [ticketId])).rows[0];
      assert.equal(stored.priority, 'HIGH');
      assert.equal(stored.issue_type, 'HARDWARE');
    });
    await suite.test('chat failure/retry preserves staff changes; identical callbacks are idempotent', async () => {
      const input = submission();
      const created = await request(api, 'POST', input);
      const ticketId = created.data.ticket_id;
      const chat = `${api}/${ticketId}/chat`;
      const failed = await request(chat, 'PATCH', { version: 1, chat_state: 'FAILED' });
      assert.equal(failed.status, 200, JSON.stringify(failed.data));
      assert.equal(failed.data.chat_required, true);
      await request(`${staff}/${ticketId}`, 'PATCH', { version: 2, actor_name: 'simon', priority: 'CRITICAL' }, staffToken);
      const callback = { version: 2, chat_state: 'OPEN', chat_thread_id: 'thread-test' };
      assert.equal((await request(chat, 'PATCH', callback)).status, 409);
      const latest = await request(`${api}/submissions/${input.source_event_id}`);
      const opened = await request(chat, 'PATCH', { ...callback, version: latest.data.version });
      assert.equal(opened.status, 200, JSON.stringify(opened.data));
      assert.equal(opened.data.chat_required, false);
      assert.equal(opened.data.chat_state, 'OPEN');
      assert.equal((await request(chat, 'PATCH', callback)).status, 200);
      assert.equal((await request(chat, 'PATCH', { version: opened.data.version, chat_state: 'FAILED' })).status, 409);
      assert.equal((await request(chat, 'PATCH', { version: opened.data.version, chat_state: 'OPEN', chat_thread_id: 'another-thread' })).status, 409);
      assert.equal((await request(chat, 'PATCH', { version: opened.data.version, chat_state: 'OPEN', chat_thread_id: 'thread-test', status: 'RESOLVED' })).status, 400);
      const stored = (await admin.query('SELECT * FROM public.microscope_ticket WHERE ticket_id=$1', [ticketId])).rows[0];
      assert.equal(stored.priority, 'CRITICAL');
      assert.equal(stored.status, 'OPEN');
      assert.equal(stored.message, input.message);
      assert.equal(stored.chat_thread_id, 'thread-test');
      const events = await admin.query("SELECT event_id FROM public.microscope_ticket_event WHERE ticket_id=$1 AND event_type='CHAT_UPDATED'", [ticketId]);
      assert.equal(events.rowCount, 2);
    });
    await suite.test('chat links use the configured host allowlist and manual tickets cannot receive contact callbacks', async () => {
      const previousHosts = process.env.TICKET_CHAT_HOSTS;
      process.env.TICKET_CHAT_HOSTS = 'chat.example.test';
      try {
        const input = submission();
        const created = await request(api, 'POST', input);
        const chat = `${api}/${created.data.ticket_id}/chat`;
        const valid = { version: 1, chat_state: 'OPEN', chat_thread_id: 'chat-allowed', chat_url: 'https://chat.example.test/thread/123' };
        assert.equal((await request(chat, 'PATCH', { ...valid, chat_url: 'https://other.example.test/thread' })).status, 400);
        assert.equal((await request(chat, 'PATCH', valid)).status, 200);
        const details = await request(`${staff}/${created.data.ticket_id}`, 'GET', undefined, staffToken);
        assert.equal(details.data.chat_url, valid.chat_url);
        const manual = await request(staff, 'POST', { reporter_name: 'Manual issue', microscope: 'lsm_980',
          message: 'Reported manually', source_event_id: input.source_event_id, actor_name: 'simon' }, staffToken);
        assert.equal(manual.status, 201);
        assert.notEqual(manual.data.ticket_id, created.data.ticket_id);
        assert.equal((await request(`${api}/${manual.data.ticket_id}/chat`, 'PATCH', valid)).status, 404);
      } finally {
        if (previousHosts === undefined) delete process.env.TICKET_CHAT_HOSTS;
        else process.env.TICKET_CHAT_HOSTS = previousHosts;
      }
    });
    await suite.test('late history failure rolls back the whole contact submission', async () => {
      const input = submission();
      const faultyPool = { connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: (sql, values) => {
          if (sql.includes('INSERT INTO public.microscope_ticket_event')) {
            const error = new Error('Injected failure'); error.code = '23514'; throw error;
          }
          return client.query(sql, values);
        } };
      } };
      const faulty = await serve(faultyPool);
      try {
        assert.equal((await request(`${faulty.url}/integration`, 'POST', input)).status, 400);
        assert.equal((await admin.query("SELECT ticket_id FROM public.microscope_ticket WHERE source='CONTACT_FORM' AND source_event_id=$1", [input.source_event_id])).rowCount, 0);
      } finally { await faulty.close(); }
    });
  } finally { await server.close(); await pool.end(); await admin.end(); }
});
