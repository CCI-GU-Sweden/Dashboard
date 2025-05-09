const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.API_TOKEN || 'mytesttoken';

// Serve static frontend
app.use(express.static(path.join(__dirname, 'frontend')));

// PostgreSQL pool
const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

// API endpoint for aggregated stats
app.get('/api/stats', async (req, res) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { scope = 'all', period = '30', metric = 'file_count' } = req.query;

  const filters = [];
  const values = [];
  let i = 1;

  filters.push(`time > NOW() - INTERVAL '${parseInt(period)} days'`);

  if (scope !== 'all') {
    filters.push(`scope = $${i++}`);
    values.push(scope);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const metricCol = (metric === 'total_file_size_mb') ? 'total_file_size_mb' : 'file_count';

  try {
    // Query all filtered rows for processing
    const rawQuery = `
      SELECT scope, time, username, file_count, total_file_size_mb, import_time_s
      FROM imports
      ${where}
    `;
    const result = await pool.query(rawQuery, values);
    const data = result.rows;

    // Calculate stats
    const totalFiles = data.reduce((sum, r) => sum + r.file_count, 0);
    const totalSize = data.reduce((sum, r) => sum + r.total_file_size_mb, 0);
    const userSet = new Set(data.map(r => r.username));
    const avgImportSize = data.length ? totalSize / data.length : 0;
    const totalTime = data.reduce((sum, r) => sum + r.import_time_s, 0);
    const avgTimePerMB = totalSize ? totalTime / totalSize : 0;

    // Top scope (file count)
    const scopeFiles = {};
    data.forEach(r => {
      scopeFiles[r.scope] = (scopeFiles[r.scope] || 0) + r.file_count;
    });
    const topScopeFiles = Object.entries(scopeFiles).sort((a, b) => b[1] - a[1])[0];

    // Top scope (size)
    const scopeSize = {};
    data.forEach(r => {
      scopeSize[r.scope] = (scopeSize[r.scope] || 0) + r.total_file_size_mb;
    });
    const topScopeSize = Object.entries(scopeSize).sort((a, b) => b[1] - a[1])[0];

    // Peak import day
    const dayCounts = {};
    data.forEach(r => {
      const day = r.time.toISOString().slice(0, 10);
      dayCounts[day] = (dayCounts[day] || 0) + r.file_count;
    });
    const peakDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];

    // Grouped for chart
    const grouped = {};
    data.forEach(r => {
      const date = r.time.toISOString().slice(0, 10);
      grouped[date] = (grouped[date] || 0) + r[metricCol];
    });
    const labels = Object.keys(grouped).sort();
    const valuesChart = labels.map(l => grouped[l]);

    // Period change calc
    const now = new Date();
    const currentStart = new Date(now);
    currentStart.setDate(currentStart.getDate() - period);
    const previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - period);

    const current = data.filter(r => {
      const d = new Date(r.time);
      return d >= currentStart && d <= now;
    });
    const previous = data.filter(r => {
      const d = new Date(r.time);
      return d >= previousStart && d < currentStart;
    });

    const currentSum = current.reduce((s, r) => s + r.file_count, 0);
    const previousSum = previous.reduce((s, r) => s + r.file_count, 0);
    let periodChange = 0;
    if (previousSum === 0 && currentSum > 0) periodChange = 100;
    else if (previousSum === 0) periodChange = 0;
    else periodChange = ((currentSum - previousSum) / previousSum) * 100;

    // Final response
    res.json({
      total_files: totalFiles,
      total_size_mb: totalSize.toFixed(2),
      unique_users: userSet.size,
      avg_import_size: avgImportSize.toFixed(2),
      avg_time_per_mb: avgTimePerMB.toFixed(3),
      top_scope_files: topScopeFiles ? { name: topScopeFiles[0], count: topScopeFiles[1] } : null,
      top_scope_size: topScopeSize ? { name: topScopeSize[0], size_mb: topScopeSize[1].toFixed(2) } : null,
      peak_day: peakDay ? { date: peakDay[0], count: peakDay[1] } : null,
      period_change: periodChange.toFixed(1),
      chart_data: {
        labels: labels,
        values: valuesChart,
        label: metric === 'file_count' ? 'Files Imported' : 'Data Imported (MB)'
      }
    });
  } catch (err) {
    console.error('DB Query Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scopes', async (req, res) => {
  const token = req.headers['authorization'];
  if (token !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await pool.query(`
      SELECT DISTINCT scope
      FROM imports
      ORDER BY scope
    `);
    const scopes = result.rows.map(r => r.scope);
    res.json(scopes);
  } catch (err) {
    console.error('Failed to fetch scopes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all for frontend routes
app.get('/:path(*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
