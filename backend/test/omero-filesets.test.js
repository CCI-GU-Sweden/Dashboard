const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const pool = require('../db');
const omeroRouter = require('../routes/omero');
const { buildFilesetQuery } = omeroRouter;

test('fileset query defaults to active filesets ordered by size', () => {
  const query = buildFilesetQuery({});

  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 50);
  assert.equal(query.where, 'WHERE f.deleted_at IS NULL');
  assert.equal(query.orderBy, 'total_bytes DESC NULLS LAST, fileset_id ASC');
  assert.deepEqual(query.values, []);
});

test('fileset query parameterizes search and filters', () => {
  const query = buildFilesetQuery({
    search: 'smith',
    group_id: '12',
    status: 'active',
    imported: '90d',
    size: '100gb',
    page: '2',
    pageSize: '25',
    sort: 'imported_at',
    order: 'asc',
  });

  assert.equal(query.page, 2);
  assert.equal(query.pageSize, 25);
  assert.equal(query.orderBy, 'imported_at ASC NULLS LAST, fileset_id ASC');
  assert.deepEqual(query.values, ['%smith%', '12', 90, 100_000_000_000]);
  assert.match(query.where, /group_id = \$2::bigint/);
  assert.match(query.where, /imported_at >= CURRENT_TIMESTAMP/);
  assert.match(query.where, /total_bytes > \$4::numeric/);
});

test('fileset query rejects invalid pagination and SQL ordering input', () => {
  assert.equal(buildFilesetQuery({ page: '0' }), null);
  assert.equal(buildFilesetQuery({ pageSize: '101' }), null);
  assert.equal(buildFilesetQuery({ sort: 'total_bytes; DROP TABLE omero_fileset' }), null);
  assert.equal(buildFilesetQuery({ order: 'desc; DROP TABLE omero_fileset' }), null);
  assert.equal(buildFilesetQuery({ group_id: '12 OR 1=1' }), null);
  assert.equal(buildFilesetQuery({ billing: 'anything' }), null);
});

test('fileset query applies policy-based billable and overdue filters', () => {
  const billable = buildFilesetQuery({ billing: 'billable' });
  const overdue = buildFilesetQuery({ billing: 'overdue' });

  assert.match(billable.where, /sp\.policy_type = 'AGREEMENT'/);
  assert.match(billable.where, /sp\.billing_grace_days/);
  assert.match(overdue.where, /sp\.policy_type = 'TEMPORARY'/);
  assert.doesNotMatch(overdue.where, /sp\.billing_grace_days/);
});

test('group ranking returns top-group metrics and comparison percentage', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql, values) => {
    assert.match(sql, /ORDER BY current_group\.billable_bytes DESC/);
    assert.match(sql, /LIMIT 10/);
    assert.deepEqual(values, [30]);
    return {
      rows: [{
        group_id: '12',
        group_name: 'Imaging',
        snapshot_date: '2026-09-15',
        comparison_date: '2026-08-16',
        billable_gb: '15',
        previous_billable_gb: '10',
        billable_fileset_count: '4',
        daily_charge_sek: '0.75',
      }],
    };
  };

  const app = express();
  app.use('/api/omero', omeroRouter);
  const server = app.listen(0);

  try {
    const token = jwt.sign({ access: true }, 'supersecret');
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/omero/groups/ranking?period=30`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.groups[0].change_percent, 50);
    assert.equal(body.groups[0].billable_fileset_count, 4);
    assert.equal(body.groups[0].daily_charge_sek, 0.75);
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  }
});
