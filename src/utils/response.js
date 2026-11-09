// Every error response has the same shape: {status: false, code, message, ...extra}
export const sendError = (res, status, code, message, extra = {}) =>
  res.status(status).json({status: false, code, message, ...extra});
