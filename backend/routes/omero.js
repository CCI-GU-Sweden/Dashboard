const express = require('express');

const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const pendingEndpoints = [
  '/collector-runs',
];

const FILESET_SORT_COLUMNS = {
  fileset_id: 'fileset_id',
  username: 'username',
  firstname: 'firstname',
  lastname: 'lastname',
  group_id: 'group_id',
  group_name: 'group_name',
  imported_at: 'imported_at',
  source_file_count: 'source_file_count',
  image_count: 'image_count',
  total_bytes: 'total_bytes',
  deleted_at: 'deleted_at',
};

function parsePositiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) return null;
  return parsed;
}

function normalizePolicyInput(body) {
  const groupId = String(body.group_id || '');
  const policyType = body.policy_type;
  const validFrom = body.valid_from;
  const billingGraceValue = String(body.billing_grace_days ?? '');
  const billingGraceDays = Number(billingGraceValue);
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';

  if (!/^\d+$/.test(groupId)) return { error: 'Invalid group' };
  if (!['TEMPORARY', 'AGREEMENT', 'CORE'].includes(policyType)) {
    return { error: 'Invalid policy type' };
  }
  if (!isIsoDate(validFrom)) return { error: 'Invalid effective date' };
  if (!/^\d+$/.test(billingGraceValue)
    || !Number.isSafeInteger(billingGraceDays)
    || billingGraceDays > 3650) {
    return { error: 'Billing grace must be a whole number from 0 to 3650' };
  }
  if (notes.length > 2000) return { error: 'Notes must not exceed 2000 characters' };

  let graceDays = null;
  let rate = '0';
  if (policyType === 'TEMPORARY') {
    const graceValue = String(body.grace_days ?? '');
    graceDays = Number(graceValue);
    if (!/^\d+$/.test(graceValue)
      || !Number.isSafeInteger(graceDays)
      || graceDays > 36500) {
      return { error: 'Retention period must be a whole number from 0 to 36500' };
    }
  } else if (policyType === 'AGREEMENT') {
    graceDays = 0;
  }

  if (policyType !== 'CORE') {
    const requestedRate = String(body.rate_ore_per_gb_day ?? '');
    if (!/^\d{1,8}(\.\d{1,4})?$/.test(requestedRate)) {
      return { error: 'Rate must be a non-negative number with up to four decimals' };
    }
    rate = requestedRate;
  }

  return {
    value: {
      groupId,
      policyType,
      graceDays,
      billingGraceDays,
      rate,
      validFrom,
      notes: notes || null,
    },
  };
}

