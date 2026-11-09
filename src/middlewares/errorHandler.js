import {sendError} from '../utils/response.js';

export const notFound = (_req, res) => sendError(res, 404, 'NOT_FOUND', 'Unknown endpoint');

export const createErrorHandler = config =>
  // eslint-disable-next-line no-unused-vars
  (err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return sendError(res, 413, 'BODY_TOO_LARGE', `Request body larger than ${config.maxBodyMb} MB. Send fewer points.`);
    if (err.type === 'entity.parse.failed') return sendError(res, 400, 'BAD_JSON', 'Request body is not valid JSON');
    console.error(err);
    return sendError(res, 500, 'INTERNAL', 'Internal error');
  };
