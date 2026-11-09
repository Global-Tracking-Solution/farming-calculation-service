import {VERSION} from '../config/index.js';

// GET /health  (open, no API key)
export const createHealthController = runner => (_req, res) =>
  res.json({ok: true, version: VERSION, uptimeSeconds: Math.round(process.uptime()), ...runner.stats()});

// GET /  (when the test page is off)
export const info = (_req, res) =>
  res.json({name: 'farming-report-api', version: VERSION, endpoint: 'POST /api/v1/farming/analyze'});