function buildFilesetQuery(query) {
  const page = parsePositiveInteger(query.page, 1, 1000000);
  const pageSize = parsePositiveInteger(query.pageSize, 50, 100);
  if (page === null || pageSize === null) return null;

  const status = query.status || 'active';
  if (!['active', 'deleted', 'all'].includes(status)) return null;

  const imported = query.imported || 'all';
  const importedDays = { '30d': 30, '90d': 90, '1y': 365 }[imported];
  if (imported !== 'all' && !importedDays) return null;

  const size = query.size || 'any';
  const minimumBytes = {
    '10gb': 10_000_000_000,
    '100gb': 100_000_000_000,
    '1tb': 1_000_000_000_000,
  }[size];
  if (size !== 'any' && !minimumBytes) return null;

  const billing = query.billing || 'all';
  if (!['all', 'billable', 'overdue'].includes(billing)) return null;

  const sort = query.sort || 'total_bytes';
  const sortColumn = FILESET_SORT_COLUMNS[sort];
  if (!sortColumn) return null;

  const requestedOrder = query.order || 'desc';
  if (typeof requestedOrder !== 'string') return null;
  const order = requestedOrder.toLowerCase();
  if (!['asc', 'desc'].includes(order)) return null;

  const search = String(query.search || '').trim();
  if (search.length > 200) return null;

  const filters = [];
  const values = [];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (status === 'active') filters.push('f.deleted_at IS NULL');
  if (status === 'deleted') filters.push('f.deleted_at IS NOT NULL');

  if (search) {
    const placeholder = addValue(`%${search}%`);
    filters.push(`(
      f.username ILIKE ${placeholder}
      OR f.firstname ILIKE ${placeholder}
      OR f.lastname ILIKE ${placeholder}
      OR f.group_name ILIKE ${placeholder}
      OR f.fileset_id::text ILIKE ${placeholder}
    )`);
  }

  if (query.group_id && query.group_id !== 'all') {
    if (!/^\d+$/.test(query.group_id)) return null;
    filters.push(`f.group_id = ${addValue(query.group_id)}::bigint`);
  }

  if (importedDays) {
    filters.push(`f.imported_at >= CURRENT_TIMESTAMP - (${addValue(importedDays)}::int * INTERVAL '1 day')`);
  }

  if (minimumBytes) filters.push(`f.total_bytes > ${addValue(minimumBytes)}::numeric`);

  if (billing !== 'all') {
    const stockholmDate = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Stockholm')::date`;
    const policyCondition = billing === 'billable'
      ? `(sp.policy_type = 'AGREEMENT' OR (
          sp.policy_type = 'TEMPORARY'
          AND ${stockholmDate} >= f.imported_at::date + sp.grace_days + sp.billing_grace_days + 1
        ))`
      : `sp.policy_type = 'TEMPORARY'
        AND ${stockholmDate} >= f.imported_at::date + sp.grace_days + 1`;
    filters.push(`EXISTS (
      SELECT 1
      FROM public.storage_policy AS sp
      WHERE sp.group_id = f.group_id
        AND f.deleted_at IS NULL
        AND sp.valid_from <= ${stockholmDate}
        AND (sp.valid_until IS NULL OR sp.valid_until >= ${stockholmDate})
        AND ${policyCondition}
    )`);
  }

  return {
    page,
    pageSize,
    sort,
    order,
    values,
    where: filters.length ? `WHERE ${filters.join(' AND ')}` : '',
    orderBy: `${sortColumn} ${order.toUpperCase()} NULLS LAST, fileset_id ASC`,
  };
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function buildHistoryFilters(query) {
  const filters = [];
  const values = [];

  if (query.startDate || query.endDate) {
    if (!isIsoDate(query.startDate) || !isIsoDate(query.endDate)) return null;
    if (query.startDate > query.endDate) return null;
    values.push(query.startDate, query.endDate);
    filters.push(`snapshot_date >= $1::date AND snapshot_date <= $2::date`);
  } else {
    const periodValue = query.period ?? '30';
    if (!/^\d+$/.test(periodValue)) return null;
    const period = Number(periodValue);
    if (!Number.isSafeInteger(period) || period < 1 || period > 3650) return null;
    values.push(period);
    filters.push(`snapshot_date >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`);
  }

  if (query.groupId && query.groupId !== 'all') {
    if (!/^\d+$/.test(query.groupId)) return null;
    values.push(query.groupId);
    filters.push(`group_id = $${values.length}::bigint`);
  }


  return { values, where: filters.join(' AND ') };
}

function getSummaryComparison(query) {
  if (query.startDate || query.endDate) {
    if (!isIsoDate(query.startDate) || !isIsoDate(query.endDate)) return null;
    if (query.startDate > query.endDate) return null;
    return {
      values: [query.endDate, query.startDate],
      currentLimit: '$1::date',
      comparisonTarget: '$2::date',
    };
  }

  const periodValue = query.period ?? '30';
  if (!/^\d+$/.test(periodValue)) return null;
  const period = Number(periodValue);
  if (!Number.isSafeInteger(period) || period < 1 || period > 3650) return null;

  return {
    values: [period],
    currentLimit: 'CURRENT_DATE',
    comparisonTarget: `current_snapshot.snapshot_date
      - ($1::int * INTERVAL '1 day')`,
  };
}

function percentageChange(current, previous) {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function metric(currentRow, previousRow, column) {
  const value = Number(currentRow?.[column]) || 0;
  const previousValue = previousRow ? Number(previousRow[column]) || 0 : null;
  return {
    value,
    change_percent: percentageChange(value, previousValue),
  };
}

router.get('/history', authMiddleware, async (req, res) => {
  const metric = req.query.metric === 'ore' ? 'ore' : 'bytes';
  const filters = buildHistoryFilters(req.query);

  if (!filters) {
    return res.status(400).json({ error: 'Invalid date range, period, or group' });
  }

  const totalExpression = metric === 'ore'
    ? 'SUM(total_bytes::numeric * rate_ore_per_gb_day / 1000000000::numeric)'
    : 'SUM(total_bytes)::numeric / 1000000000::numeric';
  const billableExpression = metric === 'ore'
    ? 'SUM(daily_charge_ore)'
    : 'SUM(billable_bytes)::numeric / 1000000000::numeric';

  try {
    const result = await pool.query(`
      SELECT
        snapshot_date,
        ${totalExpression} AS total_value,
        ${billableExpression} AS billable_value
      FROM group_storage_snapshot
      WHERE ${filters.where}
      GROUP BY snapshot_date
      ORDER BY snapshot_date
    `, filters.values);

    return res.json({
      metric,
      unit: metric === 'ore' ? 'öre/day' : 'GB',
      history: result.rows.map((row) => ({
        date: row.snapshot_date instanceof Date
          ? row.snapshot_date.toISOString().slice(0, 10)
          : row.snapshot_date,
        total: Number(row.total_value) || 0,
        billable: Number(row.billable_value) || 0,
      })),
    });
  } catch (error) {
    console.error('Failed to fetch OMERO storage history:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/groups', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT group_id, group_name
      FROM (
        SELECT DISTINCT ON (group_id) group_id, group_name
        FROM group_storage_snapshot
        ORDER BY group_id, snapshot_date DESC
      ) AS latest_groups
      ORDER BY group_name, group_id
    `);

    return res.json(result.rows.map((row) => ({
      id: String(row.group_id),
      name: row.group_name,
    })));
  } catch (error) {
    console.error('Failed to fetch OMERO groups:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/groups/ranking', authMiddleware, async (req, res) => {
  const comparison = getSummaryComparison(req.query);

  if (!comparison) {
    return res.status(400).json({ error: 'Invalid date range or period' });
  }

  try {
    const result = await pool.query(`
      WITH current_snapshot AS (
        SELECT MAX(snapshot_date) AS snapshot_date
        FROM public.group_storage_snapshot
        WHERE snapshot_date <= ${comparison.currentLimit}
      ),
      comparison_snapshot AS (
        SELECT MAX(snapshot.snapshot_date) AS snapshot_date
        FROM public.group_storage_snapshot AS snapshot
        CROSS JOIN current_snapshot
        WHERE snapshot.snapshot_date <= ${comparison.comparisonTarget}
      )
      SELECT
        current_group.group_id,
        current_group.group_name,
        current_group.snapshot_date,
        comparison_snapshot.snapshot_date AS comparison_date,
        current_group.billable_bytes::numeric / 1000000000::numeric AS billable_gb,
        previous.billable_bytes::numeric / 1000000000::numeric AS previous_billable_gb,
        current_group.billable_fileset_count,
        current_group.daily_charge_ore::numeric / 100::numeric AS daily_charge_sek
      FROM public.group_storage_snapshot AS current_group
      CROSS JOIN current_snapshot
      CROSS JOIN comparison_snapshot
      LEFT JOIN public.group_storage_snapshot AS previous
        ON previous.snapshot_date = comparison_snapshot.snapshot_date
        AND previous.group_id = current_group.group_id
      WHERE current_group.snapshot_date = current_snapshot.snapshot_date
      ORDER BY current_group.billable_bytes DESC, current_group.group_name, current_group.group_id
      LIMIT 10
    `, comparison.values);

    const formatDate = (value) => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString().slice(0, 10) : value;
    };

    return res.json({
      snapshot_date: formatDate(result.rows[0]?.snapshot_date),
      comparison_date: formatDate(result.rows[0]?.comparison_date),
      groups: result.rows.map((row) => {
        const billableGb = Number(row.billable_gb) || 0;
        const previousBillableGb = row.previous_billable_gb === null
          ? null
          : Number(row.previous_billable_gb) || 0;
        return {
          group_id: String(row.group_id),
          group_name: row.group_name,
          billable_gb: billableGb,
          previous_billable_gb: previousBillableGb,
          change_percent: percentageChange(billableGb, previousBillableGb),
          billable_fileset_count: Number(row.billable_fileset_count) || 0,
          daily_charge_sek: Number(row.daily_charge_sek) || 0,
        };
      }),
    });
  } catch (error) {
    console.error('Failed to fetch OMERO group ranking:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/policies', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        policy_id,
        group_id,
        group_name,
        policy_type,
        grace_days,
        billing_grace_days,
        rate_ore_per_gb_day,
        valid_from,
        valid_until,
        notes,
        created_at,
        updated_at,
        CASE
          WHEN valid_from > (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Stockholm')::date
            THEN 'upcoming'
          WHEN valid_until IS NOT NULL
            AND valid_until < (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Stockholm')::date
            THEN 'expired'
          ELSE 'active'
        END AS effective_status
      FROM public.storage_policy
      ORDER BY group_name, group_id, valid_from DESC
    `);

    return res.json({ data: result.rows });
  } catch (error) {
    console.error('Failed to fetch OMERO storage policies:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/policies', authMiddleware, async (req, res) => {
  const normalized = normalizePolicyInput(req.body || {});
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  const policy = normalized.value;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [policy.groupId]);

    const todayResult = await client.query(`
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Stockholm')::date::text AS today
    `);
    if (policy.validFrom < todayResult.rows[0].today) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Effective date cannot be in the past' });
    }

    const historyResult = await client.query(`
      SELECT policy_id, group_name, valid_from::text, valid_until::text
      FROM public.storage_policy
      WHERE group_id = $1::bigint
      ORDER BY valid_from
      FOR UPDATE
    `, [policy.groupId]);

    if (!historyResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No policy history exists for this group' });
    }
    if (historyResult.rows.some((row) => row.valid_from === policy.validFrom)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A policy already starts on this date' });
    }

    const predecessor = [...historyResult.rows]
      .reverse()
      .find((row) => row.valid_from < policy.validFrom);
    const successor = historyResult.rows.find((row) => row.valid_from > policy.validFrom);
    const groupName = historyResult.rows[historyResult.rows.length - 1].group_name;

    if (predecessor) {
      await client.query(`
        UPDATE public.storage_policy
        SET valid_until = $2::date - 1, updated_at = now()
        WHERE policy_id = $1::bigint
      `, [predecessor.policy_id, policy.validFrom]);
    }

    const insertResult = await client.query(`
      INSERT INTO public.storage_policy (
        group_id,
        group_name,
        policy_type,
        grace_days,
        billing_grace_days,
        rate_ore_per_gb_day,
        valid_from,
        valid_until,
        notes
      ) VALUES (
        $1::bigint, $2, $3, $4::int, $5::int, $6::numeric,
        $7::date, $8::date - 1, $9
      )
      RETURNING *
    `, [
      policy.groupId,
      groupName,
      policy.policyType,
      policy.graceDays,
      policy.billingGraceDays,
      policy.rate,
      policy.validFrom,
      successor?.valid_from || null,
      policy.notes,
    ]);

    await client.query('COMMIT');
    return res.status(201).json(insertResult.rows[0]);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Failed to create OMERO storage policy:', error.message);
    if (error.code === '42501') {
      return res.status(403).json({
        error: 'The dashboard database role needs INSERT and UPDATE on storage_policy',
      });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A policy already starts on this date' });
    }
    if (error.code === '23514' || error.code === '22003') {
      return res.status(400).json({ error: 'Policy values violate the storage policy schema' });
    }
    return res.status(500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

router.get('/filesets', authMiddleware, async (req, res) => {
  const filesetQuery = buildFilesetQuery(req.query);

  if (!filesetQuery) {
    return res.status(400).json({ error: 'Invalid fileset filters, pagination, or sorting' });
  }

  const { page, pageSize, values, where, orderBy } = filesetQuery;
  const limitPlaceholder = `$${values.length + 1}`;
  const offsetPlaceholder = `$${values.length + 2}`;
  const dataValues = [...values, pageSize, (page - 1) * pageSize];

  try {
    const [rowsResult, filteredResult, totalResult] = await Promise.all([
      pool.query(`
        SELECT
          f.fileset_id,
          f.username,
          f.firstname,
          f.lastname,
          f.group_id,
          f.group_name,
          f.imported_at,
          f.source_file_count,
          f.image_count,
          f.total_bytes,
          f.deleted_at
        FROM public.omero_fileset AS f
        ${where}
        ORDER BY ${orderBy}
        LIMIT ${limitPlaceholder}::int OFFSET ${offsetPlaceholder}::int
      `, dataValues),
      pool.query(`SELECT COUNT(*)::int AS count FROM public.omero_fileset AS f ${where}`, values),
      pool.query('SELECT COUNT(*)::int AS count FROM public.omero_fileset'),
    ]);

    const filteredTotal = filteredResult.rows[0].count;
    return res.json({
      data: rowsResult.rows,
      page,
      pageSize,
      total: totalResult.rows[0].count,
      filteredTotal,
      totalPages: Math.ceil(filteredTotal / pageSize),
    });
  } catch (error) {
    console.error('Failed to fetch OMERO filesets:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/filesets/:filesetId', authMiddleware, async (req, res) => {
  if (!/^\d+$/.test(req.params.filesetId)) {
    return res.status(400).json({ error: 'Invalid fileset ID' });
  }

  try {
    const result = await pool.query(`
      SELECT
        f.fileset_id,
        f.locations,
        f.first_seen_at,
        f.last_seen_at,
        f.uncontained_image_count,
        f.missing_since_at,
        f.missing_runs,
        f.deleted_at,
        COALESCE((
          SELECT jsonb_agg(entry.value ->> 'name' ORDER BY entry.ordinal)
          FROM jsonb_array_elements(f.source_files)
            WITH ORDINALITY AS entry(value, ordinal)
        ), '[]'::jsonb) AS source_file_names
      FROM public.omero_fileset AS f
      WHERE f.fileset_id = $1::bigint
    `, [req.params.filesetId]);

    if (!result.rows.length) return res.status(404).json({ error: 'Fileset not found' });
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Failed to fetch OMERO fileset details:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/summary', authMiddleware, async (req, res) => {
  const comparison = getSummaryComparison(req.query);

  if (!comparison) {
    return res.status(400).json({ error: 'Invalid date range or period' });
  }

  try {
    const result = await pool.query(`
      WITH current_snapshot AS (
        SELECT MAX(snapshot_date) AS snapshot_date
        FROM group_storage_snapshot
        WHERE snapshot_date <= ${comparison.currentLimit}
      ),
      comparison_snapshot AS (
        SELECT MAX(snapshot.snapshot_date) AS snapshot_date
        FROM group_storage_snapshot AS snapshot
        CROSS JOIN current_snapshot
        WHERE snapshot.snapshot_date <= ${comparison.comparisonTarget}
      ),
      selected_dates AS (
        SELECT snapshot_date, 'current' AS period FROM current_snapshot
        UNION ALL
        SELECT snapshot_date, 'comparison' AS period FROM comparison_snapshot
      )
      SELECT
        selected_dates.period,
        snapshot.snapshot_date,
        SUM(snapshot.fileset_count)::numeric AS fileset_count,
        SUM(snapshot.billable_fileset_count)::numeric AS billable_fileset_count,
        SUM(snapshot.total_bytes)::numeric / 1000000000::numeric AS total_size_gb,
        SUM(CASE
          WHEN snapshot.policy_type = 'AGREEMENT' THEN snapshot.billable_bytes
          ELSE 0
        END)::numeric / 1000000000::numeric AS agreement_billable_size_gb,
        SUM(CASE
          WHEN snapshot.policy_type <> 'AGREEMENT' THEN snapshot.billable_bytes
          ELSE 0
        END)::numeric / 1000000000::numeric AS non_agreement_billable_size_gb,
        SUM(snapshot.overdue_fileset_count)::numeric AS overdue_fileset_count,
        SUM(snapshot.daily_charge_ore)::numeric / 100::numeric AS billable_sek
      FROM selected_dates
      JOIN group_storage_snapshot AS snapshot
        ON snapshot.snapshot_date = selected_dates.snapshot_date
      GROUP BY selected_dates.period, snapshot.snapshot_date
    `, comparison.values);

    const rows = Object.fromEntries(result.rows.map((row) => [row.period, row]));
    const current = rows.current;
    const previous = rows.comparison;
    const formatSnapshotDate = (row) => {
      if (!row) return null;
      return row.snapshot_date instanceof Date
        ? row.snapshot_date.toISOString().slice(0, 10)
        : row.snapshot_date;
    };

    return res.json({
      snapshot_date: formatSnapshotDate(current),
      comparison_date: formatSnapshotDate(previous),
      metrics: {
        fileset_count: metric(current, previous, 'fileset_count'),
        billable_fileset_count: metric(current, previous, 'billable_fileset_count'),
        total_size_gb: metric(current, previous, 'total_size_gb'),
        agreement_billable_size_gb: metric(current, previous, 'agreement_billable_size_gb'),
        non_agreement_billable_size_gb: metric(current, previous, 'non_agreement_billable_size_gb'),
        overdue_fileset_count: metric(current, previous, 'overdue_fileset_count'),
        billable_sek: metric(current, previous, 'billable_sek'),
      },
    });
  } catch (error) {
    console.error('Failed to fetch OMERO storage summary:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

pendingEndpoints.forEach((endpoint) => {
  router.get(endpoint, authMiddleware, (req, res) => {
    res.status(501).json({ error: 'OMERO endpoint not implemented yet' });
  });
});

module.exports = router;
module.exports.buildFilesetQuery = buildFilesetQuery;
module.exports.normalizePolicyInput = normalizePolicyInput;
