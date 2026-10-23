const { Pool } = require('pg');
const existingPool = require('./db');

let ticketPool;

function getTicketPool() {
  if (process.env.PGUSER === 'filestats_collector'
      && !process.env.TICKET_PGUSER && !process.env.TICKET_PGPASSWORD) return existingPool;
  if (!process.env.TICKET_PGUSER || !process.env.TICKET_PGPASSWORD) {
    const error = new Error('Ticket database access is not configured. Map TICKET_PGUSER and TICKET_PGPASSWORD from filestats-collector-secret.');
    error.status = 503;
    throw error;
  }
  if (!ticketPool) {
    ticketPool = new Pool({
      host: process.env.PGHOST,
      port: process.env.PGPORT,
      database: process.env.PGDATABASE,
      user: process.env.TICKET_PGUSER,
      password: process.env.TICKET_PGPASSWORD,
      connectionTimeoutMillis: 10000,
      max: 5,
    });
  }
  return ticketPool;
}

module.exports = { getTicketPool };
