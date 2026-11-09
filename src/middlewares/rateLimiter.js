import {rateLimit, ipKeyGenerator} from 'express-rate-limit';
import {sendError} from '../utils/response.js';

// Per API key (or per client IP when auth is off), per minute
export const createRateLimiter = config => rateLimit({
  windowMs: 60 * 1000,
  limit: config.rateLimitPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.apiClientId || ipKeyGenerator(req.ip),
  handler: (_req, res) => sendError(res, 429, 'RATE_LIMITED', 'Too many requests, slow down'),
});
