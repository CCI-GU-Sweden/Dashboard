const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port =  = process.env.PORT || 8080;

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

// Simple endpoint to get all imports
app.get('/imports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM imports');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${port}`);
});


// Fallback to index.html for unknown routes (so refresh on subpages works)
app.get('/:path(*)', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});
