const express = require('express');

const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const pendingEndpoints = [
  '/filesets',
  '/policies',
  '/collector-runs',
];

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
