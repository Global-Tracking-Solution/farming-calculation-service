import {withConnection} from '../config/database.js';

const toText = value => (Buffer.isBuffer(value) ? value.toString('utf8') : value == null ? undefined : String(value));
const toNumber = value => (value == null || value === '' ? undefined : Number(value));

// The SP may return result sets from the procedures it calls; the GPS rows are the last one.
const lastResultSet = results => {
  if (!Array.isArray(results)) return [];
  const sets = Array.isArray(results[0]) ? results.filter(Array.isArray) : [results];
  return sets[sets.length - 1] || [];
};

// Loads a device's GPS history from usp_history_replay as {latitude, longitude, timeStamp, speed} points.
export const createDeviceDataSource = dbConfig => ({
  loadPoints: (deviceId, fromDate, toDate) => withConnection(dbConfig, async connection => {
    const [results] = await connection.query('CALL usp_history_replay(?, ?, ?)', [deviceId, fromDate, toDate]);
    return lastResultSet(results).map(row => ({
      latitude: toNumber(row.latitude),
      longitude: toNumber(row.longitude),
      timeStamp: toText(row.time_stamp),
      speed: toNumber(row.speed),
    }));
  }),
});
