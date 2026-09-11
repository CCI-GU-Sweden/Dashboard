const express = require('express');

const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const pendingEndpoints = [
  '/summary',
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

pendingEndpoints.forEach((endpoint) => {
  router.get(endpoint, authMiddleware, (req, res) => {
    res.status(501).json({ error: 'OMERO endpoint not implemented yet' });
  });
});

module.exports = router;
