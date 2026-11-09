// All settings come from environment variables (or a .env file next to server.js).
import os from 'os';
import {loadDatabaseConfig} from './database.js';

export const VERSION = '1.0.0';

const asBool = (value, fallback) =>
  value == null || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
const asInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const asList = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

export const loadConfig = (env = process.env) => {
  const isProd = env.NODE_ENV === 'production';
  const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const trust = env.TRUST_PROXY ?? (isProd ? '1' : '0');

  return {
    isProd,
    port: asInt(env.PORT, 3000),
    apiKeys: asList(env.API_KEYS || env.API_KEY),
    allowNoAuth: asBool(env.ALLOW_NO_AUTH, false),
    corsOrigins: asList(env.CORS_ORIGINS),
    maxBodyMb: asInt(env.MAX_BODY_MB, 25),
    maxPoints: asInt(env.MAX_POINTS, 200000),
    rateLimitPerMin: asInt(env.RATE_LIMIT_PER_MIN, 60),
    maxConcurrent: asInt(env.MAX_CONCURRENT, Math.max(1, cpus)),
    maxQueue: asInt(env.MAX_QUEUE, 20),
    jobTimeoutMs: asInt(env.JOB_TIMEOUT_SECONDS, 120) * 1000,
    trustProxy: /^\d+$/.test(String(trust)) ? Number(trust) : trust,
    serveTestPage: asBool(env.SERVE_TEST_PAGE, !isProd),
    db: loadDatabaseConfig(env),
  };
};
