const express = require('express');

const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const pendingEndpoints = [
  '/summary',
  '/history',
  '/groups',
  '/filesets',
  '/policies',
  '/collector-runs',
];

pendingEndpoints.forEach((endpoint) => {
  router.get(endpoint, authMiddleware, (req, res) => {
    res.status(501).json({ error: 'OMERO endpoint not implemented yet' });
  });
});

module.exports = router;
