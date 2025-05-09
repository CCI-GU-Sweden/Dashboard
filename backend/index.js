const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// Serve static files from frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

// Allow CORS so your frontend can fetch data
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/imports', async (req, res) => {
  const { scope = 'all', period = '30', metric = 'file_count' } = req.query;

  // Build WHERE clause
  const filters = [];
  const values = [];

  // Time period: get rows within last N days
  if (period) {
    filters.push(`import_date > NOW() - INTERVAL '${parseInt(period)} days'`);
  }

  // Scope filter (e.g., microscope name)
  if (scope && scope !== 'all') {
    values.push(scope);
    filters.push(`microscope_name = $${values.length}`);
  }

  // Build final SQL
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const metricColumn = (metric === 'total_file_size_mb') ? 'total_file_size_mb' : 'file_count';

  const query = `
    SELECT 
		scope AS microscope_name,
		time AS import_date,
		${metricColumn}
    FROM imports
    ${whereClause}
    ORDER BY import_date DESC
    LIMIT 1000
  `;

  try {
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error('DB Query Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});


// Fallback to index.html for unknown routes (so refresh on subpages works)
app.get('/:path(*)', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});
