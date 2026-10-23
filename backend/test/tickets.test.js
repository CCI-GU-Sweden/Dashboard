const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const { createTicketsRouter, buildTicketQuery, validateImages } = require('../routes/tickets');

const token = jwt.sign({ access: true }, process.env.JWT_SECRET || 'supersecret');
const auth = { Authorization: `Bearer ${token}` };
async function serve(pool) {
  const app = express(); app.use(express.json()); app.use('/api/tickets', createTicketsRouter({ pool }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/api/tickets`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
function payload(overrides = {}) {
  return { reporter_name: 'Ticket test', message: 'Stage laser error: 50%_gain',
    microscope: 'Microscope A', ticket_type: 'INTERNAL_ISSUE', priority: 'NORMAL',
    source_event_id: randomUUID(), actor_name: 'Test staff', ...overrides };
}
async function request(url, method = 'GET', body) {
  const response = await fetch(url, { method, headers: { ...auth, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  return { status: response.status, data };
}
async function png() { return sharp({ create: { width: 3, height: 3, channels: 3, background: '#4972ac' } }).png().toBuffer(); }

test('ticket filters parameterize literal wildcard characters and combine multi-selections', () => {
  const query = buildTicketQuery({ message: '50%_gain', status: ['OPEN', 'WAITING'],
    microscope: ['A', 'B'], facilityWide: 'true', issueType: 'SOFTWARE', issueTypeUnspecified: 'true',
    startDate: '2026-10-25', endDate: '2026-10-25', dateField: 'opened_at' });
  assert.equal(query.values[0], '%50\\%\\_gain%');
  assert.deepEqual(query.values[1], ['OPEN', 'WAITING']);
  assert.match(query.where, /OR t.microscope IS NULL/);
  assert.match(query.where, /OR t.issue_type IS NULL/);
  assert.match(query.where, /Europe\/Stockholm/);
  assert.match(query.where, /::date \+ 1/);
  assert.throws(() => buildTicketQuery({ sort: 'opened_at; DROP TABLE x' }));
  assert.throws(() => buildTicketQuery({ dateField: 'message' }));
  assert.throws(() => buildTicketQuery({ startDate: '2026-02-30' }));
  assert.throws(() => buildTicketQuery({ startDate: '2026-03-02', endDate: '2026-03-01' }));
  assert.throws(() => buildTicketQuery({ status: 'UNKNOWN' }));
  assert.throws(() => buildTicketQuery({ pageSize: '101' }));
});
test('real image decoding rejects a header-only fake and normalizes a safe PNG filename', async () => {
  const good = await png();
  const images = await validateImages([{ originalname: 'C:\\fakepath\\example.png', buffer: good }]);
  assert.equal(images[0].filename, 'example.png');
  assert.equal(images[0].extension, 'png');
  assert.deepEqual(images[0].data, good);
  await assert.rejects(validateImages([{ originalname: 'bad.png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') }]));
  await assert.rejects(validateImages([{ originalname: 'bad.svg', buffer: Buffer.from('<svg></svg>') }]));
});
test('authentication runs before ticket queries and multipart parsing', async () => {
  let queried = false;
  const server = await serve({ query: async () => { queried = true; throw new Error('Unexpected'); } });
  try {
    const response = await fetch(`${server.url}/summary`);
    assert.equal(response.status, 401);
    const upload = await fetch(server.url, { method: 'POST', body: 'untrusted', headers: { 'Content-Type': 'multipart/form-data; boundary=invalid' } });
    assert.equal(upload.status, 401);
    assert.equal(queried, false);
  } finally { await server.close(); }
});

test('ticket API against PostgreSQL: transactions, concurrency, filters, images, and trends', {
  skip: !process.env.TICKET_TEST_DATABASE_URL || !process.env.TICKET_TEST_ADMIN_URL,
}, async (suite) => {
  const pool = new Pool({ connectionString: process.env.TICKET_TEST_DATABASE_URL });
  const admin = new Pool({ connectionString: process.env.TICKET_TEST_ADMIN_URL });
  const server = await serve(pool);
  const api = server.url;
  const image = await png();
  try {
    await suite.test('create, identical replay, conflicting replay, and immutable report', async () => {
      const input = payload({ message: '<script>alert(1)</script> 50%_gain', issue_type: '' });
      const created = await request(api, 'POST', input);
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.equal(created.data.issue_type, null);
      assert.equal(created.data.source, 'DASHBOARD');
      const replay = await request(api, 'POST', input);
      assert.equal(replay.status, 200);
      assert.equal(replay.data.ticket_id, created.data.ticket_id);
      assert.equal((await request(api, 'POST', { ...input, message: 'Changed' })).status, 409);
      const events = await request(`${api}/${created.data.ticket_id}/events`);
      assert.equal(events.data.total, 1);
      const denied = await request(`${api}/${created.data.ticket_id}`, 'PATCH', { version: 1, actor_name: 'Test staff', message: 'Changed' });
      assert.equal(denied.status, 400);
      const results = await request(`${api}?status=all&message=${encodeURIComponent('50%_gain')}`);
      assert.ok(results.data.data.some((row) => row.ticket_id === created.data.ticket_id));
      assert.equal(results.data.data.find((row) => row.ticket_id === created.data.ticket_id).message, undefined);
    });
    await suite.test('concurrent edits conflict; optional closing notes survive in history after reopening', async () => {
      const created = await request(api, 'POST', payload());
      const ticketId = created.data.ticket_id;
      const competing = await Promise.all([
        request(`${api}/${ticketId}`, 'PATCH', { version: 1, actor_name: 'Staff A', priority: 'HIGH' }),
        request(`${api}/${ticketId}`, 'PATCH', { version: 1, actor_name: 'Staff B', priority: 'LOW' }),
      ]);
      assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
      const resolved = await request(`${api}/${ticketId}`, 'PATCH', { version: 2, actor_name: 'Staff A', status: 'RESOLVED', resolution_note: 'Fixed controller' });
      assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
      assert.ok(resolved.data.resolved_at);
      assert.equal((await request(`${api}/${ticketId}`, 'PATCH', { version: 3, actor_name: 'Staff A', status: 'OPEN' })).status, 400);
      const reopened = await request(`${api}/${ticketId}`, 'PATCH', { version: 3, actor_name: 'Staff A', status: 'OPEN', change_note: 'Issue recurred' });
      assert.equal(reopened.status, 200);
      assert.equal(reopened.data.resolution_note, null);
      assert.equal(reopened.data.resolved_at, null);
      const events = await request(`${api}/${ticketId}/events`);
      assert.equal(events.data.data[0].changes.resolution_note.before, 'Fixed controller');
      const closed = await request(`${api}/${ticketId}`, 'PATCH', { version: 4, actor_name: 'Staff A', status: 'CANCELLED' });
      assert.equal(closed.status, 200);
      assert.equal(closed.data.resolution_note, null);
    });
    await suite.test('multipart creation, binary display, mismatched ticket isolation, count limit, and malformed uploads', async () => {
      const input = payload();
      const makeForm = () => {
        const form = new FormData(); Object.entries(input).forEach(([key, value]) => form.set(key, value));
        form.append('images', new Blob([image], { type: 'image/png' }), 'sample.png'); return form;
      };
      const created = await request(api, 'POST', makeForm());
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const ticketId = created.data.ticket_id;
      assert.equal((await request(api, 'POST', makeForm())).status, 200);
      const metadata = await request(`${api}/${ticketId}/images`);
      assert.equal(metadata.data.data.length, 1);
      assert.equal(metadata.data.data[0].image_data, undefined);
      const imageId = metadata.data.data[0].image_id;
      const content = await fetch(`${api}/${ticketId}/images/${imageId}`, { headers: auth });
      assert.equal(content.status, 200);
      assert.equal(content.headers.get('content-type'), 'image/png');
      assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await content.arrayBuffer()), image);
      assert.equal((await fetch(`${api}/99999999/images/${imageId}`, { headers: auth })).status, 404);
      const extra = new FormData(); extra.set('actor_name', 'Staff'); extra.set('version', '1');
      for (let index = 0; index < 4; index += 1) extra.append('images', new Blob([image]), `extra${index}.png`);
      const added = await request(`${api}/${ticketId}/images`, 'POST', extra);
      assert.equal(added.status, 201, JSON.stringify(added.data));
      const sixth = new FormData(); sixth.set('actor_name', 'Staff'); sixth.set('version', '2'); sixth.append('images', new Blob([image]), 'sixth.png');
      assert.equal((await request(`${api}/${ticketId}/images`, 'POST', sixth)).status, 400);
      assert.equal((await request(`${api}/${ticketId}/images`)).data.data.length, 5);
      const invalid = new FormData(); Object.entries(payload()).forEach(([key, value]) => invalid.set(key, value));
      invalid.append('images', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')]), 'fake.png');
      assert.equal((await request(api, 'POST', invalid)).status, 400);
      const oversize = new FormData(); Object.entries(payload()).forEach(([key, value]) => oversize.set(key, value));
      oversize.append('images', new Blob([Buffer.alloc(5242881)]), 'large.png');
      assert.equal((await request(api, 'POST', oversize)).status, 413);
    });
    await suite.test('a late image insert failure rolls back the ticket', async () => {
      const faultyPool = { connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: (sql, values) => {
          if (sql.includes('INSERT INTO public.microscope_ticket_image')) {
            const error = new Error('Injected constraint failure'); error.code = '23514'; throw error;
          }
          return client.query(sql, values);
        } };
      } };
      const faulty = await serve(faultyPool);
      const input = payload(); const form = new FormData();
      Object.entries(input).forEach(([key, value]) => form.set(key, value));
      form.append('images', new Blob([image]), 'sample.png');
      try {
        assert.equal((await request(faulty.url, 'POST', form)).status, 400);
        const rows = await admin.query('SELECT ticket_id FROM public.microscope_ticket WHERE source_event_id=$1', [input.source_event_id]);
        assert.equal(rows.rowCount, 0);
      } finally { await faulty.close(); }
    });
    await suite.test('summary uses previous status events and counts a reopened resolution once', async () => {
      const baseline = await request(`${api}/summary`);
      assert.equal(baseline.status, 200, JSON.stringify(baseline.data));
      const created = await request(api, 'POST', payload()); const ticketId = created.data.ticket_id;
      await admin.query(`UPDATE public.microscope_ticket SET opened_at=now()-interval '40 days',
        created_at=now()-interval '40 days', updated_at=now()-interval '40 days' WHERE ticket_id=$1`, [ticketId]);
      await admin.query(`UPDATE public.microscope_ticket_event SET occurred_at=now()-interval '40 days' WHERE ticket_id=$1`, [ticketId]);
      const resolved = await request(`${api}/${ticketId}`, 'PATCH', { version: 1, actor_name: 'Staff', status: 'RESOLVED' });
      assert.equal(resolved.status, 200);
      const after = await request(`${api}/summary`);
      assert.equal(after.data.active.previous, baseline.data.active.previous + 1);
      assert.equal(after.data.resolved.value, baseline.data.resolved.value + 1);
      await request(`${api}/${ticketId}`, 'PATCH', { version: 2, actor_name: 'Staff', status: 'OPEN', change_note: 'Recurred' });
      const reopened = await request(`${api}/summary`);
      assert.equal(reopened.data.resolved.value, after.data.resolved.value);
    });
  } finally { await server.close(); await pool.end(); await admin.end(); }
});
