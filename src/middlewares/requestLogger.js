import crypto from 'crypto';

// One JSON line per request (never logs the GPS points themselves)
export const requestLogger = (req, res, next) => {
  const started = Date.now();
  const requestId = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    if (req.path === '/health') return;
    console.log(JSON.stringify({
      t: new Date().toISOString(), id: requestId, method: req.method, path: req.path,
      status: res.statusCode, ms: Date.now() - started, ip: req.ip, points: res.locals.points,
    }));
  });
  next();
};
