const express = require('express');

const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function generateScopeColors(scopes) {
  const colors = {};
  const palette = [
    '#4dc9f6', '#f67019', '#f53794', '#537bc4', '#acc236',
    '#166a8f', '#00a950', '#58595b', '#8549ba', '#FF6384',
    '#36A2EB', '#FFCE56', '#9966FF', '#4BC0C0', '#FF9F40',
  ];

  scopes.forEach((scope, index) => {
    colors[scope] = palette[index % palette.length];
  });

  return colors;
}

function getPeriod(value) {
  const period = Number.parseInt(value ?? '30', 10);
  return Number.isInteger(period) && period > 0 ? period : null;
}

function buildUploadFilters(query) {
  const { scope = 'all', startDate, endDate } = query;
  const filters = [];
  const values = [];

  if (startDate && endDate) {
    values.push(startDate, endDate);
    filters.push(`time >= $${values.length - 1} AND time <= $${values.length}`);
  } else {
    const period = getPeriod(query.period);
    if (period === null) return null;
    values.push(period);
    filters.push(`time > NOW() - ($${values.length} * INTERVAL '1 day')`);
  }

  if (scope !== 'all') {
    values.push(scope);
    filters.push(`scope = $${values.length}`);
  }

  return {
    period: getPeriod(query.period),
    values,
    where: `WHERE ${filters.join(' AND ')}`,
  };
}

function buildChartData(data, metricColumn) {
  const groupedByScope = {};

  data.forEach((row) => {
    const date = row.time.toISOString().slice(0, 10);
    const value = metricColumn === 'total_file_size_mb'
      ? Number(row.total_file_size_mb) / 1024
      : Number(row.file_count);

    if (!groupedByScope[row.scope]) groupedByScope[row.scope] = {};
    groupedByScope[row.scope][date] = (groupedByScope[row.scope][date] || 0) + value;
  });

  const labels = [...new Set(data.map((row) => row.time.toISOString().slice(0, 10)))].sort();
  const scopes = Object.keys(groupedByScope);
  const scopeColors = generateScopeColors(scopes);

  return {
    labels,
    datasets: scopes.map((scope) => ({
      label: scope,
      data: labels.map((date) => groupedByScope[scope][date] || 0),
      backgroundColor: scopeColors[scope],
      borderColor: scopeColors[scope],
    })),
  };
}

async function loadUploadRows(filters) {
  const result = await pool.query(`
    SELECT scope, time, username, file_count, total_file_size_mb, import_time_s
    FROM imports
    ${filters.where}
  `, filters.values);

  return result.rows;
}

async function getPeriodChange(scope, period, metricColumn) {
  if (period === null) return 0;

  const values = [period];
  let scopeFilter = '';

  if (scope !== 'all') {
    values.push(scope);
    scopeFilter = `AND scope = $${values.length}`;
  }

  const result = await pool.query(`
    SELECT
      SUM(CASE
        WHEN time > NOW() - ($1 * INTERVAL '1 day') THEN ${metricColumn}
        ELSE 0
      END) AS current_sum,
      SUM(CASE
        WHEN time > NOW() - (($1 * 2) * INTERVAL '1 day')
          AND time <= NOW() - ($1 * INTERVAL '1 day') THEN ${metricColumn}
        ELSE 0
      END) AS previous_sum
    FROM imports
    WHERE time > NOW() - (($1 * 2) * INTERVAL '1 day')
    ${scopeFilter}
  `, values);

  const row = result.rows[0] || {};
  const currentSum = Number(row.current_sum) || 0;
  const previousSum = Number(row.previous_sum) || 0;

  if (previousSum === 0) return currentSum > 0 ? 100 : 0;
  return ((currentSum - previousSum) / previousSum) * 100;
}

