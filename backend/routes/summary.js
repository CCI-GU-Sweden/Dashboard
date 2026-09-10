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

router.get('/', authMiddleware, async (req, res) => {
  const period = getDefaultPeriod();

  try {
    const result = await pool.query(`
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
    `, [period.from, period.to]);

    const uploads = result.rows[0] || {};

    return res.json({
      period,
      uploads: {
        count: Number(uploads.count) || 0,
        total_bytes: Number(uploads.total_bytes) || 0,
        top_microscope: uploads.top_microscope || null,
      },
    });
  } catch (error) {
    console.error('Failed to fetch dashboard summary:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
