const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { existsSync } = require('fs');

const { router: authRouter } = require('./middleware/auth');
const omeroRouter = require('./routes/omero');
const summaryRouter = require('./routes/summary');
const uploadsRouter = require('./routes/uploads');
const { createTicketsRouter } = require('./routes/tickets');

const app = express();
const port = process.env.PORT || 8080;
const frontendPath = existsSync(path.join(__dirname, 'frontend'))
  ? path.join(__dirname, 'frontend') : path.join(__dirname, '../frontend');

// OpenShift adds one reverse proxy hop in front of the application.
app.set('trust proxy', 1);
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
});

app.use('/api', limiter);
app.use('/api', authRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/omero', omeroRouter);
app.use('/api/summary', summaryRouter);
app.use('/api/tickets', createTicketsRouter());

app.use('/vendor/datatables', express.static(path.join(__dirname, 'node_modules/datatables.net/js')));
app.use('/vendor/datatables-dt', express.static(path.join(__dirname, 'node_modules/datatables.net-dt/css')));
app.use('/vendor/plotly', express.static(path.join(__dirname, 'node_modules/plotly.js-dist-min')));
app.use(express.static(frontendPath));

app.get(['/uploads', '/omero', '/compute', '/tickets'], (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.get('/:path(*)', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;
