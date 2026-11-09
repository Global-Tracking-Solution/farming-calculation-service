// Turns whatever the client sends into the point shape the engine understands, and reports problems.
const pick = (object, keys) => {
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
};

const LAT_KEYS = ['latitude', 'lat', 'Latitude', 'Lat', 'LAT', 'LATITUDE'];
const LNG_KEYS = ['longitude', 'lng', 'lon', 'long', 'Longitude', 'Lng', 'Lon', 'Long', 'LNG', 'LONGITUDE'];
const TIME_KEYS = ['timeStamp', 'timestamp', 'TimeStamp', 'Timestamp', 'time', 'Time', 'dateTime', 'DateTime', 'datetime', 'createdAt', 'date', 'Date'];
const SPEED_KEYS = ['speed', 'Speed', 'SPEED', 'vehicleSpeed', 'speedKmh', 'speed_kmh'];
const HEADING_KEYS = ['heading', 'Heading', 'course', 'bearing', 'angle'];

// numbers are epoch seconds / milliseconds; everything else is passed through for the engine to parse
const normalizeTime = value => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const asNumber = typeof value === 'number' ? value : /^\d{9,13}$/.test(String(value).trim()) ? Number(value) : null;
  if (asNumber != null) {
    const millis = asNumber > 1e11 ? asNumber : asNumber * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return String(value).trim();
};

export const normalizeInputPoints = raw => {
  const points = [];
  let invalid = 0;
  let withTime = 0;
  let withSpeed = 0;

  raw.forEach(item => {
    let lat;
    let lng;
    let time;
    let speed;
    let heading;

    if (Array.isArray(item)) {
      [lat, lng, time, speed] = item; // [lat, lng, time?, speed?]
    } else if (item && typeof item === 'object') {
      lat = pick(item, LAT_KEYS);
      lng = pick(item, LNG_KEYS);
      time = pick(item, TIME_KEYS);
      speed = pick(item, SPEED_KEYS);
      heading = pick(item, HEADING_KEYS);
    }

    const latitude = Number(lat);
    const longitude = Number(lng);

    if (
      lat === undefined || lng === undefined ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
      (latitude === 0 && longitude === 0) // (0,0) = "no GPS fix"
    ) {
      invalid += 1;
      return;
    }

    const point = {latitude, longitude};
    const timeStamp = normalizeTime(time);
    if (timeStamp !== undefined) {
      point.timeStamp = timeStamp;
      withTime += 1;
    }
    const speedNumber = Number(speed);
    if (speed !== undefined && speed !== null && speed !== '' && Number.isFinite(speedNumber) && speedNumber >= 0) {
      point.speed = speedNumber;
      withSpeed += 1;
    }
    const headingNumber = Number(heading);
    if (heading !== undefined && heading !== null && heading !== '' && Number.isFinite(headingNumber)) {
      point.heading = headingNumber;
    }
    points.push(point);
  });

  const warnings = [];
  if (invalid) {
    warnings.push(`${invalid} point(s) ignored: missing/invalid latitude-longitude or (0,0).`);
  }
  if (points.length && withTime < points.length * 0.5) {
    warnings.push('Most points have no timestamp. Farming time cannot be calculated and detection is less reliable; send timestamps (with seconds).');
  }
  if (points.length && withSpeed === 0) {
    warnings.push('No speed values sent; speed is estimated from timestamps.');
  }

  return {points, warnings, received: raw.length};
};
