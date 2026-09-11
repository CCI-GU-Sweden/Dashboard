const express = require('express');

const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const to = new Date();
  const from = new Date(to);
  const targetMonth = from.getUTCMonth() - 1;
  const day = from.getUTCDate();

  from.setUTCDate(1);
  from.setUTCMonth(targetMonth);
  const lastDayOfTargetMonth = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  from.setUTCDate(Math.min(day, lastDayOfTargetMonth));

  return { from: formatDate(from), to: formatDate(to) };
}

function percentageChange(current, previous) {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function overviewMetric(currentRow, previousRow, column) {
  const value = Number(currentRow?.[column]) || 0;
  const previousValue = previousRow ? Number(previousRow[column]) || 0 : null;
  return {
    value,
    change_percent: percentageChange(value, previousValue),
  };
}

function snapshotDate(row) {
  if (!row) return null;
  return row.snapshot_date instanceof Date
    ? row.snapshot_date.toISOString().slice(0, 10)
    : row.snapshot_date;
}

router.get('/', authMiddleware, async (req, res) => {
  const period = getDefaultPeriod();

  try {
    const [uploadResult, omeroResult] = await Promise.all([
      pool.query(`
        WITH period_uploads AS (
          SELECT scope, file_count, total_file_size_mb
          FROM imports
          WHERE time >= $1::date
            AND time < ($2::date + INTERVAL '1 day')
        )
        SELECT
          COALESCE(SUM(file_count), 0)::bigint AS count,
          COALESCE(ROUND(SUM(total_file_size_mb) * 1048576), 0)::bigint AS total_bytes,
          (
            SELECT scope
            FROM period_uploads
            GROUP BY scope
            ORDER BY SUM(file_count) DESC, scope
            LIMIT 1
          ) AS top_microscope
        FROM period_uploads
      `, [period.from, period.to]),
      pool.query(`
        WITH current_snapshot AS (
          SELECT MAX(snapshot_date) AS snapshot_date
          FROM group_storage_snapshot
          WHERE snapshot_date <= CURRENT_DATE
        ),
        comparison_snapshot AS (
          SELECT MAX(snapshot.snapshot_date) AS snapshot_date
          FROM group_storage_snapshot AS snapshot
          CROSS JOIN current_snapshot
          WHERE snapshot.snapshot_date <= current_snapshot.snapshot_date - INTERVAL '1 month'
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
          SUM(snapshot.total_bytes)::numeric / 1000000000::numeric AS total_size_gb,
          SUM(snapshot.daily_charge_ore)::numeric / 100::numeric AS billable_sek
        FROM selected_dates
        JOIN group_storage_snapshot AS snapshot
          ON snapshot.snapshot_date = selected_dates.snapshot_date
        GROUP BY selected_dates.period, snapshot.snapshot_date
      `),
    ]);

    const uploads = uploadResult.rows[0] || {};
    const omeroRows = Object.fromEntries(
      omeroResult.rows.map((row) => [row.period, row]),
    );
    const currentOmero = omeroRows.current;
    const previousOmero = omeroRows.comparison;

    return res.json({
      period,
      uploads: {
        count: Number(uploads.count) || 0,
        total_bytes: Number(uploads.total_bytes) || 0,
        top_microscope: uploads.top_microscope || null,
      },
      omero: {
        snapshot_date: snapshotDate(currentOmero),
        comparison_date: snapshotDate(previousOmero),
        fileset_count: overviewMetric(currentOmero, previousOmero, 'fileset_count'),
        total_size_gb: overviewMetric(currentOmero, previousOmero, 'total_size_gb'),
        billable_sek: overviewMetric(currentOmero, previousOmero, 'billable_sek'),
      },
    });
  } catch (error) {
    console.error('Failed to fetch dashboard summary:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