router.get('/summary', authMiddleware, async (req, res) => {
  const filters = buildUploadFilters(req.query);
  if (!filters) return res.status(400).json({ error: 'period must be a positive integer' });

  const { scope = 'all', metric = 'file_count', startDate, endDate } = req.query;
  const metricColumn = metric === 'total_file_size_mb' ? 'total_file_size_mb' : 'file_count';

  try {
    const data = await loadUploadRows(filters);
    const totalFiles = data.reduce((sum, row) => sum + Number(row.file_count), 0);
    const totalSize = data.reduce((sum, row) => sum + Number(row.total_file_size_mb), 0) / 1024;
    const uniqueUsers = new Set(data.map((row) => row.username));
    const avgImportSize = data.length ? totalSize / data.length : 0;
    const totalTime = data.reduce((sum, row) => sum + Number(row.import_time_s), 0);
    const avgTimePerMB = totalSize ? totalTime / totalSize : 0;
    const groupedByMonth = {};

    data.forEach((row) => {
      const month = row.time.toISOString().slice(0, 7);
      if (!groupedByMonth[month]) groupedByMonth[month] = { size: 0, count: 0 };
      groupedByMonth[month].size += Number(row.total_file_size_mb) / 1024;
      groupedByMonth[month].count += Number(row.file_count);
    });

    const monthCount = Object.keys(groupedByMonth).length;
    const scopeFiles = {};
    const scopeSizes = {};
    const dayCounts = {};

    data.forEach((row) => {
      const day = row.time.toISOString().slice(0, 10);
      scopeFiles[row.scope] = (scopeFiles[row.scope] || 0) + Number(row.file_count);
      scopeSizes[row.scope] = (scopeSizes[row.scope] || 0) + Number(row.total_file_size_mb) / 1024;
      dayCounts[day] = (dayCounts[day] || 0) + Number(row.file_count);
    });

    const topScopeFiles = Object.entries(scopeFiles).sort((a, b) => b[1] - a[1])[0];
    const topScopeSize = Object.entries(scopeSizes).sort((a, b) => b[1] - a[1])[0];
    const peakDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
    const periodChange = startDate && endDate
      ? 0
      : await getPeriodChange(scope, filters.period, metricColumn);

    return res.json({
      total_files: totalFiles,
      total_size_mb: totalSize.toFixed(2),
      unique_users: uniqueUsers.size,
      avg_import_size: avgImportSize.toFixed(2),
      avg_time_per_mb: avgTimePerMB.toFixed(3),
      avg_size_per_period: (monthCount ? totalSize / monthCount : 0).toFixed(2),
      avg_count_per_period: (monthCount ? totalFiles / monthCount : 0).toFixed(2),
      top_scope_files: topScopeFiles ? { name: topScopeFiles[0], count: topScopeFiles[1] } : null,
      top_scope_size: topScopeSize ? { name: topScopeSize[0], size_mb: topScopeSize[1].toFixed(2) } : null,
      peak_day: peakDay ? { date: peakDay[0], count: peakDay[1] } : null,
      period_change: periodChange.toFixed(1),
      chart_data: buildChartData(data, metricColumn),
    });
  } catch (error) {
    console.error('DB Query Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/history', authMiddleware, async (req, res) => {
  const filters = buildUploadFilters(req.query);
  if (!filters) return res.status(400).json({ error: 'period must be a positive integer' });

  const metricColumn = req.query.metric === 'total_file_size_mb'
    ? 'total_file_size_mb'
    : 'file_count';

  try {
    const data = await loadUploadRows(filters);
    return res.json(buildChartData(data, metricColumn));
  } catch (error) {
    console.error('Failed to fetch upload history:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

async function listScopes(req, res) {
  try {
    const result = await pool.query(`
      SELECT DISTINCT scope
      FROM imports
      ORDER BY scope
    `);
    return res.json(result.rows.map((row) => row.scope));
  } catch (error) {
    console.error('Failed to fetch scopes:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

router.get('/scopes', authMiddleware, listScopes);

// In the current upload schema, a scope identifies the microscope.
router.get('/microscopes', authMiddleware, listScopes);

module.exports = router;
