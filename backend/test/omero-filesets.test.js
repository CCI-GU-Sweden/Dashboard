const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const pool = require('../db');
const omeroRouter = require('../routes/omero');
const {
  buildFilesetQuery,
  buildRankingOptions,
  normalizePolicyInput,
  extractOwnerEmails,
} = omeroRouter;

test('owner emails are extracted, deduplicated case-insensitively, and sorted', () => {
  assert.deepEqual(extractOwnerEmails([
    { username: 'Second.User@example.org' },
    { username: 'Owner (first.user@example.org)' },
    { username: 'second.user@EXAMPLE.org' },
    { username: 'not-an-email' },
  ]), ['first.user@example.org', 'Second.User@example.org']);
});

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

test('group ranking validates its limit and policy filters', () => {
  assert.deepEqual(buildRankingOptions({}, [30]), {
    values: [30, 10],
    policyType: 'all',
    policyCondition: '',
    limitPlaceholder: '$2::int',
  });

  const filtered = buildRankingOptions({ limit: '50', policy_type: 'CORE' }, [30]);
  assert.deepEqual(filtered.values, [30, 'CORE', 50]);
  assert.equal(filtered.policyCondition, 'AND current_group.policy_type = $2');
  assert.equal(filtered.limitPlaceholder, '$3::int');
  assert.equal(buildRankingOptions({ limit: '100' }, [30]), null);
  assert.equal(buildRankingOptions({ policy_type: 'INVALID' }, [30]), null);
});

test('group ranking returns top-group metrics and comparison percentage', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql, values) => {
    assert.match(sql, /ORDER BY current_group\.billable_bytes DESC/);
    assert.match(sql, /current_group\.total_bytes::numeric - current_group\.billable_bytes::numeric/);
    assert.match(sql, /LIMIT \$2::int/);
    assert.deepEqual(values, [30, 10]);
    return {
      rows: [{
        group_id: '12',
        group_name: 'Imaging',
        snapshot_date: '2026-09-15',
        comparison_date: '2026-08-16',
        policy_type: 'TEMPORARY',
        billable_gb: '15',
        free_gb: '5',
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
    assert.equal(body.groups[0].policy_type, 'TEMPORARY');
    assert.equal(body.groups[0].free_gb, 5);
    assert.equal(body.groups[0].billable_fileset_count, 4);
    assert.equal(body.groups[0].daily_charge_sek, 0.75);
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('group email draft combines the latest snapshot, policy, and active owner emails', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql, values) => {
    assert.deepEqual(values, ['12']);
    if (sql.includes('SELECT DISTINCT username')) {
      assert.match(sql, /deleted_at IS NULL/);
      return {
        rows: [
          { username: 'one@example.org' },
          { username: 'Owner Two (two@example.org)' },
          { username: 'not-an-email' },
        ],
      };
    }

    assert.match(sql, /MAX\(snapshot_date\)/);
    assert.match(sql, /LEFT JOIN LATERAL/);
    return {
      rows: [{
        group_id: '12',
        group_name: 'Imaging Lab',
        snapshot_date: '2026-09-24',
        total_gb: '300.5',
        billable_gb: '276.8',
        daily_charge_sek: '3.3216',
        policy_type: 'TEMPORARY',
        grace_days: 28,
        billing_grace_days: 2,
        rate_ore_per_gb_day: '1.2',
      }],
    };
  };

  const app = express();
  app.use('/api/omero', omeroRouter);
  const server = app.listen(0);

  try {
    const token = jwt.sign({ access: true }, 'supersecret');
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/omero/groups/12/email-draft`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.recipients, ['one@example.org', 'two@example.org']);
    assert.equal(body.billable_gb, 276.8);
    assert.equal(body.daily_charge_sek, 3.3216);
    assert.equal(body.policy.type, 'TEMPORARY');
    assert.equal(body.policy.retention_days, 28);
    assert.equal(body.policy.billing_grace_days, 2);
    assert.equal(body.policy.rate_ore_per_gb_day, 1.2);
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('policy input applies policy-type invariants', () => {
  const agreement = normalizePolicyInput({
    group_id: '12',
    policy_type: 'AGREEMENT',
    grace_days: 90,
    billing_grace_days: 0,
    rate_ore_per_gb_day: '2.0000',
    valid_from: '2026-10-01',
    notes: ' Agreement ',
  });
  const core = normalizePolicyInput({
    group_id: '12',
    policy_type: 'CORE',
    billing_grace_days: 0,
    rate_ore_per_gb_day: '99',
    valid_from: '2026-10-01',
  });

  assert.equal(agreement.value.graceDays, 0);
  assert.equal(agreement.value.rate, '2.0000');
  assert.equal(agreement.value.notes, 'Agreement');
  assert.equal(core.value.graceDays, null);
  assert.equal(core.value.rate, '0');
});

test('policy input rejects invalid dates and rates', () => {
  assert.equal(normalizePolicyInput({
    group_id: '12',
    policy_type: 'TEMPORARY',
    grace_days: 90,
    billing_grace_days: 7,
    rate_ore_per_gb_day: '-1',
    valid_from: '2026-10-01',
  }).error, 'Rate must be a non-negative number with up to four decimals');
  assert.equal(normalizePolicyInput({
    group_id: '12',
    policy_type: 'CORE',
    billing_grace_days: 0,
    valid_from: 'not-a-date',
  }).error, 'Invalid effective date');
});

test('policy change closes its predecessor and inserts a history row', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.includes('AS today')) return { rows: [{ today: '2026-09-16' }] };
      if (sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            policy_id: '3',
            group_name: 'Imaging',
            valid_from: '2026-01-01',
            valid_until: null,
          }],
        };
      }
      if (sql.includes('RETURNING *')) return { rows: [{ policy_id: '4' }] };
      return { rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  const app = express();
  app.use(express.json());
  app.use('/api/omero', omeroRouter);
  const server = app.listen(0);

  try {
    const token = jwt.sign({ access: true }, 'supersecret');
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/omero/policies`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          group_id: '12',
          policy_type: 'AGREEMENT',
          billing_grace_days: 0,
          rate_ore_per_gb_day: '2.0000',
          valid_from: '2026-10-01',
          notes: 'New agreement',
        }),
      },
    );

    assert.equal(response.status, 201);
    assert.ok(statements.some(({ sql }) => sql.includes('UPDATE public.storage_policy')));
    assert.ok(statements.some(({ sql }) => sql.includes('INSERT INTO public.storage_policy')));
    assert.equal(statements.at(-1).sql, 'COMMIT');
  } finally {
    pool.connect = originalConnect;
    await new Promise((resolve) => server.close(resolve));
  }
});
