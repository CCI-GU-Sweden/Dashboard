const test = require('node:test');
const assert = require('node:assert/strict');
const existingPool = require('../db');

function withConnectionEnv(values, check) {
  const keys = ['PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE', 'TICKET_PGUSER', 'TICKET_PGPASSWORD'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    delete require.cache[require.resolve('../ticket-db')];
    return check(require('../ticket-db').getTicketPool);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[require.resolve('../ticket-db')];
  }
}

test('tickets reuse the storage pool without requiring a particular role name', () => {
  for (const PGUSER of ['filestats_dashboard', 'filestats_collector', undefined]) {
    withConnectionEnv({ PGUSER }, (getTicketPool) => {
      assert.equal(getTicketPool(), existingPool);
    });
  }
});

test('partial ticket credentials fail instead of mixing credentials with the storage pool', () => {
  for (const override of [{ TICKET_PGUSER: 'collector' }, { TICKET_PGPASSWORD: 'test-only' }]) {
    withConnectionEnv({ PGUSER: 'dashboard', PGPASSWORD: 'other-test-only', ...override }, (getTicketPool) => {
      assert.throws(getTicketPool, (error) => error.status === 503
        && /Set both TICKET_PGUSER and TICKET_PGPASSWORD/.test(error.message));
    });
  }
});

test('optional paired ticket credentials use the existing database with a separate cached pool', async () => {
  const pool = withConnectionEnv({
    PGUSER: 'dashboard', PGPASSWORD: 'storage-test-only', PGHOST: 'test-host',
    PGPORT: '5432', PGDATABASE: 'omerofilestats',
    TICKET_PGUSER: 'filestats_collector', TICKET_PGPASSWORD: 'ticket-test-only',
  }, (getTicketPool) => {
    const result = getTicketPool();
    assert.notEqual(result, existingPool);
    assert.equal(getTicketPool(), result);
    assert.equal(result.options.user, 'filestats_collector');
    assert.equal(result.options.password, 'ticket-test-only');
    assert.equal(result.options.host, 'test-host');
    assert.equal(result.options.port, '5432');
    assert.equal(result.options.database, 'omerofilestats');
    return result;
  });
  await pool.end();
});
