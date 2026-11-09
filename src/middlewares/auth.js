import crypto from 'crypto';
import {sendError} from '../utils/response.js';

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest();

// API keys via "X-API-Key: <key>" or "Authorization: Bearer <key>"
export const createAuthMiddleware = config => {
  const keyHashes = config.apiKeys.map(sha256);

  return (req, res, next) => {
    if (!keyHashes.length) {
      return config.isProd && !config.allowNoAuth
        ? sendError(res, 503, 'NO_AUTH_CONFIGURED', 'Server has no API keys configured')
        : next();
    }
    const supplied = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const index = supplied ? keyHashes.findIndex(hash => crypto.timingSafeEqual(hash, sha256(supplied))) : -1;
    if (index < 0) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid API key');
    }
    req.apiClientId = `key${index}`;
    return next();
  };
};
