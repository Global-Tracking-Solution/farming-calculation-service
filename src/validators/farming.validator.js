const MODES = ['auto', 'dense', 'sparse'];

const isValidDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

// '2026-10-12' or '2026-10-12 06:30' or '2026-10-12 06:30:00' (also with 'T') -> 'YYYY-MM-DD HH:mm:ss'
const toDateTime = (value, endOfDay) => {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value ?? '').trim());
  if (!match || !isValidDate(match[1])) return null;
  const [, day, hh, mm, ss] = match;
  if (hh === undefined) return `${day} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  if (+hh > 23 || +mm > 59 || +(ss || 0) > 59) return null;
  return `${day} ${hh}:${mm}:${ss || '00'}`;
};

// Checks deviceId / fromDate / toDate. Returns {error} or {deviceId, fromDate, toDate} ready for the SP.
export const validateDeviceRequest = ({deviceId, fromDate, toDate}) => {
  const id = Number(deviceId);
  if (!Number.isInteger(id) || id <= 0) {
    return {error: {status: 400, code: 'BAD_REQUEST', message: '`deviceId` must be a positive whole number'}};
  }
  const from = toDateTime(fromDate, false);
  const to = toDateTime(toDate, true);
  if (!from || !to) {
    return {error: {status: 400, code: 'BAD_REQUEST', message: '`fromDate` and `toDate` must look like 2026-10-12 00:00:00'}};
  }
  if (from > to) {
    return {error: {status: 400, code: 'BAD_REQUEST', message: '`fromDate` must be before `toDate`'}};
  }
  return {deviceId: id, fromDate: from, toDate: to};
};

// Checks the POST /analyze body. Returns {status, code, message} for the first problem, or null if valid.
export const validateAnalyzeRequest = ({points, farmingPercent, date, mode}, {maxPoints}) => {
  if (!Array.isArray(points) || points.length === 0) {
    return {status: 400, code: 'BAD_REQUEST', message: '`points` must be a non-empty array'};
  }
  if (points.length > maxPoints) {
    return {status: 413, code: 'TOO_MANY_POINTS', message: `Maximum ${maxPoints} points per request (got ${points.length}). Split by day.`};
  }
  const percent = Number(farmingPercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return {status: 400, code: 'BAD_REQUEST', message: '`farmingPercent` must be a number from 0 to 100'};
  }
  if (date != null && date !== '' && !isValidDate(date)) {
    return {status: 400, code: 'BAD_REQUEST', message: '`date` must look like 2026-11-02'};
  }
  if (!MODES.includes(mode)) {
    return {status: 400, code: 'BAD_REQUEST', message: '`mode` must be auto, dense or sparse'};
  }
  return null;
};
