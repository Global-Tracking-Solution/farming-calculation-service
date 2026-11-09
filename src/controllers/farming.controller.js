import {VERSION} from '../config/index.js';
import {normalizeInputPoints} from '../services/farming/inputNormalizer.js';
import {formatResult} from '../services/farming/responseFormatter.js';
import {RunnerError} from '../services/jobRunner.js';
import {validateAnalyzeRequest, validateDeviceRequest} from '../validators/farming.validator.js';
import {sendError} from '../utils/response.js';

// POST /api/v1/farming/analyze
// Input is either `points` (sent by the client) or `deviceId` + `fromDate` + `toDate` (loaded from MySQL).
export const createAnalyzeController = ({config, runner, deviceData}) => async (req, res) => {
  const started = Date.now();
  const body = req.body || {};
  const {farmingPercent = 0, date = null, mode = 'auto', includePoints = false, includePath = false} = body;
  let {points} = body;

  const deviceId = body.deviceId ?? body.deviceid;
  if (deviceId !== undefined) {
    const device = validateDeviceRequest({deviceId, fromDate: body.fromDate ?? body.fromdate, toDate: body.toDate ?? body.todate});
    if (device.error) {
      return sendError(res, device.error.status, device.error.code, device.error.message);
    }
    if (!deviceData) {
      return sendError(res, 503, 'DB_NOT_CONFIGURED', 'Database is not configured on the server (DB_HOST)');
    }
    try {
      points = await deviceData.loadPoints(device.deviceId, device.fromDate, device.toDate);
    } catch (error) {
      console.error('device data load failed:', error?.message);
      return sendError(res, 502, 'DB_ERROR', 'Could not load GPS data for this device');
    }
    if (!points.length) {
      return sendError(res, 404, 'NO_DATA', `No GPS records for device ${device.deviceId} between ${device.fromDate} and ${device.toDate}`);
    }
  }

  const invalid = validateAnalyzeRequest({points, farmingPercent, date, mode}, config);
  if (invalid) {
    return sendError(res, invalid.status, invalid.code, invalid.message);
  }

  const normalized = normalizeInputPoints(points);
  res.locals.points = normalized.received;
  if (normalized.points.length < 2) {
    return sendError(res, 422, 'NOT_ENOUGH_POINTS', 'Fewer than 2 valid latitude/longitude points', {warnings: normalized.warnings});
  }

  try {
    const result = await runner.run({points: normalized.points, farmingPercent: Number(farmingPercent), date: date || null, mode});
    const response = formatResult(result, {includePoints: !!includePoints, includePath: !!includePath},
      {warnings: normalized.warnings, received: normalized.received});
    response.meta = {processingMs: Date.now() - started, version: VERSION};
    return res.json(response);
  } catch (error) {
    if (error instanceof RunnerError && error.code === 'BUSY') {
      res.setHeader('Retry-After', '5');
      return sendError(res, 503, 'BUSY', error.message);
    }
    if (error instanceof RunnerError && error.code === 'TIMEOUT') {
      return sendError(res, 504, 'TIMEOUT', `${error.message}. Send fewer points (e.g. one day at a time).`);
    }
    console.error('analysis failed:', error?.message);
    return sendError(res, 500, 'ANALYSIS_FAILED', 'Analysis failed');
  }
};
