// Shapes the engine result into a compact, front-end friendly API response.
const SQFT_PER_SQM = 10.7639;
const FEET_PER_METER = 3.28084;

const round = (value, digits) => {
  if (value == null || !Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const vertex = point => ({latitude: round(point.latitude, 7), longitude: round(point.longitude, 7)});

const withExtraUnits = (byUnit, squareFeet) => ({
  acres: round(byUnit.acres, 4),
  guntha: round(byUnit.guntha, 2),
  bigha: round(byUnit.bigha, 3),
  squareFeet: round(squareFeet, 0),
  squareMeters: round(squareFeet / SQFT_PER_SQM, 1),
  hectares: round(squareFeet / SQFT_PER_SQM / 10000, 4),
});
const roundValues = object => object && Object.fromEntries(Object.entries(object).map(([key, value]) => [key, round(value, 7)]));

const formatArea = (area, {includePoints}) => {
  // dropped on purpose: `points` (raw GPS, large; opt in with includePoints), `rectangle` (same as polygon)
  const {points, rectangle, adjustedAreaSquareFeet, areaSquareFeet, ...rest} = area;
  const out = {
    ...rest,
    polygon: area.polygon.map(vertex),
    center: vertex(area.center),
    bounds: roundValues(area.bounds),
    region: roundValues(area.region),
    widthFeet: round(area.widthFeet, 1),
    heightFeet: round(area.heightFeet, 1),
    pathLengthFeet: round(area.pathLengthFeet || 0, 1),
    areaSquareMeters: round(adjustedAreaSquareFeet / SQFT_PER_SQM, 1),
    areaByUnit: withExtraUnits(area.areaByUnit, adjustedAreaSquareFeet),
    farmingTime: {seconds: area.activeDurationSeconds, label: area.activeDuration},
    widthMeters: round(area.widthFeet / FEET_PER_METER, 1),
    heightMeters: round(area.heightFeet / FEET_PER_METER, 1),
    pathLengthMeters: round((area.pathLengthFeet || 0) / FEET_PER_METER, 1),
  };
  if (includePoints) {
    out.points = (points || []).map(point => ({
      ...vertex(point),
      timeStamp: point.timeStamp,
      speed: point.speedKmh ?? point.speed,
    }));
  }
  return out;
};

export const formatResult = (result, {includePoints = false, includePath = false} = {}, extra = {}) => {
  const warnings = [...(extra.warnings || [])];
  if (result.reordered) {
    warnings.push('Points were not in time order; they were sorted by timestamp.');
  }
  if (result.droppedWithoutTime) {
    warnings.push(`${result.droppedWithoutTime} point(s) without timestamp were dropped while sorting by time.`);
  }

  const data = {
    summary: {
      areaCount: result.areaCount,
      totalArea: withExtraUnits(result.totalByUnit, result.totalAreaSquareFeet),
      totalFarmingTime: {seconds: result.totalActiveDurationSeconds, label: result.totalActiveDuration},
      dataFrom: result.dataFrom,
      dataTo: result.dataTo,
      pointsReceived: extra.received ?? result.totalPoints,
      pointsUsed: result.totalPoints,
    },
    areas: result.areas.map(area => formatArea(area, {includePoints})),
    byDate: result.byDate.map(day => ({...day, totalByUnit: withExtraUnits(day.totalByUnit, day.totalByUnit.squareFeet)})),
    availableDates: result.availableDates,
    selectedDate: result.selectedDate,
    detectionMode: result.detectionMode,
    sampling: result.sampling,
    // kept at top level too, so existing screens/test page keep working
    areaCount: result.areaCount,
    totalPoints: result.totalPoints,
    totalByUnit: withExtraUnits(result.totalByUnit, result.totalAreaSquareFeet),
    totalAreaSquareFeet: round(result.totalAreaSquareFeet, 0),
    totalActiveDuration: result.totalActiveDuration,
    totalActiveDurationSeconds: result.totalActiveDurationSeconds,
    dataFrom: result.dataFrom,
    dataTo: result.dataTo,
  };
  if (includePath) {
    data.path = result.path.map(([lat, lng]) => [round(lat, 7), round(lng, 7)]);
  }
  return {status: true, data, warnings};
};
