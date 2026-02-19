const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const jwt = require('jsonwebtoken');
const app = express();
const port = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';
const SHARED_PASSWORD = process.env.API_TOKEN || 'testtoken';

const rateLimit = require('express-rate-limit');

app.set('trust proxy', true);
app.use(express.json());


function generateScopeColors(scopes) {
	const colors = {};
	const palette = [
	'#4dc9f6', '#f67019', '#f53794', '#537bc4', '#acc236',
	'#166a8f', '#00a950', '#58595b', '#8549ba', '#FF6384',
	'#36A2EB', '#FFCE56', '#9966FF', '#4BC0C0', '#FF9F40'
	];

	scopes.forEach((scope, i) => {
	// Cycle through palette if >15 scopes
	colors[scope] = palette[i % palette.length];
	});

	return colors;
}

// Limit each IP to 100 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.'
});

// Apply to all API routes
app.use('/api', limiter);

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


// Login route
app.post('/api/secure', (req, res) => {
  const { password } = req.body;
  if (password === SHARED_PASSWORD) {
    // Issue a JWT
    const token = jwt.sign({ access: true }, JWT_SECRET, { expiresIn: '1h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Unauthorized' });
});

// Middleware to check JWT
function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.split(' ')[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}


// API endpoint for aggregated stats
app.get('/api/stats', authMiddleware, async (req, res) => {

  const { scope = 'all', period = '30', metric = 'file_count', startDate, endDate } = req.query;

  const periodInt = parseInt(period);
  const filters = [];
  const values = [];
  let i = 1;

  // Use date range if provided, otherwise use period-based logic
  if (startDate && endDate) {
    filters.push(`time >= $${i++} AND time <= $${i++}`);
    values.push(startDate);
    values.push(endDate);
  } else {
    filters.push(`time > NOW() - INTERVAL '${periodInt} days'`);
  }

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
    const totalSize = data.reduce((sum, r) => sum + r.total_file_size_mb, 0) / 1024;
    const userSet = new Set(data.map(r => r.username));
    const avgImportSize = data.length ? totalSize / data.length : 0;
    const totalTime = data.reduce((sum, r) => sum + r.import_time_s, 0);
    const avgTimePerMB = totalSize ? totalTime / totalSize : 0;

    // New metrics: average size per calendar month and average count per calendar month
    const groupedByMonth = {};
    let totalSizeByPeriod = 0;
    let totalCountByPeriod = 0;
    let uniqueMonths = new Set();

    data.forEach(r => {
      const monthKey = r.time.toISOString().slice(0, 7);
      uniqueMonths.add(monthKey);

      if (!groupedByMonth[monthKey]) {
        groupedByMonth[monthKey] = { size: 0, count: 0 };
      }
      groupedByMonth[monthKey].size += r.total_file_size_mb / 1024;
      groupedByMonth[monthKey].count += r.file_count;
      totalSizeByPeriod += r.total_file_size_mb / 1024;
      totalCountByPeriod += r.file_count;
    });

    const avgSizePerPeriod = uniqueMonths.size ? totalSizeByPeriod / uniqueMonths.size : 0;
    const avgCountPerPeriod = uniqueMonths.size ? totalCountByPeriod / uniqueMonths.size : 0;

    // Top scope (file count)
    const scopeFiles = {};
    data.forEach(r => {
      scopeFiles[r.scope] = (scopeFiles[r.scope] || 0) + r.file_count;
    });
    const topScopeFiles = Object.entries(scopeFiles).sort((a, b) => b[1] - a[1])[0];

    // Top scope (size)
    const scopeSize = {};
    data.forEach(r => {
      scopeSize[r.scope] = (scopeSize[r.scope] || 0) + r.total_file_size_mb / 1024;
    });
    const topScopeSize = Object.entries(scopeSize).sort((a, b) => b[1] - a[1])[0];

    // Peak import day
    const dayCounts = {};
    data.forEach(r => {
      const day = r.time.toISOString().slice(0, 10);
      dayCounts[day] = (dayCounts[day] || 0) + r.file_count;
    });
    const peakDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
	
	// Grouped for chart by scope and date
	const groupedByScope = {};
	data.forEach(r => {
	  const date = r.time.toISOString().slice(0, 10);
	  const scope = r.scope;
	  const value = (metricCol === 'total_file_size_mb')
		? r.total_file_size_mb / 1024
		: r.file_count;

	  if (!groupedByScope[scope]) {
		groupedByScope[scope] = {};
	  }
	  groupedByScope[scope][date] = (groupedByScope[scope][date] || 0) + value;
	});

	// Get all unique dates and scopes
	const allDates = [...new Set(data.map(r => r.time.toISOString().slice(0, 10)))].sort();
	const scopes = Object.keys(groupedByScope);

	// Fill missing dates with 0 for each scope
	scopes.forEach(scope => {
	  allDates.forEach(date => {
		groupedByScope[scope][date] = groupedByScope[scope][date] || 0;
	  });
	});

	// Generate dynamic colors for scopes
	const scopeColors = generateScopeColors(scopes);

	// Prepare chart data
	const chartData = {
	  labels: allDates,
	  datasets: scopes.map(scope => ({
		label: scope,
		data: allDates.map(date => groupedByScope[scope][date]),
		backgroundColor: scopeColors[scope],
		borderColor: scopeColors[scope]
	  }))
	};	

    // Previous period change
	let sql = `
	  SELECT
		SUM(CASE
			  WHEN time > NOW() - INTERVAL '${periodInt} days'
			   THEN ${metricCol}
			  ELSE 0
			END) AS current_sum,
		SUM(CASE
			  WHEN time > NOW() - INTERVAL '${periodInt * 2} days'
			   AND time <= NOW() - INTERVAL '${periodInt} days'
			   THEN ${metricCol}
			  ELSE 0
			END) AS previous_sum
	  FROM imports
	  WHERE time > NOW() - INTERVAL '${periodInt * 2} days'
	`;

	let periodchangevalues = [];
	if (scope !== 'all') {
	  sql += ` AND scope = $1`;
	  periodchangevalues.push(scope);
	}

	const periodchangeresult = await pool.query(sql, periodchangevalues);
	const row = periodchangeresult.rows[0] || {};
	const current_sum = Number(row.current_sum) || 0;
	const previous_sum = Number(row.previous_sum) || 0;

	let periodChange = 0;
	if (previous_sum == 0 && current_sum > 0) periodChange = 100;
	else if (previous_sum == 0) periodChange = 0;
	else periodChange = ((current_sum - previous_sum) / previous_sum) * 100;

    // Final response
    res.json({
      total_files: totalFiles,
      total_size_mb: totalSize.toFixed(2),
      unique_users: userSet.size,
      avg_import_size: avgImportSize.toFixed(2),
      avg_time_per_mb: avgTimePerMB.toFixed(3),
      avg_size_per_period: avgSizePerPeriod.toFixed(2),
      avg_count_per_period: avgCountPerPeriod.toFixed(2),
      top_scope_files: topScopeFiles ? { name: topScopeFiles[0], count: topScopeFiles[1] } : null,
      top_scope_size: topScopeSize ? { name: topScopeSize[0], size_mb: topScopeSize[1].toFixed(2) } : null,
      peak_day: peakDay ? { date: peakDay[0], count: peakDay[1] } : null,
      period_change: periodChange.toFixed(1),
      chart_data: chartData
    });
  } catch (err) {
    console.error('DB Query Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scopes', authMiddleware, async (req, res) => {

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
