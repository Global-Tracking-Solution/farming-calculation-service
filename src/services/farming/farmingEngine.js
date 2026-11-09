// Farming-area detection engine (ported from the React Native FarmingReport screen).
// Entry point: analyzeFarming(points, farmingPercent, date, mode).
import moment from 'moment';

const EARTH_RADIUS_METERS = 6371000;
const SQ_FEET_PER_SQ_METER = 10.7639;
const SQ_FEET_PER_GUNTHA = 1089;
const SQ_FEET_PER_ACRE = 43560;
const SQ_FEET_PER_BIGHA = 27225;
// Smallest patch size the app will report as a farming area. Tune this
// single constant to change the floor - everything else (area, width,
// height checks) derives from it or is set to stay consistent with it.
const MIN_FARMING_GUNTHA = 1;

const AREA_UNIT_TYPES = {
  ACRES: 'acres',
  GUNTHA: 'guntha',
  BIGHA: 'bigha',
  SQUARE_FEET: 'square_feet',
};

const convertSquareFeetToUnitValue = (areaSquareFeet, unitType) => {
  const safeArea = Number(areaSquareFeet) || 0;

  switch (unitType) {
    case AREA_UNIT_TYPES.GUNTHA:
      return safeArea / SQ_FEET_PER_GUNTHA;
    case AREA_UNIT_TYPES.BIGHA:
      return safeArea / SQ_FEET_PER_BIGHA;
    case AREA_UNIT_TYPES.SQUARE_FEET:
      return safeArea;
    case AREA_UNIT_TYPES.ACRES:
    default:
      return safeArea / SQ_FEET_PER_ACRE;
  }
};

const adjustAreaForFarmingPercent = (areaSquareFeet, farmingPercent) => {
  const rawArea = Number(areaSquareFeet) || 0;
  const percent = Number(farmingPercent) || 0;

  if (percent <= 0 || rawArea <= 0) {
    return rawArea;
  }

  return rawArea * (1 - percent / 100);
};
const MIN_FARMING_AREA_SQ_FEET = MIN_FARMING_GUNTHA * SQ_FEET_PER_GUNTHA;
const WINDOW_RADIUS = 8;
const MIN_WINDOW_POINTS = 10;
const MAX_CLASSIFICATION_GAP = 3;
const MIN_FARMING_POINTS = 14;
const MIN_FARMING_AREA_SQ_METERS = 80; // stays below the ~101 sqm floor set by MIN_FARMING_GUNTHA
const MAX_FARMING_AREA_SQ_METERS = 150000;
const LOCAL_REVISIT_RADIUS_METERS = 18;
const MIN_INDEX_SEPARATION = 6;
const MIN_NEIGHBOR_REVISITS = 4;
const SEGMENT_PADDING_POINTS = 0;
const CLUSTER_LINK_DISTANCE_METERS = 20;
const MAX_CLUSTER_LINK_DISTANCE_METERS = 60;
const MAX_FARMING_SPEED_KMH = 8;
const MIN_FARMING_POINT_RATIO = 0.5;
const MIN_FARMING_REVISIT_FACTOR = 2.2;
const MIN_DENSE_REVISIT_SCORE = 5;
const MIN_CLUSTER_POINTS = 8;
const MIN_TURN_DEGREES = 100;
const MAX_CLUSTER_INDEX_GAP = 15;
const MAX_CLUSTER_POINT_STEP_METERS = 45;
const MAX_CLUSTER_TIME_GAP_SECONDS = 180;
const MERGE_AREA_MAX_TIME_GAP_SECONDS = 3600;
const MERGE_AREA_MAX_CENTER_DISTANCE_METERS = 160;
const HULL_NEIGHBOR_RADIUS_METERS = 18;
const MIN_HULL_NEIGHBORS = 2;
const MIN_HULL_POINT_COVERAGE_RATIO = 0.92;
const COORDINATE_EPSILON = 1e-7;
const DEFAULT_IMPLEMENT_HALF_WIDTH_METERS = 1.9;
const MIN_IMPLEMENT_HALF_WIDTH_METERS = 1.0;
const MAX_IMPLEMENT_HALF_WIDTH_METERS = 3.0;
const DEFAULT_GRID_CELL_METERS = 1;
const MAX_GRID_CELLS = 50000;
const MIN_COVERAGE_CELLS = 20;
// Anything narrower than ~2 x (NECK_OPENING_FACTOR x implement half-width) is
// treated as a connecting strip (tractor driving between plots), not a field.
// Raise it to cut thicker connectors; lower it if real narrow plots get cut.
const NECK_OPENING_FACTOR = 2.0;

const toRadians = value => (value * Math.PI) / 180;

const normalizeHeading = value => {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return null;
  }

  return ((parsedValue % 360) + 360) % 360;
};

const calculateDistanceMeters = (startLat, startLng, endLat, endLng) => {
  const latDiff = toRadians(endLat - startLat);
  const lngDiff = toRadians(endLng - startLng);
  const startLatRad = toRadians(startLat);
  const endLatRad = toRadians(endLat);

  const haversine =
    Math.sin(latDiff / 2) * Math.sin(latDiff / 2) +
    Math.cos(startLatRad) *
      Math.cos(endLatRad) *
      Math.sin(lngDiff / 2) *
      Math.sin(lngDiff / 2);

  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
};

const calculateBearing = (startLat, startLng, endLat, endLng) => {
  const startLatRad = toRadians(startLat);
  const endLatRad = toRadians(endLat);
  const deltaLng = toRadians(endLng - startLng);
  const y = Math.sin(deltaLng) * Math.cos(endLatRad);
  const x =
    Math.cos(startLatRad) * Math.sin(endLatRad) -
    Math.sin(startLatRad) * Math.cos(endLatRad) * Math.cos(deltaLng);

  return (Math.atan2(y, x) * 180) / Math.PI + 360;
};

const getHeadingDifference = (firstHeading, secondHeading) => {
  const difference = Math.abs(firstHeading - secondHeading) % 360;
  return difference > 180 ? 360 - difference : difference;
};

const projectPointToMeters = (point, originPoint) => {
  const latitudeRadians = toRadians((point.latitude + originPoint.latitude) / 2);
  const x =
    EARTH_RADIUS_METERS *
    toRadians(point.longitude - originPoint.longitude) *
    Math.cos(latitudeRadians);
  const y =
    EARTH_RADIUS_METERS * toRadians(point.latitude - originPoint.latitude);

  return {x, y};
};

const unprojectPointFromMeters = (x, y, originPoint) => {
  const latitude =
    originPoint.latitude + (y / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const latitudeRadians = toRadians((latitude + originPoint.latitude) / 2);
  const longitude =
    originPoint.longitude +
    (x / (EARTH_RADIUS_METERS * Math.cos(latitudeRadians))) * (180 / Math.PI);

  return {latitude, longitude};
};

const buildCoordinateCentroid = coordinates => {
  if (!coordinates?.length) {
    return null;
  }

  const latitude =
    coordinates.reduce((sum, point) => sum + point.latitude, 0) /
    coordinates.length;
  const longitude =
    coordinates.reduce((sum, point) => sum + point.longitude, 0) /
    coordinates.length;

  return {latitude, longitude};
};

const areSameCoordinate = (firstCoordinate, secondCoordinate) =>
  Math.abs(firstCoordinate.latitude - secondCoordinate.latitude) <=
    COORDINATE_EPSILON &&
  Math.abs(firstCoordinate.longitude - secondCoordinate.longitude) <=
    COORDINATE_EPSILON;

const sanitizePolygonCoordinates = coordinates => {
  if (!coordinates?.length) {
    return [];
  }

  const sanitized = [];

  coordinates.forEach(coordinate => {
    if (
      !Number.isFinite(coordinate?.latitude) ||
      !Number.isFinite(coordinate?.longitude)
    ) {
      return;
    }

    const previousCoordinate = sanitized[sanitized.length - 1];

    if (
      previousCoordinate &&
      areSameCoordinate(previousCoordinate, coordinate)
    ) {
      return;
    }

    sanitized.push({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
    });
  });

  if (sanitized.length > 2) {
    const firstCoordinate = sanitized[0];
    const lastCoordinate = sanitized[sanitized.length - 1];

    if (areSameCoordinate(firstCoordinate, lastCoordinate)) {
      sanitized.pop();
    }
  }

  return sanitized.length >= 3 ? sanitized : [];
};

const getGridCellKey = (row, col) => `${row},${col}`;

const estimateImplementHalfWidthMeters = projectedPoints => {
  const stepDistances = [];

  for (let index = 1; index < projectedPoints.length; index += 1) {
    const previousPoint = projectedPoints[index - 1];
    const currentPoint = projectedPoints[index];
    const stepDistance = Math.hypot(
      currentPoint.x - previousPoint.x,
      currentPoint.y - previousPoint.y,
    );

    if (stepDistance >= 0.5 && stepDistance <= 40) {
      stepDistances.push(stepDistance);
    }
  }

  if (!stepDistances.length) {
    return DEFAULT_IMPLEMENT_HALF_WIDTH_METERS;
  }

  const medianStep = calculateMedian(stepDistances);
  // Using a smaller fraction of the GPS step distance keeps the coverage
  // buffer tied closer to the true path instead of ballooning out when
  // GPS fixes are spaced further apart (which is a ping-rate artifact,
  // not a reflection of implement width).
  const estimatedHalfWidth = Math.min(
    medianStep * 0.09,
    MAX_IMPLEMENT_HALF_WIDTH_METERS,
  );

  return Math.max(MIN_IMPLEMENT_HALF_WIDTH_METERS, estimatedHalfWidth);
};

const getAdaptiveGridCellSize = (widthMeters, heightMeters) => {
  let cellSize = DEFAULT_GRID_CELL_METERS;

  while (
    Math.ceil(widthMeters / cellSize) * Math.ceil(heightMeters / cellSize) >
      MAX_GRID_CELLS &&
    cellSize < 8
  ) {
    cellSize += 0.5;
  }

  return cellSize;
};

const markCoverageDiskOnGrid = (
  grid,
  pointX,
  pointY,
  minX,
  minY,
  cellSize,
  halfWidthMeters,
) => {
  const centerCol = Math.floor((pointX - minX) / cellSize);
  const centerRow = Math.floor((pointY - minY) / cellSize);
  const radiusCells = Math.ceil(halfWidthMeters / cellSize);

  for (let rowOffset = -radiusCells; rowOffset <= radiusCells; rowOffset += 1) {
    for (
      let colOffset = -radiusCells;
      colOffset <= radiusCells;
      colOffset += 1
    ) {
      const cellCenterX = minX + (centerCol + colOffset + 0.5) * cellSize;
      const cellCenterY = minY + (centerRow + rowOffset + 0.5) * cellSize;

      if (
        Math.hypot(cellCenterX - pointX, cellCenterY - pointY)
    <= halfWidthMeters + (cellSize * 0.30)
      ) {
        grid.add(getGridCellKey(centerRow + rowOffset, centerCol + colOffset));
      }
    }
  }
};

const rasterizeCoverageSegmentOnGrid = (
  grid,
  startPoint,
  endPoint,
  minX,
  minY,
  cellSize,
  halfWidthMeters,
) => {
  const segmentDistance = Math.hypot(
    endPoint.x - startPoint.x,
    endPoint.y - startPoint.y,
  );
  const interpolationSteps = Math.max(
    1,
    Math.ceil(segmentDistance / (cellSize * 0.25)),
  );

  for (let step = 0; step <= interpolationSteps; step += 1) {
    const ratio = step / interpolationSteps;
    markCoverageDiskOnGrid(
      grid,
      startPoint.x + (endPoint.x - startPoint.x) * ratio,
      startPoint.y + (endPoint.y - startPoint.y) * ratio,
      minX,
      minY,
      cellSize,
      halfWidthMeters,
    );
  }
};

// How many grid cells deep a notch/gap can be and still get filled by the
// closing pass below. Small headland/turn gaps (where the vehicle moves
// fast and consecutive GPS fixes are far apart, so the coverage disks
// don't fully overlap) are usually 1-2 cells - this fills those without
// meaningfully changing the true outer shape or area.
const COVERAGE_CLOSE_RADIUS_CELLS = 2;

const dilateCoverageGrid = (grid, radiusCells) => {
  const dilated = new Set();

  grid.forEach(cellKey => {
    const [rowValue, colValue] = cellKey.split(',').map(Number);

    for (let rowOffset = -radiusCells; rowOffset <= radiusCells; rowOffset += 1) {
      for (let colOffset = -radiusCells; colOffset <= radiusCells; colOffset += 1) {
        dilated.add(getGridCellKey(rowValue + rowOffset, colValue + colOffset));
      }
    }
  });

  return dilated;
};

const erodeCoverageGrid = (grid, radiusCells) => {
  const eroded = new Set();

  grid.forEach(cellKey => {
    const [rowValue, colValue] = cellKey.split(',').map(Number);
    let allNeighborsCovered = true;

    for (
      let rowOffset = -radiusCells;
      rowOffset <= radiusCells && allNeighborsCovered;
      rowOffset += 1
    ) {
      for (let colOffset = -radiusCells; colOffset <= radiusCells; colOffset += 1) {
        if (!grid.has(getGridCellKey(rowValue + rowOffset, colValue + colOffset))) {
          allNeighborsCovered = false;
          break;
        }
      }
    }

    if (allNeighborsCovered) {
      eroded.add(cellKey);
    }
  });

  return eroded;
};

// Morphological closing: dilate then erode by the same radius. This fills
// small gaps/notches in the coverage grid (real holes left by imperfect
// disk-stamping around turns) while leaving the overall outer boundary
// essentially where it was - unlike RDP, which only straightens the
// vertices of whatever shape it's given and can't fill a hole.
const closeCoverageGridGaps = (grid, radiusCells) => {
  if (radiusCells <= 0) {
    return grid;
  }

  const dilated = dilateCoverageGrid(grid, radiusCells);
  return erodeCoverageGrid(dilated, radiusCells);
};

const getProjectedPointKey = point =>
  `${point.x.toFixed(3)},${point.y.toFixed(3)}`;

// Cyclic clockwise order of the 4 axis-aligned directions in a y-down
// (screen/map) coordinate system: facing right, a clockwise turn faces
// down, then left, then up, then back to right.
const DIRECTION_RIGHT = 0;
const DIRECTION_DOWN = 1;
const DIRECTION_LEFT = 2;
const DIRECTION_UP = 3;

const getUnitDirectionIndex = (dx, dy) => {
  if (dx > 0) return DIRECTION_RIGHT;
  if (dy > 0) return DIRECTION_DOWN;
  if (dx < 0) return DIRECTION_LEFT;
  return DIRECTION_UP;
};

// Chains the grid-cell boundary edges into a single outer ring.
//
// Each covered cell emits its 4 edges in a consistent clockwise direction
// (see buildContourPolygonFromGrid), so the edge set already encodes which
// side is "inside" the covered region. Where the coverage narrows to ~1
// cell wide (a thin corridor/tail), opposite sides of the boundary can
// meet at the same grid vertex, creating a 4-way junction. A naive
// undirected walk can jump across that junction onto the wrong branch and
// loop back to the start early - silently truncating the polygon before
// it reaches the rest of the corridor.
//
// To avoid that, this keeps edges directed and, at every vertex, prefers
// the sharpest available right turn relative to the direction just
// traveled (falling back to straight, then left, then a U-turn). This is
// the standard "right-hand rule" used for tracing the outer boundary of a
// raster/grid region: it always keeps the covered region on the walker's
// right, so it can't cut across a pinch point onto an unrelated branch.
const chainBoundaryEdgesToPolygon = edges => {
  if (!edges.length) {
    return [];
  }

  const directedAdjacency = new Map();

  edges.forEach(edge => {
    const startKey = getProjectedPointKey(edge.a);
    const endKey = getProjectedPointKey(edge.b);
    const directionIndex = getUnitDirectionIndex(
      edge.b.x - edge.a.x,
      edge.b.y - edge.a.y,
    );

    if (!directedAdjacency.has(startKey)) {
      directedAdjacency.set(startKey, []);
    }

    directedAdjacency.get(startKey).push({
      point: edge.b,
      key: endKey,
      directionIndex,
    });
  });

  let startKey = null;
  let startPoint = null;

  directedAdjacency.forEach((_, key) => {
    const [xValue, yValue] = key.split(',').map(Number);

    if (
      !startPoint ||
      yValue < startPoint.y ||
      (yValue === startPoint.y && xValue < startPoint.x)
    ) {
      startPoint = {x: xValue, y: yValue};
      startKey = key;
    }
  });

  if (!startKey || !startPoint) {
    return [];
  }

  const polygon = [startPoint];
  let currentKey = startKey;
  // The start vertex is the topmost-then-leftmost point, a true convex
  // corner of the outer boundary. Seeding the "incoming" direction as UP
  // means the first right-turn preference resolves to RIGHT, which is the
  // correct direction to begin a clockwise trace along the top edge.
  let previousDirectionIndex = DIRECTION_UP;
  const maxSteps = edges.length * 2 + 8;

  for (let step = 0; step < maxSteps; step += 1) {
    const outgoing = directedAdjacency.get(currentKey);

    if (!outgoing || !outgoing.length) {
      break;
    }

    const turnPriority = [
      (previousDirectionIndex + 1) % 4, // sharpest right turn
      previousDirectionIndex, // straight on
      (previousDirectionIndex + 3) % 4, // left turn
      (previousDirectionIndex + 2) % 4, // U-turn (last resort)
    ];

    let nextNeighbor = null;
    for (let priorityIndex = 0; priorityIndex < turnPriority.length; priorityIndex += 1) {
      nextNeighbor = outgoing.find(
        neighbor => neighbor.directionIndex === turnPriority[priorityIndex],
      );
      if (nextNeighbor) {
        break;
      }
    }

    if (!nextNeighbor) {
      nextNeighbor = outgoing[0];
    }

    if (nextNeighbor.key === startKey && polygon.length >= 3) {
      break;
    }

    polygon.push(nextNeighbor.point);
    previousDirectionIndex = nextNeighbor.directionIndex;
    currentKey = nextNeighbor.key;
  }

  return polygon;
};

const perpendicularDistanceMeters = (point, lineStart, lineEnd) => {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  }

  const t =
    ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) /
    lengthSquared;
  const clampedT = Math.max(0, Math.min(1, t));
  const closestX = lineStart.x + clampedT * dx;
  const closestY = lineStart.y + clampedT * dy;

  return Math.hypot(point.x - closestX, point.y - closestY);
};

// Ramer-Douglas-Peucker simplification. Straightens the staircase produced
// by tracing grid-cell edges into the diagonal lines it's approximating,
// while still keeping genuine corners (any point that deviates from the
// straight line by more than `tolerance` is kept).
const simplifyPointsRDP = (points, tolerance) => {
  if (!points || points.length < 3) {
    return points || [];
  }

  let maxDistance = 0;
  let maxIndex = 0;
  const lineStart = points[0];
  const lineEnd = points[points.length - 1];

  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistanceMeters(
      points[index],
      lineStart,
      lineEnd,
    );
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = index;
    }
  }

  if (maxDistance > tolerance) {
    const left = simplifyPointsRDP(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyPointsRDP(points.slice(maxIndex), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [lineStart, lineEnd];
};

const doSegmentsIntersect = (p1, p2, p3, p4) => {
  const d1 = crossProduct(p3, p4, p1);
  const d2 = crossProduct(p3, p4, p2);
  const d3 = crossProduct(p1, p2, p3);
  const d4 = crossProduct(p1, p2, p4);

  const straddles1 = (d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0);
  const straddles2 = (d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0);

  return straddles1 && straddles2;
};

// RDP can turn a concave ring into a self-intersecting (bowtie) one, which
// react-native-maps' <Polygon> can silently fail to draw at all (area calc
// stays correct since that's derived from the grid, but nothing renders).
// This checks every pair of non-adjacent edges for crossings.
const isSimplePolygonRing = points => {
  const pointCount = points.length;

  if (pointCount < 4) {
    return true;
  }

  for (let i = 0; i < pointCount; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % pointCount];

    for (let j = i + 1; j < pointCount; j += 1) {
      const isAdjacent =
        j === i || (j + 1) % pointCount === i || i === (j + 1) % pointCount;

      if (isAdjacent) {
        continue;
      }

      const b1 = points[j];
      const b2 = points[(j + 1) % pointCount];

      if (doSegmentsIntersect(a1, a2, b1, b2)) {
        return false;
      }
    }
  }

  return true;
};

// Runs RDP on a closed ring (polygon) instead of an open path: temporarily
// re-closes the ring so the first/last vertex is treated like any other
// edge, then drops the duplicated closing point from the result. Falls
// back to the original ring if simplification breaks it into a
// self-intersecting shape, so a boundary never silently disappears.
const simplifyPolygonRDP = (polygonPoints, tolerance) => {
  if (!polygonPoints || polygonPoints.length < 4 || tolerance <= 0) {
    return polygonPoints || [];
  }

  const closedRing = [...polygonPoints, polygonPoints[0]];
  const simplified = simplifyPointsRDP(closedRing, tolerance);
  simplified.pop();

  if (simplified.length < 3) {
    return polygonPoints;
  }

  return isSimplePolygonRing(simplified) ? simplified : polygonPoints;
};

const buildContourPolygonFromGrid = (grid, minX, minY, cellSize) => {
  const boundaryEdges = [];

  grid.forEach(cellKey => {
    const [rowValue, colValue] = cellKey.split(',').map(Number);
    const leftX = minX + colValue * cellSize;
    const topY = minY + rowValue * cellSize;
    const rightX = leftX + cellSize;
    const bottomY = topY + cellSize;

    if (!grid.has(getGridCellKey(rowValue - 1, colValue))) {
      boundaryEdges.push({
        a: {x: leftX, y: topY},
        b: {x: rightX, y: topY},
      });
    }
    if (!grid.has(getGridCellKey(rowValue, colValue + 1))) {
      boundaryEdges.push({
        a: {x: rightX, y: topY},
        b: {x: rightX, y: bottomY},
      });
    }
    if (!grid.has(getGridCellKey(rowValue + 1, colValue))) {
      boundaryEdges.push({
        a: {x: rightX, y: bottomY},
        b: {x: leftX, y: bottomY},
      });
    }
    if (!grid.has(getGridCellKey(rowValue, colValue - 1))) {
      boundaryEdges.push({
        a: {x: leftX, y: bottomY},
        b: {x: leftX, y: topY},
      });
    }
  });

  return chainBoundaryEdgesToPolygon(boundaryEdges);
};

const buildClosedCoverageGrid = (projectedPoints, implementHalfWidth, segmentPairs = null) => {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  projectedPoints.forEach(point => {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  });

  const padding = implementHalfWidth + 0.5;
  minX -= padding;
  maxX += padding;
  minY -= padding;
  maxY += padding;

  const cellSize = getAdaptiveGridCellSize(maxX - minX, maxY - minY);
  const coverageGrid = new Set();

  projectedPoints.forEach(point => {
    markCoverageDiskOnGrid(coverageGrid, point.x, point.y, minX, minY, cellSize, implementHalfWidth);
  });

  // segmentPairs (optional): explicit [indexA, indexB] passes. Used by sparse mode,
  // where consecutive GPS points are NOT always one continuous pass.
  const pairs = segmentPairs
    || projectedPoints.slice(0, -1).map((_, index) => [index, index + 1]);

  pairs.forEach(([firstIndex, secondIndex]) => {
    rasterizeCoverageSegmentOnGrid(
      coverageGrid,
      projectedPoints[firstIndex],
      projectedPoints[secondIndex],
      minX,
      minY,
      cellSize,
      implementHalfWidth,
    );
  });

  if (coverageGrid.size < MIN_COVERAGE_CELLS) {
    return {closedCoverageGrid: null, minX, minY, cellSize};
  }

  return {
    closedCoverageGrid: closeCoverageGridGaps(coverageGrid, COVERAGE_CLOSE_RADIUS_CELLS),
    minX,
    minY,
    cellSize,
  };
};

const buildPathCoverageFromCoordinates = (coordinates, options = {}) => {
  const farmingCoordinates = options.skipSpeedFilter
    ? coordinates || []
    : (coordinates || []).filter(point => {
        const speedKmh = getPointSpeedKmh(point);
        return speedKmh == null || speedKmh <= MAX_FARMING_SPEED_KMH;
      });

  if (farmingCoordinates.length < 2) {
    return null;
  }

  const centroid = buildCoordinateCentroid(farmingCoordinates);

  if (!centroid) {
    return null;
  }

  const projectedPoints = farmingCoordinates.map(point => {
    const projected = projectPointToMeters(point, centroid);
    return {x: projected.x, y: projected.y};
  });

  if (projectedPoints.length < 2) {
    return null;
  }

  const implementHalfWidth =
    options.implementHalfWidth ?? estimateImplementHalfWidthMeters(projectedPoints);
  const {closedCoverageGrid, minX, minY, cellSize} = buildClosedCoverageGrid(
    projectedPoints,
    implementHalfWidth,
    options.segmentPairs || null,
  );

  if (!closedCoverageGrid) {
    return null;
  }

  const areaSquareMeters = closedCoverageGrid.size * cellSize * cellSize;
  const rawContourPoints = buildContourPolygonFromGrid(
    closedCoverageGrid,
    minX,
    minY,
    cellSize,
  );
  // The raw contour follows individual grid-cell edges (axis-aligned only),
  // which is what produces the zigzag/staircase look. A tolerance around
  // 1-1.5 cell widths straightens those steps into the diagonal they were
  // approximating without losing real corners. Raise the multiplier for
  // straighter (but less precise) edges, lower it to hug the raw coverage
  // more closely.
  const contourPoints = simplifyPolygonRDP(rawContourPoints, cellSize * 1.25);
  const boundaryCellCenters = [];

  closedCoverageGrid.forEach(cellKey => {
    const [rowValue, colValue] = cellKey.split(',').map(Number);
    const isBoundaryCell = [
      [rowValue - 1, colValue],
      [rowValue + 1, colValue],
      [rowValue, colValue - 1],
      [rowValue, colValue + 1],
    ].some(([row, col]) => !closedCoverageGrid.has(getGridCellKey(row, col)));

    if (isBoundaryCell) {
      boundaryCellCenters.push({
        x: minX + (colValue + 0.5) * cellSize,
        y: minY + (rowValue + 0.5) * cellSize,
      });
    }
  });

  const metricsPoints =
    rawContourPoints.length >= 3
      ? rawContourPoints
      : buildConcaveHull(
          filterSparseHullPoints(
            dedupeProjectedPoints(
              boundaryCellCenters.length >= 3
                ? boundaryCellCenters
                : projectedPoints,
            ),
          ),
        );
  // Width/height (and anything else used for size-based filtering) are
  // measured from the raw contour, not the simplified one. RDP shaves a
  // roughly fixed amount (~cellSize) off the boundary to straighten it;
  // that's a negligible fraction of a large field but can be a big enough
  // fraction of a SMALL field to push it under the minimum width/height
  // thresholds and get it silently rejected. The rendered polygon can
  // still use the straightened version - only the measurements need the
  // unsimplified shape.
  const renderPoints = contourPoints.length >= 3 ? contourPoints : metricsPoints;
  const polygon = sanitizePolygonCoordinates(
    renderPoints.map(point =>
      unprojectPointFromMeters(point.x, point.y, centroid),
    ),
  );

  if (polygon.length < 3) {
    return null;
  }

  return {
    centroid,
    hullPoints: metricsPoints,
    polygon,
    areaSquareMeters,
    implementHalfWidth,
  };
};

const crossProduct = (origin, first, second) =>
  (first.x - origin.x) * (second.y - origin.y) -
  (first.y - origin.y) * (second.x - origin.x);

const buildConvexHull = points => {
  if (!points || points.length <= 1) {
    return points || [];
  }

  const sortedPoints = [...points].sort((first, second) =>
    first.x === second.x ? first.y - second.y : first.x - second.x,
  );
  const lowerHull = [];

  sortedPoints.forEach(point => {
    while (
      lowerHull.length >= 2 &&
      crossProduct(
        lowerHull[lowerHull.length - 2],
        lowerHull[lowerHull.length - 1],
        point,
      ) <= 0
    ) {
      lowerHull.pop();
    }
    lowerHull.push(point);
  });

  const upperHull = [];
  for (let index = sortedPoints.length - 1; index >= 0; index -= 1) {
    const point = sortedPoints[index];
    while (
      upperHull.length >= 2 &&
      crossProduct(
        upperHull[upperHull.length - 2],
        upperHull[upperHull.length - 1],
        point,
      ) <= 0
    ) {
      upperHull.pop();
    }
    upperHull.push(point);
  }

  lowerHull.pop();
  upperHull.pop();
  return [...lowerHull, ...upperHull];
};

const HULL_POINT_EPSILON = 1e-6;

const areSameProjectedPoint = (firstPoint, secondPoint) =>
  Math.abs(firstPoint.x - secondPoint.x) <= HULL_POINT_EPSILON &&
  Math.abs(firstPoint.y - secondPoint.y) <= HULL_POINT_EPSILON;

const dedupeProjectedPoints = points => {
  const uniquePoints = [];

  points.forEach(point => {
    const exists = uniquePoints.some(existingPoint =>
      areSameProjectedPoint(existingPoint, point),
    );

    if (!exists) {
      uniquePoints.push(point);
    }
  });

  return uniquePoints;
};

const calculateProjectedDistanceSquared = (firstPoint, secondPoint) => {
  const dx = firstPoint.x - secondPoint.x;
  const dy = firstPoint.y - secondPoint.y;
  return dx * dx + dy * dy;
};

const getKNearestProjectedPoints = (points, referencePoint, nearestCount) =>
  [...points]
    .filter(point => !areSameProjectedPoint(point, referencePoint))
    .sort(
      (firstPoint, secondPoint) =>
        calculateProjectedDistanceSquared(firstPoint, referencePoint) -
        calculateProjectedDistanceSquared(secondPoint, referencePoint),
    )
    .slice(0, nearestCount);

const normalizeAngle = angleValue => {
  const fullTurn = Math.PI * 2;
  return ((angleValue % fullTurn) + fullTurn) % fullTurn;
};

const orientationSign = (firstPoint, secondPoint, thirdPoint) => {
  const value =
    (secondPoint.y - firstPoint.y) * (thirdPoint.x - secondPoint.x) -
    (secondPoint.x - firstPoint.x) * (thirdPoint.y - secondPoint.y);

  if (Math.abs(value) <= HULL_POINT_EPSILON) {
    return 0;
  }

  return value > 0 ? 1 : -1;
};

const isProjectedPointOnSegment = (segmentStart, segmentEnd, point) => {
  const minX = Math.min(segmentStart.x, segmentEnd.x) - HULL_POINT_EPSILON;
  const maxX = Math.max(segmentStart.x, segmentEnd.x) + HULL_POINT_EPSILON;
  const minY = Math.min(segmentStart.y, segmentEnd.y) - HULL_POINT_EPSILON;
  const maxY = Math.max(segmentStart.y, segmentEnd.y) + HULL_POINT_EPSILON;

  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
};

const doProjectedSegmentsIntersect = (firstStart, firstEnd, secondStart, secondEnd) => {
  const firstOrientation = orientationSign(firstStart, firstEnd, secondStart);
  const secondOrientation = orientationSign(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientationSign(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientationSign(secondStart, secondEnd, firstEnd);

  if (
    firstOrientation !== secondOrientation &&
    thirdOrientation !== fourthOrientation
  ) {
    return true;
  }

  if (
    firstOrientation === 0 &&
    isProjectedPointOnSegment(firstStart, firstEnd, secondStart)
  ) {
    return true;
  }
  if (
    secondOrientation === 0 &&
    isProjectedPointOnSegment(firstStart, firstEnd, secondEnd)
  ) {
    return true;
  }
  if (
    thirdOrientation === 0 &&
    isProjectedPointOnSegment(secondStart, secondEnd, firstStart)
  ) {
    return true;
  }
  if (
    fourthOrientation === 0 &&
    isProjectedPointOnSegment(secondStart, secondEnd, firstEnd)
  ) {
    return true;
  }

  return false;
};

const isProjectedPointInPolygon = (point, polygon) => {
  let isInside = false;

  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previousIndex];

    if (isProjectedPointOnSegment(previousPoint, currentPoint, point)) {
      return true;
    }

    const intersects =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y + Number.EPSILON) +
          currentPoint.x;

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
};

const buildConcaveHull = (points, initialNearestCount = 4) => {
  const uniquePoints = dedupeProjectedPoints(points || []);

  if (uniquePoints.length < 4) {
    return buildConvexHull(uniquePoints);
  }

  let nearestCount = Math.min(
    Math.max(initialNearestCount, 3),
    uniquePoints.length - 1,
  );

  while (nearestCount < uniquePoints.length) {
    const hull = [];
    const remainingPoints = [...uniquePoints];
    let currentPoint = remainingPoints.reduce((candidate, point) => {
      if (point.y < candidate.y) {
        return point;
      }
      if (point.y === candidate.y && point.x < candidate.x) {
        return point;
      }
      return candidate;
    }, remainingPoints[0]);
    let previousPoint = {x: currentPoint.x - 1, y: currentPoint.y};

    hull.push(currentPoint);
    remainingPoints.splice(
      remainingPoints.findIndex(point => areSameProjectedPoint(point, currentPoint)),
      1,
    );

    let step = 2;
    let restartWithHigherK = false;
    const maxIterations = uniquePoints.length * 4;

    while (
      (!areSameProjectedPoint(currentPoint, hull[0]) || step === 2) &&
      remainingPoints.length > 0 &&
      step <= maxIterations
    ) {
      if (step === 5) {
        remainingPoints.push(hull[0]);
      }

      const previousAngle = normalizeAngle(
        Math.atan2(previousPoint.y - currentPoint.y, previousPoint.x - currentPoint.x),
      );
      const nearestPoints = getKNearestProjectedPoints(
        remainingPoints,
        currentPoint,
        nearestCount,
      );

      const sortedCandidates = nearestPoints.sort((firstPoint, secondPoint) => {
        const firstAngle = normalizeAngle(
          Math.atan2(firstPoint.y - currentPoint.y, firstPoint.x - currentPoint.x),
        );
        const secondAngle = normalizeAngle(
          Math.atan2(secondPoint.y - currentPoint.y, secondPoint.x - currentPoint.x),
        );
        const firstDifference = normalizeAngle(previousAngle - firstAngle);
        const secondDifference = normalizeAngle(previousAngle - secondAngle);
        return firstDifference - secondDifference;
      });

      const validCandidate = sortedCandidates.find(candidatePoint => {
        if (
          areSameProjectedPoint(candidatePoint, hull[0]) &&
          hull.length < 3
        ) {
          return false;
        }

        const startIndex = areSameProjectedPoint(candidatePoint, hull[0]) ? 1 : 0;

        for (let edgeIndex = hull.length - 1; edgeIndex >= startIndex + 1; edgeIndex -= 1) {
          const edgeStart = hull[edgeIndex - 1];
          const edgeEnd = hull[edgeIndex];

          if (
            doProjectedSegmentsIntersect(edgeStart, edgeEnd, currentPoint, candidatePoint)
          ) {
            return false;
          }
        }

        return true;
      });

      if (!validCandidate) {
        restartWithHigherK = true;
        break;
      }

      previousPoint = currentPoint;
      currentPoint = validCandidate;
      hull.push(currentPoint);

      const removeIndex = remainingPoints.findIndex(point =>
        areSameProjectedPoint(point, currentPoint),
      );
      if (removeIndex >= 0) {
        remainingPoints.splice(removeIndex, 1);
      }

      step += 1;
    }

    if (
      restartWithHigherK ||
      hull.length < 4 ||
      !areSameProjectedPoint(hull[hull.length - 1], hull[0])
    ) {
      nearestCount += 1;
      continue;
    }

    hull.pop();
    const pointsInsideCount = uniquePoints.filter(point =>
      isProjectedPointInPolygon(point, hull),
    ).length;
    const coverageRatio = pointsInsideCount / uniquePoints.length;

    if (coverageRatio >= MIN_HULL_POINT_COVERAGE_RATIO && hull.length >= 3) {
      return hull;
    }

    nearestCount += 1;
  }

  return buildConvexHull(uniquePoints);
};

const getPointTimestamp = point =>
  point?.timeStamp ||
  point?.timestamp ||
  point?.TimeStamp ||
  point?.dateTime ||
  point?.DateTime ||
  point?.createdAt ||
  null;

// Parsing a date string with moment is slow and the same strings are read many
// times per request, so remember the result (bounded so memory stays small).
const timestampMillisCache = new Map();

const getPointTimestampMillis = point => {
  const pointTimestamp = getPointTimestamp(point);

  if (!pointTimestamp) {
    return null;
  }

  const cacheKey = typeof pointTimestamp === 'string' ? pointTimestamp : null;

  if (cacheKey !== null && timestampMillisCache.has(cacheKey)) {
    return timestampMillisCache.get(cacheKey);
  }

  const parsedMoment = getValidMoment(pointTimestamp);
  const millis = parsedMoment ? parsedMoment.valueOf() : null;

  if (cacheKey !== null) {
    if (timestampMillisCache.size > 200000) {
      timestampMillisCache.clear();
    }
    timestampMillisCache.set(cacheKey, millis);
  }

  return millis;
};

const getAreaTimeBoundsMillis = area => {
  const timestamps = (area?.points || [])
    .map(point => getPointTimestampMillis(point))
    .filter(value => value != null && Number.isFinite(value));

  if (!timestamps.length) {
    return {startMillis: null, endMillis: null};
  }

  return {
    startMillis: Math.min(...timestamps),
    endMillis: Math.max(...timestamps),
  };
};

const getValidMoment = value => {
  const parsedMoment = moment(value, [
    'YYYY-MM-DD HH:mm:ss',
    'YYYY-MM-DD HH:mm',
    'DD-MM-YYYY hh:mm A',
    moment.ISO_8601,
  ], true);

  if (parsedMoment.isValid()) {
    return parsedMoment;
  }

  const fallbackMoment = moment(value);
  return fallbackMoment.isValid() ? fallbackMoment : null;
};

const parseCoordinate = value => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
};

const parseSpeedKmh = value => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : null;
};

const getPointSpeedKmh = point =>
  parseSpeedKmh(point?.speedKmh ?? point?.speed ?? point?.Speed ?? point?.vehicleSpeed);

const calculateDerivedSpeedKmh = (previousPoint, currentPoint) => {
  const previousTimestamp = getPointTimestampMillis(previousPoint);
  const currentTimestamp = getPointTimestampMillis(currentPoint);

  if (previousTimestamp == null || currentTimestamp == null) {
    return null;
  }

  const elapsedSeconds = Math.abs(currentTimestamp - previousTimestamp) / 1000;

  if (elapsedSeconds < 1) {
    return null;
  }

  const distanceMeters = calculateDistanceMeters(
    previousPoint.latitude,
    previousPoint.longitude,
    currentPoint.latitude,
    currentPoint.longitude,
  );

  return (distanceMeters / elapsedSeconds) * 3.6;
};

const isRoadTransitPoint = (point, revisitScore = 0) => {
  const speedKmh = getPointSpeedKmh(point);

  if (speedKmh != null && speedKmh > MAX_FARMING_SPEED_KMH) {
    return true;
  }

  return revisitScore < MIN_DENSE_REVISIT_SCORE;
};

const filterClusterToFarmingPoints = (clusterPoints, revisitScores) =>
  (clusterPoints || []).filter(
    point => !isRoadTransitPoint(point, revisitScores[point.sourceIndex] || 0),
  );

const isLikelyFarmingPatch = (clusterPoints, segmentMetrics, revisitScores) => {
  if (!clusterPoints?.length || !segmentMetrics) {
    return false;
  }

  const areaSquareMeters =
    Math.max(segmentMetrics.bounds?.areaSquareMeters || 0, 1);

  if (isTransitLikeCorridor(segmentMetrics, areaSquareMeters)) {
    return false;
  }

  const speeds = clusterPoints
    .map(point => getPointSpeedKmh(point))
    .filter(value => value != null);
  const medianSpeed = speeds.length ? calculateMedian(speeds) : null;

  if (medianSpeed != null && medianSpeed > MAX_FARMING_SPEED_KMH) {
    return false;
  }

  const farmingPointCount = clusterPoints.filter(
    point => (revisitScores[point.sourceIndex] || 0) >= MIN_NEIGHBOR_REVISITS,
  ).length;
  const farmingPointRatio = farmingPointCount / clusterPoints.length;

  if (farmingPointRatio < MIN_FARMING_POINT_RATIO) {
    return false;
  }

  if (segmentMetrics.revisitFactor < MIN_FARMING_REVISIT_FACTOR) {
    return false;
  }

  const longerSide = Math.max(
    segmentMetrics.bounds.widthMeters,
    segmentMetrics.bounds.heightMeters,
  );
  const shorterSide = Math.min(
    segmentMetrics.bounds.widthMeters,
    segmentMetrics.bounds.heightMeters,
  );
  const aspectRatio = longerSide / Math.max(shorterSide, 1);

  if (
    aspectRatio >= 8 &&
    segmentMetrics.turnCount <= 3 &&
    segmentMetrics.compactness <= 3
  ) {
    return false;
  }

  return (
    segmentMetrics.turnCount >= 2 ||
    segmentMetrics.revisitFactor >= 2.8 ||
    segmentMetrics.compactness >= 2.5
  );
};

const normalizeReplayPoints = points =>
  (points || [])
    .map((point, index, list) => {
      const latitude = parseCoordinate(point?.latitude);
      const longitude = parseCoordinate(point?.longitude);

      if (latitude == null || longitude == null) {
        return null;
      }

      const nextPoint = list[index + 1];
      const nextLatitude = parseCoordinate(nextPoint?.latitude);
      const nextLongitude = parseCoordinate(nextPoint?.longitude);
      const fallbackHeading =
        nextLatitude != null && nextLongitude != null
          ? normalizeHeading(
              calculateBearing(latitude, longitude, nextLatitude, nextLongitude),
            )
          : null;

      return {
        ...point,
        latitude,
        longitude,
        heading: normalizeHeading(point?.heading ?? fallbackHeading ?? 0),
        speedKmh: parseSpeedKmh(point?.speed ?? point?.Speed ?? point?.vehicleSpeed),
      };
    })
    .filter(Boolean)
    .map((point, index, list) => {
      if (point.speedKmh != null || index === 0) {
        return point;
      }

      const previousPoint = list[index - 1];
      const derivedSpeedKmh = calculateDerivedSpeedKmh(previousPoint, point);

      return derivedSpeedKmh == null
        ? point
        : {...point, speedKmh: derivedSpeedKmh};
    });

const buildRegionFromBounds = (minLat, maxLat, minLng, maxLng) => {
  const latitudeDelta = Math.max(maxLat - minLat, 0.002) * 1.5;
  const longitudeDelta = Math.max(maxLng - minLng, 0.002) * 1.5;

  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta,
    longitudeDelta,
  };
};

const buildBoundsMetrics = points => {
  if (!points?.length) {
    return null;
  }

  const latitudes = points.map(point => point.latitude);
  const longitudes = points.map(point => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const midLat = (minLat + maxLat) / 2;
  const midLng = (minLng + maxLng) / 2;
  const widthMeters = calculateDistanceMeters(midLat, minLng, midLat, maxLng);
  const heightMeters = calculateDistanceMeters(minLat, midLng, maxLat, midLng);

  return {
    minLat,
    maxLat,
    minLng,
    maxLng,
    midLat,
    midLng,
    widthMeters,
    heightMeters,
    areaSquareMeters: widthMeters * heightMeters,
  };
};

const buildSegmentMetrics = points => {
  if (!points?.length) {
    return null;
  }

  const bounds = buildBoundsMetrics(points);

  if (!bounds) {
    return null;
  }

  let pathLengthMeters = 0;
  let turnCount = 0;
  let previousHeading = null;
  const displacementMeters = calculateDistanceMeters(
    points[0].latitude,
    points[0].longitude,
    points[points.length - 1].latitude,
    points[points.length - 1].longitude,
  );

  for (let index = 0; index < points.length - 1; index += 1) {
    const currentPoint = points[index];
    const nextPoint = points[index + 1];
    const stepDistance = calculateDistanceMeters(
      currentPoint.latitude,
      currentPoint.longitude,
      nextPoint.latitude,
      nextPoint.longitude,
    );

    pathLengthMeters += stepDistance;

    if (stepDistance < 3) {
      continue;
    }

    const currentHeading = normalizeHeading(
      currentPoint.heading ??
        calculateBearing(
          currentPoint.latitude,
          currentPoint.longitude,
          nextPoint.latitude,
          nextPoint.longitude,
        ),
    );

    if (previousHeading != null && currentHeading != null) {
      const headingDifference = getHeadingDifference(
        previousHeading,
        currentHeading,
      );

      if (headingDifference >= MIN_TURN_DEGREES) {
        turnCount += 1;
      }
    }

    previousHeading = currentHeading;
  }
  const compactness = pathLengthMeters / Math.max(displacementMeters, 5);
  const revisitFactor =
    pathLengthMeters /
    Math.max(Math.max(bounds.widthMeters, bounds.heightMeters), 5);

  return {
    bounds,
    pathLengthMeters,
    displacementMeters,
    compactness,
    revisitFactor,
    turnCount,
    pointCount: points.length,
  };
};

const fillShortFalseGaps = flags => {
  const nextFlags = [...flags];
  let index = 0;

  while (index < flags.length) {
    if (flags[index]) {
      index += 1;
      continue;
    }

    let endIndex = index;
    while (endIndex < flags.length && !flags[endIndex]) {
      endIndex += 1;
    }

    const gapLength = endIndex - index;
    const hasTrueBefore = index > 0 && flags[index - 1];
    const hasTrueAfter = endIndex < flags.length && flags[endIndex];

    if (
      hasTrueBefore &&
      hasTrueAfter &&
      gapLength <= MAX_CLASSIFICATION_GAP
    ) {
      for (let gapIndex = index; gapIndex < endIndex; gapIndex += 1) {
        nextFlags[gapIndex] = true;
      }
    }

    index = endIndex;
  }

  return nextFlags;
};

const buildProjectedReplayPoints = points => {
  const originPoint = points?.[0];

  if (!originPoint) {
    return [];
  }

  return points.map(point => {
    const projected = projectPointToMeters(point, originPoint);
    return {
      ...point,
      x: projected.x,
      y: projected.y,
    };
  });
};

const calculateRevisitScores = projectedPoints => {
  const pointCount = projectedPoints.length;
  const revisitScores = new Array(pointCount).fill(0);

  if (pointCount === 0) {
    return revisitScores;
  }

  // Spatial hash grid keeps this near O(n) instead of O(n^2) so a full day of
  // GPS points doesn't freeze the JS thread before navigating to the report.
  const cellSize = LOCAL_REVISIT_RADIUS_METERS;
  const radiusSquared =
    LOCAL_REVISIT_RADIUS_METERS * LOCAL_REVISIT_RADIUS_METERS;
  const grid = new Map();

  const getCellKey = (cellX, cellY) => `${cellX}:${cellY}`;

  for (let index = 0; index < pointCount; index += 1) {
    const cellX = Math.floor(projectedPoints[index].x / cellSize);
    const cellY = Math.floor(projectedPoints[index].y / cellSize);
    const key = getCellKey(cellX, cellY);
    const bucket = grid.get(key);

    if (bucket) {
      bucket.push(index);
    } else {
      grid.set(key, [index]);
    }
  }

  for (let index = 0; index < pointCount; index += 1) {
    const currentPoint = projectedPoints[index];
    const cellX = Math.floor(currentPoint.x / cellSize);
    const cellY = Math.floor(currentPoint.y / cellSize);

    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const bucket = grid.get(getCellKey(cellX + offsetX, cellY + offsetY));

        if (!bucket) {
          continue;
        }

        for (
          let bucketIndex = 0;
          bucketIndex < bucket.length;
          bucketIndex += 1
        ) {
          const otherIndex = bucket[bucketIndex];

          // Count each qualifying pair once, matching the original
          // secondIndex >= firstIndex + MIN_INDEX_SEPARATION semantics.
          if (otherIndex - index < MIN_INDEX_SEPARATION) {
            continue;
          }

          const deltaX = currentPoint.x - projectedPoints[otherIndex].x;
          const deltaY = currentPoint.y - projectedPoints[otherIndex].y;

          if (deltaX * deltaX + deltaY * deltaY <= radiusSquared) {
            revisitScores[index] += 1;
            revisitScores[otherIndex] += 1;
          }
        }
      }
    }
  }

  return revisitScores;
};

const isLikelyFarmingWindow = (revisitScores, index, points = []) => {
  const currentPoint = points[index];
  const currentSpeed = getPointSpeedKmh(currentPoint);

  if (currentSpeed != null && currentSpeed > MAX_FARMING_SPEED_KMH) {
    return false;
  }

  const startIndex = Math.max(0, index - WINDOW_RADIUS);
  const endIndex = Math.min(revisitScores.length - 1, index + WINDOW_RADIUS);
  const windowScores = revisitScores.slice(startIndex, endIndex + 1);
  const windowPoints = points.slice(startIndex, endIndex + 1);
  const highSpeedCount = windowPoints.filter(point => {
    const speedKmh = getPointSpeedKmh(point);
    return speedKmh != null && speedKmh > MAX_FARMING_SPEED_KMH;
  }).length;

  if (highSpeedCount >= Math.max(2, Math.floor(windowPoints.length * 0.25))) {
    return false;
  }

  if (windowScores.length < MIN_WINDOW_POINTS) {
    return false;
  }

  const strongMatches = windowScores.filter(
    score => score >= MIN_NEIGHBOR_REVISITS,
  ).length;
  const totalScore = windowScores.reduce((sum, score) => sum + score, 0);
  const averageScore = totalScore / windowScores.length;

  return (
    strongMatches >= Math.max(4, Math.floor(windowScores.length * 0.35)) ||
    averageScore >= MIN_NEIGHBOR_REVISITS
  );
};

const isValidDetectedArea = (farmingArea, revisitScores, startIndex, endIndex) => {
  if (!farmingArea) {
    return false;
  }

  const segmentScores = revisitScores.slice(startIndex, endIndex + 1);
  const averageRevisitScore =
    segmentScores.reduce((sum, score) => sum + score, 0) /
    Math.max(segmentScores.length, 1);
  const strongScoreCount = segmentScores.filter(
    score => score >= MIN_NEIGHBOR_REVISITS,
  ).length;
  const longerSideFeet = Math.max(
    farmingArea.widthFeet || 0,
    farmingArea.heightFeet || 0,
  );
  const shorterSideFeet = Math.min(
    farmingArea.widthFeet || 0,
    farmingArea.heightFeet || 0,
  );

  return (
    farmingArea.pointCount >= MIN_FARMING_POINTS &&
    farmingArea.areaSquareFeet >= MIN_FARMING_AREA_SQ_FEET &&
    strongScoreCount >= 6 &&
    averageRevisitScore >= 3 &&
    longerSideFeet >= 25 &&
    shorterSideFeet >= 8
  );
};

const shouldIgnoreLowActivityArea = (turnCount, pointCount) =>
  turnCount < 2 && pointCount < MIN_FARMING_POINTS;

// A fixed 20m link radius drops records whenever consecutive GPS fixes
// happen to be spaced further apart than that (slower ping rate, a sharp
// turn, a brief speed-up) - the flood fill below can't bridge the gap, the
// cluster splits into pieces smaller than MIN_CLUSTER_POINTS, and the
// whole patch gets silently skipped. Basing the link distance on the
// data's own median point spacing (with a floor at the original 20m and a
// ceiling so sparse/noisy data can't merge unrelated patches) keeps this
// working across different GPS sampling rates without manual tuning.
const getAdaptiveClusterLinkDistance = points => {
  const stepDistances = [];

  for (let index = 1; index < points.length; index += 1) {
    const previousPoint = points[index - 1];
    const currentPoint = points[index];
    stepDistances.push(
      Math.hypot(
        currentPoint.x - previousPoint.x,
        currentPoint.y - previousPoint.y,
      ),
    );
  }

  if (!stepDistances.length) {
    return CLUSTER_LINK_DISTANCE_METERS;
  }

  const medianStep = calculateMedian(stepDistances);
  const adaptiveDistance = Math.max(
    CLUSTER_LINK_DISTANCE_METERS,
    medianStep * 2.5,
  );

  return Math.min(adaptiveDistance, MAX_CLUSTER_LINK_DISTANCE_METERS);
};

const buildSpatialClusters = points => {
  if (!points?.length) {
    return [];
  }

  const linkDistance = getAdaptiveClusterLinkDistance(points);
  const visited = new Array(points.length).fill(false);
  const clusters = [];

  for (let startIndex = 0; startIndex < points.length; startIndex += 1) {
    if (visited[startIndex]) {
      continue;
    }

    const queue = [startIndex];
    const cluster = [];
    visited[startIndex] = true;

    while (queue.length) {
      const currentIndex = queue.shift();
      const currentPoint = points[currentIndex];
      cluster.push(currentPoint);

      for (let nextIndex = 0; nextIndex < points.length; nextIndex += 1) {
        if (visited[nextIndex]) {
          continue;
        }

        const nextPoint = points[nextIndex];
        const deltaX = currentPoint.x - nextPoint.x;
        const deltaY = currentPoint.y - nextPoint.y;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (distance <= linkDistance) {
          visited[nextIndex] = true;
          queue.push(nextIndex);
        }
      }
    }

    if (cluster.length >= MIN_CLUSTER_POINTS) {
      clusters.push(
        cluster.sort((first, second) => first.sourceIndex - second.sourceIndex),
      );
    }
  }

  return clusters;
};

const splitClusterByContinuity = clusterPoints => {
  if (!clusterPoints?.length) {
    return [];
  }

  const sortedClusterPoints = [...clusterPoints].sort(
    (first, second) => first.sourceIndex - second.sourceIndex,
  );
  const splitClusters = [];
  let currentCluster = [sortedClusterPoints[0]];

  for (let index = 1; index < sortedClusterPoints.length; index += 1) {
    const previousPoint = sortedClusterPoints[index - 1];
    const nextPoint = sortedClusterPoints[index];
    const sourceIndexGap = Math.abs(
      (nextPoint.sourceIndex || 0) - (previousPoint.sourceIndex || 0),
    );
    const deltaX = (nextPoint.x || 0) - (previousPoint.x || 0);
    const deltaY = (nextPoint.y || 0) - (previousPoint.y || 0);
    const stepDistanceMeters = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const previousTimestamp = getPointTimestampMillis(previousPoint);
    const nextTimestamp = getPointTimestampMillis(nextPoint);
    const timeGapSeconds =
      previousTimestamp != null && nextTimestamp != null
        ? Math.abs(nextTimestamp - previousTimestamp) / 1000
        : null;
    const shouldSplitCluster =
      sourceIndexGap > MAX_CLUSTER_INDEX_GAP ||
      stepDistanceMeters > MAX_CLUSTER_POINT_STEP_METERS ||
      (timeGapSeconds != null && timeGapSeconds > MAX_CLUSTER_TIME_GAP_SECONDS);

    if (shouldSplitCluster) {
      if (currentCluster.length >= MIN_CLUSTER_POINTS) {
        splitClusters.push(currentCluster);
      }
      currentCluster = [nextPoint];
      continue;
    }

    currentCluster.push(nextPoint);
  }

  if (currentCluster.length >= MIN_CLUSTER_POINTS) {
    splitClusters.push(currentCluster);
  }

  return splitClusters;
};

const trimClusterToCorePoints = clusterPoints => {
  if (!clusterPoints?.length) {
    return [];
  }

  const centroid = clusterPoints.reduce(
    (accumulator, point) => ({
      x: accumulator.x + point.x,
      y: accumulator.y + point.y,
    }),
    {x: 0, y: 0},
  );

  centroid.x /= clusterPoints.length;
  centroid.y /= clusterPoints.length;

  const pointsWithDistance = clusterPoints.map(point => {
    const deltaX = point.x - centroid.x;
    const deltaY = point.y - centroid.y;
    const distanceFromCentroid = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    return {
      point,
      distanceFromCentroid,
    };
  });

  const distances = pointsWithDistance.map(item => item.distanceFromCentroid);
  const medianDistance = calculateMedian(distances);
  const absoluteDeviations = distances.map(distance =>
    Math.abs(distance - medianDistance),
  );
  const medianDeviation = calculateMedian(absoluteDeviations);
  const maxAcceptedDistance = Math.max(
    18,
    medianDistance + Math.max(8, medianDeviation * 3),
  );
  const corePoints = pointsWithDistance
    .filter(item => item.distanceFromCentroid <= maxAcceptedDistance)
    .map(item => item.point);

  return corePoints.length >= MIN_CLUSTER_POINTS ? corePoints : clusterPoints;
};

const trimClusterEndsByRevisit = (clusterPoints, revisitScores, minScore) => {
  if (!clusterPoints?.length) {
    return [];
  }

  const sorted = [...clusterPoints].sort(
    (first, second) => (first.sourceIndex || 0) - (second.sourceIndex || 0),
  );
  let startIndex = 0;

  while (
    startIndex < sorted.length &&
    (revisitScores[sorted[startIndex].sourceIndex] || 0) < minScore
  ) {
    startIndex += 1;
  }

  let endIndex = sorted.length - 1;

  while (
    endIndex >= startIndex &&
    (revisitScores[sorted[endIndex].sourceIndex] || 0) < minScore
  ) {
    endIndex -= 1;
  }

  const trimmed = sorted.slice(startIndex, endIndex + 1);

  return trimmed.length >= MIN_CLUSTER_POINTS ? trimmed : [];
};

const isTransitLikeCorridor = (metrics, areaSquareMeters) => {
  if (!metrics) {
    return true;
  }

  const longerSide = Math.max(
    metrics.bounds.widthMeters,
    metrics.bounds.heightMeters,
  );
  const shorterSide = Math.min(
    metrics.bounds.widthMeters,
    metrics.bounds.heightMeters,
  );
  const aspectRatio = longerSide / Math.max(shorterSide, 1);
  const sqrtArea = Math.sqrt(Math.max(areaSquareMeters, 1));
  const pathPerRootArea = metrics.pathLengthMeters / sqrtArea;
  const displacementRatio =
    metrics.displacementMeters / Math.max(metrics.pathLengthMeters, 1);

  const straightRun =
    metrics.compactness <= 3 &&
    metrics.turnCount <= 3 &&
    displacementRatio >= 0.72;

  const thinSnake =
    aspectRatio >= 8 &&
    metrics.turnCount <= 4 &&
    pathPerRootArea <= 16;

  const longStraightTransit =
    aspectRatio >= 6 &&
    metrics.turnCount <= 2 &&
    pathPerRootArea <= 12 &&
    displacementRatio >= 0.6;

  const lowRevisitRoad =
    metrics.revisitFactor < MIN_FARMING_REVISIT_FACTOR &&
    metrics.turnCount <= 2;

  return straightRun || thinSnake || longStraightTransit || lowRevisitRoad;
};

const buildPrincipalAxisData = projectedPoints => {
  if (!projectedPoints?.length) {
    return null;
  }

  const centroid = projectedPoints.reduce(
    (accumulator, point) => ({
      x: accumulator.x + point.x,
      y: accumulator.y + point.y,
    }),
    {x: 0, y: 0},
  );

  centroid.x /= projectedPoints.length;
  centroid.y /= projectedPoints.length;

  let varXX = 0;
  let varYY = 0;
  let varXY = 0;

  projectedPoints.forEach(point => {
    const dx = point.x - centroid.x;
    const dy = point.y - centroid.y;
    varXX += dx * dx;
    varYY += dy * dy;
    varXY += dx * dy;
  });

  const angle = 0.5 * Math.atan2(2 * varXY, varXX - varYY);
  const primaryAxis = {x: Math.cos(angle), y: Math.sin(angle)};
  const secondaryAxis = {x: -Math.sin(angle), y: Math.cos(angle)};

  const projectedAxisPoints = projectedPoints.map(point => {
    const dx = point.x - centroid.x;
    const dy = point.y - centroid.y;

    return {
      u: dx * primaryAxis.x + dy * primaryAxis.y,
      v: dx * secondaryAxis.x + dy * secondaryAxis.y,
    };
  });

  const uValues = projectedAxisPoints.map(point => point.u);
  const vValues = projectedAxisPoints.map(point => point.v);

  return {
    centroid,
    primaryAxis,
    secondaryAxis,
    projectedAxisPoints,
    uValues,
    vValues,
  };
};

const calculateMedian = values => {
  if (!values?.length) {
    return 0;
  }

  const sortedValues = [...values].sort((first, second) => first - second);
  const middleIndex = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 0) {
    return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
  }

  return sortedValues[middleIndex];
};

const filterSparseHullPoints = projectedPoints => {
  if (!projectedPoints?.length) {
    return [];
  }

  const pointsWithNeighborCount = projectedPoints.map((point, index) => {
    let neighborCount = 0;

    for (let otherIndex = 0; otherIndex < projectedPoints.length; otherIndex += 1) {
      if (index === otherIndex) {
        continue;
      }

      const deltaX = point.x - projectedPoints[otherIndex].x;
      const deltaY = point.y - projectedPoints[otherIndex].y;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance <= HULL_NEIGHBOR_RADIUS_METERS) {
        neighborCount += 1;
      }
    }

    return {point, neighborCount};
  });

  const neighborCounts = pointsWithNeighborCount.map(item => item.neighborCount);
  const medianNeighborCount = calculateMedian(neighborCounts);
  const adaptiveMinimumNeighbors = Math.max(
    MIN_HULL_NEIGHBORS,
    Math.floor(medianNeighborCount * 0.35),
  );
  const filteredPoints = pointsWithNeighborCount
    .filter(item => item.neighborCount >= adaptiveMinimumNeighbors)
    .map(item => item.point);

  return filteredPoints.length >= 3 ? filteredPoints : projectedPoints;
};

const buildFarmingArea = (points, id, coverageOptions = {}) => {
  if (!points?.length) {
    return null;
  }

  const pathCoverage = buildPathCoverageFromCoordinates(points, coverageOptions);

  if (!pathCoverage) {
    return null;
  }

  const {centroid, hullPoints, polygon, areaSquareMeters} = pathCoverage;

  const areaSquareFeet = areaSquareMeters * SQ_FEET_PER_SQ_METER;

  if (
    !Number.isFinite(areaSquareMeters) ||
    areaSquareMeters <= 0 ||
    areaSquareMeters < MIN_FARMING_AREA_SQ_METERS ||
    areaSquareMeters > MAX_FARMING_AREA_SQ_METERS ||
    areaSquareFeet < MIN_FARMING_AREA_SQ_FEET
  ) {
    return null;
  }

  const hullAxisData = buildPrincipalAxisData(hullPoints);
  const widthMeters = hullAxisData
    ? Math.max(...hullAxisData.uValues) - Math.min(...hullAxisData.uValues)
    : 0;
  const heightMeters = hullAxisData
    ? Math.max(...hullAxisData.vValues) - Math.min(...hullAxisData.vValues)
    : 0;
  const polygonBounds = buildBoundsMetrics(polygon);

  if (!polygonBounds) {
    return null;
  }

  return {
    id,
    points,
    polygon,
    center: centroid,
    bounds: {
      minLat: polygonBounds.minLat,
      maxLat: polygonBounds.maxLat,
      minLng: polygonBounds.minLng,
      maxLng: polygonBounds.maxLng,
    },
    rectangle: polygon,
    region: buildRegionFromBounds(
      polygonBounds.minLat,
      polygonBounds.maxLat,
      polygonBounds.minLng,
      polygonBounds.maxLng,
    ),
    widthFeet: widthMeters * 3.28084,
    heightFeet: heightMeters * 3.28084,
    areaSquareFeet,
    pointCount: points.length,
  };
};

const boundsOverlap = (firstBounds, secondBounds) => {
  if (!firstBounds || !secondBounds) {
    return false;
  }

  return !(
    firstBounds.maxLat < secondBounds.minLat ||
    firstBounds.minLat > secondBounds.maxLat ||
    firstBounds.maxLng < secondBounds.minLng ||
    firstBounds.minLng > secondBounds.maxLng
  );
};

const mergeFarmingAreasByTimeGap = areas => {
  if (!areas?.length) {
    return [];
  }

  const sortedAreas = [...areas].sort((firstArea, secondArea) => {
    const firstTimes = getAreaTimeBoundsMillis(firstArea);
    const secondTimes = getAreaTimeBoundsMillis(secondArea);
    const firstStart = firstTimes.startMillis ?? Number.POSITIVE_INFINITY;
    const secondStart = secondTimes.startMillis ?? Number.POSITIVE_INFINITY;
    return firstStart - secondStart;
  });

  const mergedAreas = [];

  sortedAreas.forEach(area => {
    if (!mergedAreas.length) {
      mergedAreas.push(area);
      return;
    }

    const previousArea = mergedAreas[mergedAreas.length - 1];
    const previousTimes = getAreaTimeBoundsMillis(previousArea);
    const currentTimes = getAreaTimeBoundsMillis(area);

    const gapSeconds =
      previousTimes.endMillis != null && currentTimes.startMillis != null
        ? (currentTimes.startMillis - previousTimes.endMillis) / 1000
        : null;

    const shouldMergeByTime =
      gapSeconds != null && gapSeconds >= 0 && gapSeconds <= MERGE_AREA_MAX_TIME_GAP_SECONDS;

    if (!shouldMergeByTime) {
      mergedAreas.push(area);
      return;
    }

    const centerDistanceMeters =
      previousArea?.center && area?.center
        ? calculateDistanceMeters(
            previousArea.center.latitude,
            previousArea.center.longitude,
            area.center.latitude,
            area.center.longitude,
          )
        : Number.POSITIVE_INFINITY;

    const shouldMergeBySpace =
      centerDistanceMeters <= MERGE_AREA_MAX_CENTER_DISTANCE_METERS ||
      boundsOverlap(previousArea.bounds, area.bounds);

    if (!shouldMergeBySpace) {
      mergedAreas.push(area);
      return;
    }

    const mergedPoints = [...(previousArea.points || []), ...(area.points || [])]
      .filter(point => {
        const speedKmh = getPointSpeedKmh(point);
        return speedKmh == null || speedKmh <= MAX_FARMING_SPEED_KMH;
      });
    const mergedProjected = buildProjectedReplayPoints(mergedPoints);
    const mergedRevisitScores = calculateRevisitScores(mergedProjected);
    const mergedCheckPoints = mergedProjected.map((point, pointIndex) => ({
      ...point,
      sourceIndex: pointIndex,
    }));
    const mergedMetrics = buildSegmentMetrics(mergedPoints);
    const rebuilt = buildFarmingArea(mergedPoints, previousArea.id);

    if (
      !rebuilt ||
      !isLikelyFarmingPatch(
        mergedCheckPoints,
        mergedMetrics,
        mergedRevisitScores,
      )
    ) {
      mergedAreas.push(area);
      return;
    }

    mergedAreas[mergedAreas.length - 1] = {
      ...rebuilt,
      turnCount: (previousArea.turnCount || 0) + (area.turnCount || 0),
      pathLengthFeet: (mergedMetrics?.pathLengthMeters || 0) * 3.28084,
    };
  });

  return mergedAreas.map((area, index) => ({
    ...area,
    id: index + 1,
  }));
};

// Splits one detected area into separate plots when it contains a thin
// connecting strip (the tractor driving from one plot to the next), and drops
// that strip. Works on the coverage grid: erode by ~2 implement widths (thin
// strips vanish, real plots survive), find the connected pieces that remain,
// then give every GPS point to the piece it belongs to. Points that belong to
// no piece (the connector / dangling lane) are discarded, and every plot is
// rebuilt with the normal area builder, so its shape rules stay unchanged.
const splitAreaAtNarrowNecks = area => {
  const keptPoints = (area?.points || []).filter(point => {
    const speedKmh = getPointSpeedKmh(point);
    return speedKmh == null || speedKmh <= MAX_FARMING_SPEED_KMH;
  });

  if (keptPoints.length < MIN_CLUSTER_POINTS * 2) {
    return [area];
  }

  const centroid = buildCoordinateCentroid(keptPoints);

  if (!centroid) {
    return [area];
  }

  const projected = keptPoints.map(point => projectPointToMeters(point, centroid));
  const implementHalfWidth = estimateImplementHalfWidthMeters(projected);
  const {closedCoverageGrid, minX, minY, cellSize} = buildClosedCoverageGrid(
    projected,
    implementHalfWidth,
  );

  if (!closedCoverageGrid) {
    return [area];
  }

  const openRadius = Math.max(2, Math.ceil((NECK_OPENING_FACTOR * implementHalfWidth) / cellSize));
  const coreGrid = erodeCoverageGrid(closedCoverageGrid, openRadius);

  if (!coreGrid.size) {
    return [area];
  }

  // connected pieces of the eroded grid (8-neighbourhood)
  const cellToComponent = new Map();
  const componentCells = [];

  coreGrid.forEach(startKey => {
    if (cellToComponent.has(startKey)) {
      return;
    }

    const componentIndex = componentCells.length;
    const queue = [startKey];
    let cellCount = 0;
    cellToComponent.set(startKey, componentIndex);

    for (let head = 0; head < queue.length; head += 1) {
      const [row, col] = queue[head].split(',').map(Number);
      cellCount += 1;

      for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
        for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
          const neighborKey = getGridCellKey(row + rowOffset, col + colOffset);

          if (coreGrid.has(neighborKey) && !cellToComponent.has(neighborKey)) {
            cellToComponent.set(neighborKey, componentIndex);
            queue.push(neighborKey);
          }
        }
      }
    }

    componentCells.push(cellCount);
  });

  const minComponentCells = Math.max(
    4,
    Math.ceil(MIN_FARMING_AREA_SQ_METERS / (cellSize * cellSize) / 2),
  );
  const isSignificant = componentCells.map(count => count >= minComponentCells);

  if (!isSignificant.some(Boolean)) {
    return [area];
  }

  // give each GPS point to the nearest surviving piece (within the opening radius)
  const searchRadius = openRadius + 2;
  const groups = componentCells.map(() => []);

  projected.forEach((projectedPoint, pointIndex) => {
    const centerCol = Math.floor((projectedPoint.x - minX) / cellSize);
    const centerRow = Math.floor((projectedPoint.y - minY) / cellSize);
    let bestComponent = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let rowOffset = -searchRadius; rowOffset <= searchRadius; rowOffset += 1) {
      for (let colOffset = -searchRadius; colOffset <= searchRadius; colOffset += 1) {
        const componentIndex = cellToComponent.get(
          getGridCellKey(centerRow + rowOffset, centerCol + colOffset),
        );

        if (componentIndex == null || !isSignificant[componentIndex]) {
          continue;
        }

        const distance = rowOffset * rowOffset + colOffset * colOffset;

        if (distance < bestDistance) {
          bestDistance = distance;
          bestComponent = componentIndex;
        }
      }
    }

    if (bestComponent >= 0) {
      groups[bestComponent].push(keptPoints[pointIndex]);
    }
  });

  const parts = [];

  groups.forEach(groupPoints => {
    if (groupPoints.length < MIN_CLUSTER_POINTS) {
      return;
    }

    const part = buildFarmingArea(groupPoints, 0);
    const metrics = buildSegmentMetrics(groupPoints);
    const turnCount = metrics?.turnCount || 0;

    if (!part || shouldIgnoreLowActivityArea(turnCount, part.pointCount || 0)) {
      return;
    }

    parts.push({
      ...part,
      turnCount,
      pathLengthFeet: (metrics?.pathLengthMeters || 0) * 3.28084,
    });
  });

  if (!parts.length) {
    return [area];
  }

  // safety: never accept a split that throws away most of the field
  const keptAreaSqFt = parts.reduce((sum, part) => sum + part.areaSquareFeet, 0);

  if (keptAreaSqFt < (area.areaSquareFeet || 0) * 0.5) {
    return [area];
  }

  return parts;
};

const splitAreasAtNarrowNecks = areas =>
  (areas || [])
    .flatMap(area => splitAreaAtNarrowNecks(area))
    .sort((first, second) => {
      const firstStart = getAreaTimeBoundsMillis(first).startMillis ?? Number.POSITIVE_INFINITY;
      const secondStart = getAreaTimeBoundsMillis(second).startMillis ?? Number.POSITIVE_INFINITY;
      return firstStart - secondStart;
    })
    .map((area, index) => ({...area, id: index + 1}));

const detectFarmingAreas = points => {
  if (!points?.length || points.length < MIN_FARMING_POINTS) {
    return [];
  }

  const projectedPoints = buildProjectedReplayPoints(points);
  const revisitScores = calculateRevisitScores(projectedPoints);
  const farmingFlags = revisitScores.map((_, index) =>
    isLikelyFarmingWindow(revisitScores, index, points),
  );
  const smoothedFlags = fillShortFalseGaps(farmingFlags);
  const farmingAreas = [];
  let startIndex = null;

  for (let index = 0; index <= smoothedFlags.length; index += 1) {
    const isFarmingPoint = smoothedFlags[index];

    if (isFarmingPoint && startIndex == null) {
      startIndex = index;
      continue;
    }

    if (!isFarmingPoint && startIndex != null) {
      const endIndex = index - 1;
      const paddedStartIndex = Math.max(0, startIndex - SEGMENT_PADDING_POINTS);
      const paddedEndIndex = Math.min(
        points.length - 1,
        endIndex + SEGMENT_PADDING_POINTS,
      );
      const segmentProjectedPoints = projectedPoints
        .slice(paddedStartIndex, paddedEndIndex + 1)
        .map((point, relativeIndex) => ({
          ...point,
          sourceIndex: paddedStartIndex + relativeIndex,
          revisitScore: revisitScores[paddedStartIndex + relativeIndex] || 0,
        }));
      const denseProjectedPoints = segmentProjectedPoints.filter(
        point => point.revisitScore >= MIN_DENSE_REVISIT_SCORE,
      );
      const spatialClusters = buildSpatialClusters(denseProjectedPoints);

      spatialClusters.forEach(cluster => {
        const continuityClusters = splitClusterByContinuity(cluster);

        continuityClusters.forEach(continuityCluster => {
          const coreCluster = trimClusterToCorePoints(continuityCluster);
          const trimmedByRevisit = trimClusterEndsByRevisit(
            coreCluster,
            revisitScores,
            MIN_DENSE_REVISIT_SCORE,
          );

          if (trimmedByRevisit.length < MIN_CLUSTER_POINTS) {
            return;
          }

          const farmingClusterPoints = filterClusterToFarmingPoints(
            trimmedByRevisit,
            revisitScores,
          );

          if (farmingClusterPoints.length < MIN_CLUSTER_POINTS) {
            return;
          }

          const clusterPoints = farmingClusterPoints.map(point => ({
            latitude: point.latitude,
            longitude: point.longitude,
            heading: point.heading,
            speed: point.speed,
            speedKmh: point.speedKmh,
            sourceIndex: point.sourceIndex,
            timeStamp: point.timeStamp,
            timestamp: point.timestamp,
            TimeStamp: point.TimeStamp,
          }));
          const clusterStartIndex =
            farmingClusterPoints[0]?.sourceIndex ?? startIndex;
          const clusterEndIndex =
            farmingClusterPoints[farmingClusterPoints.length - 1]?.sourceIndex ??
            endIndex;
          const segmentMetrics = buildSegmentMetrics(clusterPoints);
          const detectedTurnCount = segmentMetrics?.turnCount || 0;
          const farmingArea = buildFarmingArea(
            clusterPoints,
            farmingAreas.length + 1,
          );
          const areaSquareMeters =
            (farmingArea?.areaSquareFeet || 0) / SQ_FEET_PER_SQ_METER;

          if (
            farmingArea &&
            isLikelyFarmingPatch(clusterPoints, segmentMetrics, revisitScores) &&
            !shouldIgnoreLowActivityArea(
              detectedTurnCount,
              farmingArea.pointCount || 0,
            ) &&
            isValidDetectedArea(
              farmingArea,
              revisitScores,
              clusterStartIndex,
              clusterEndIndex,
            )
          ) {
            farmingAreas.push({
              ...farmingArea,
              turnCount: detectedTurnCount,
              pathLengthFeet:
                (segmentMetrics?.pathLengthMeters || 0) * 3.28084,
            });
          }
        });
      });

      if (!spatialClusters.length && denseProjectedPoints.length >= MIN_CLUSTER_POINTS) {
        const fallbackContinuityClusters =
          splitClusterByContinuity(denseProjectedPoints);

        fallbackContinuityClusters.forEach(fallbackCluster => {
          const coreFallbackCluster = trimClusterToCorePoints(fallbackCluster);
          const trimmedFallback = trimClusterEndsByRevisit(
            coreFallbackCluster,
            revisitScores,
            MIN_DENSE_REVISIT_SCORE,
          );

          if (trimmedFallback.length < MIN_CLUSTER_POINTS) {
            return;
          }

          const farmingFallbackPoints = filterClusterToFarmingPoints(
            trimmedFallback,
            revisitScores,
          );

          if (farmingFallbackPoints.length < MIN_CLUSTER_POINTS) {
            return;
          }

          const fallbackPoints = farmingFallbackPoints.map(point => ({
            latitude: point.latitude,
            longitude: point.longitude,
            heading: point.heading,
            speed: point.speed,
            speedKmh: point.speedKmh,
            sourceIndex: point.sourceIndex,
            timeStamp: point.timeStamp,
            timestamp: point.timestamp,
            TimeStamp: point.TimeStamp,
          }));
          const fallbackStartIndex =
            farmingFallbackPoints[0]?.sourceIndex ?? startIndex;
          const fallbackEndIndex =
            farmingFallbackPoints[farmingFallbackPoints.length - 1]?.sourceIndex ??
            endIndex;
          const segmentMetrics = buildSegmentMetrics(fallbackPoints);
          const detectedTurnCount = segmentMetrics?.turnCount || 0;
          const farmingArea = buildFarmingArea(
            fallbackPoints,
            farmingAreas.length + 1,
          );
          const areaSquareMeters =
            (farmingArea?.areaSquareFeet || 0) / SQ_FEET_PER_SQ_METER;

          if (
            farmingArea &&
            isLikelyFarmingPatch(fallbackPoints, segmentMetrics, revisitScores) &&
            !shouldIgnoreLowActivityArea(
              detectedTurnCount,
              farmingArea.pointCount || 0,
            ) &&
            isValidDetectedArea(
              farmingArea,
              revisitScores,
              fallbackStartIndex,
              fallbackEndIndex,
            )
          ) {
            farmingAreas.push({
              ...farmingArea,
              turnCount: detectedTurnCount,
              pathLengthFeet:
                (segmentMetrics?.pathLengthMeters || 0) * 3.28084,
            });
          }
        });
      }

      startIndex = null;
    }
  }

  // merge nearby pieces first, then cut thin connecting strips and split into separate plots
  return splitAreasAtNarrowNecks(mergeFarmingAreasByTimeGap(farmingAreas));
};




// =====================================================================
// SPARSE-DATA MODE
// For trackers that report rarely (e.g. one point every 20-60 s, 30-70 m
// apart). There the old detector's rules (points within ~18 m, steps < 45 m)
// never trigger. Instead of looking at dense point clouds this mode looks at
// the PASSES themselves: a field being worked shows many near-parallel
// passes lying side by side, made close together in time. A road, a transit
// lane or a single trip never does.
// =====================================================================
const SPARSE_STATIONARY_METERS = 4;          // GPS jitter while parked is ignored
const SPARSE_MIN_SEGMENT_METERS = 8;         // shorter moves are turns / edge noise
const SPARSE_MAX_SEGMENT_GAP_SECONDS = 400;  // longer gap = tracker was off/parked
const SPARSE_MAX_SPEED_KMH = 14;             // working speed cap (road transit is faster)
const SPARSE_PARALLEL_DEGREES = 25;          // passes must be parallel within this angle
const SPARSE_MIN_ROW_OFFSET_METERS = 0.8;    // closer than this = same line, not a new row
const SPARSE_MAX_ROW_OFFSET_METERS = 10;     // neighbouring rows must be within this distance
const SPARSE_MIN_OVERLAP_RATIO = 0.4;        // rows must run side by side, not end to end
const SPARSE_MIN_INDEX_SEPARATION = 1;      // only skip the pass itself; end-to-end continuations are rejected by the overlap test
const SPARSE_MAX_PASS_TIME_GAP_SECONDS = 2400; // neighbouring rows are made within 40 min
const SPARSE_MIN_NEIGHBOR_PASSES = 4;        // a working pass has >= 4 parallel neighbours
const SPARSE_EDGE_GROW_ROUNDS = 2;           // pull in edge rows next to working rows
const SPARSE_MIN_COMPONENT_PASSES = 8;       // a field needs >= 8 such passes
const SPARSE_MIN_FIELD_WIDTH_METERS = 16;    // thinner than this = road shuttle, not a field
const SPARSE_MEDIAN_STEP_METERS = 15;        // auto-mode: median step >= this ...
const SPARSE_MIN_INTERVAL_SECONDS = 10;      // ... and median interval >= this => sparse data
const SPARSE_BBOX_MARGIN_METERS = 15;

const prepareSparseTrack = points => {
  const valid = (points || []).filter(
    point => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude),
  );

  if (valid.length < 2) {
    return null;
  }

  const centroid = buildCoordinateCentroid(valid);
  const kept = [];

  // Some exports/Excel files drop the seconds (every time is hh:mm:00). Then many
  // points share one timestamp and "distance / elapsed time" is meaningless
  // (60 m in 0 s = infinite speed). Detect that so the speed check can allow for it.
  let wholeMinuteStamps = 0;
  let stampedPoints = 0;
  valid.forEach(point => {
    const millis = getPointTimestampMillis(point);
    if (millis != null) {
      stampedPoints += 1;
      if (millis % 60000 === 0) {
        wholeMinuteStamps += 1;
      }
    }
  });
  const timeResolutionSeconds =
    stampedPoints >= 20 && wholeMinuteStamps / stampedPoints >= 0.98 ? 60 : 1;

  valid.forEach((point, index) => {
    const projected = projectPointToMeters(point, centroid);
    const millis = getPointTimestampMillis(point);
    const last = kept[kept.length - 1];

    if (
      last &&
      Math.hypot(projected.x - last.x, projected.y - last.y) < SPARSE_STATIONARY_METERS
    ) {
      return;
    }

    kept.push({
      point,
      x: projected.x,
      y: projected.y,
      t: millis != null ? millis / 1000 : index * 30, // no timestamps: assume 30 s apart
      speedKmh: getPointSpeedKmh(point),
    });
  });

  return {valid, centroid, kept, timeResolutionSeconds};
};

// How sparse is this data? (used by mode "auto")
const measureSamplingDensity = points => {
  const track = prepareSparseTrack(points);

  if (!track || track.kept.length < 3) {
    return {medianStepMeters: 0, medianIntervalSeconds: 0, timeResolutionSeconds: 1, isSparse: false};
  }

  const steps = [];
  const intervals = [];

  for (let index = 0; index < track.kept.length - 1; index += 1) {
    const first = track.kept[index];
    const second = track.kept[index + 1];
    const gap = Math.max(second.t - first.t, track.timeResolutionSeconds > 1 ? track.timeResolutionSeconds : 0);

    if (gap > 0 && gap <= SPARSE_MAX_SEGMENT_GAP_SECONDS) {
      steps.push(Math.hypot(second.x - first.x, second.y - first.y));
      intervals.push(gap);
    }
  }

  const medianStepMeters = calculateMedian(steps);
  const medianIntervalSeconds = calculateMedian(intervals);

  return {
    medianStepMeters: Math.round(medianStepMeters * 10) / 10,
    medianIntervalSeconds: Math.round(medianIntervalSeconds * 10) / 10,
    timeResolutionSeconds: track.timeResolutionSeconds,
    isSparse:
      steps.length >= 20 &&
      medianStepMeters >= SPARSE_MEDIAN_STEP_METERS &&
      medianIntervalSeconds >= SPARSE_MIN_INTERVAL_SECONDS,
  };
};

const detectSparseFarmingAreas = points => {
  const track = prepareSparseTrack(points);

  if (!track || track.kept.length < SPARSE_MIN_COMPONENT_PASSES) {
    return [];
  }

  const {valid, centroid, kept, timeResolutionSeconds} = track;

  // 1) working passes: moves long enough, at working speed, without a long gap
  const segments = [];

  for (let index = 0; index < kept.length - 1; index += 1) {
    const first = kept[index];
    const second = kept[index + 1];
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const length = Math.hypot(dx, dy);
    const gap = second.t - first.t;

    if (length < SPARSE_MIN_SEGMENT_METERS || gap < 0 || gap > SPARSE_MAX_SEGMENT_GAP_SECONDS) {
      continue;
    }

    const reportedSpeed = Math.max(first.speedKmh ?? 0, second.speedKmh ?? 0);
    // with whole-minute timestamps the real elapsed time is unknown (0-60 s), so never
    // assume less than one resolution step
    const impliedSpeed = (length / Math.max(gap, timeResolutionSeconds, 1)) * 3.6;

    if (reportedSpeed > SPARSE_MAX_SPEED_KMH || impliedSpeed > SPARSE_MAX_SPEED_KMH * 1.5) {
      continue;
    }

    segments.push({
      ia: index,
      ib: index + 1,
      ax: first.x,
      ay: first.y,
      bx: second.x,
      by: second.y,
      length,
      ux: dx / length,
      uy: dy / length,
      ta: first.t,
      tb: second.t,
    });
  }

  if (segments.length < SPARSE_MIN_COMPONENT_PASSES) {
    return [];
  }

  // 2) spatial index so neighbour search stays fast on big files
  const CELL = 50;
  const cellMap = new Map();
  const cellKey = (cx, cy) => `${cx},${cy}`;

  segments.forEach((segment, segmentIndex) => {
    const minCx = Math.floor(Math.min(segment.ax, segment.bx) / CELL);
    const maxCx = Math.floor(Math.max(segment.ax, segment.bx) / CELL);
    const minCy = Math.floor(Math.min(segment.ay, segment.by) / CELL);
    const maxCy = Math.floor(Math.max(segment.ay, segment.by) / CELL);

    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const key = cellKey(cx, cy);
        if (!cellMap.has(key)) {
          cellMap.set(key, []);
        }
        cellMap.get(key).push(segmentIndex);
      }
    }
  });

  // 3) for every pass: which other passes run parallel, side by side, close in time?
  const cosParallel = Math.cos((SPARSE_PARALLEL_DEGREES * Math.PI) / 180);
  const neighbors = segments.map(() => []);

  segments.forEach((segment, segmentIndex) => {
    const pad = SPARSE_MAX_ROW_OFFSET_METERS;
    const minCx = Math.floor((Math.min(segment.ax, segment.bx) - pad) / CELL);
    const maxCx = Math.floor((Math.max(segment.ax, segment.bx) + pad) / CELL);
    const minCy = Math.floor((Math.min(segment.ay, segment.by) - pad) / CELL);
    const maxCy = Math.floor((Math.max(segment.ay, segment.by) + pad) / CELL);
    const candidates = new Set();

    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        (cellMap.get(cellKey(cx, cy)) || []).forEach(candidate => candidates.add(candidate));
      }
    }

    const normalX = -segment.uy;
    const normalY = segment.ux;

    candidates.forEach(otherIndex => {
      if (otherIndex === segmentIndex) {
        return;
      }

      const other = segments[otherIndex];

      if (
        Math.abs(segment.ia - other.ia) < SPARSE_MIN_INDEX_SEPARATION ||
        Math.abs(segment.ta - other.ta) > SPARSE_MAX_PASS_TIME_GAP_SECONDS
      ) {
        return;
      }

      if (Math.abs(segment.ux * other.ux + segment.uy * other.uy) < cosParallel) {
        return;
      }

      const offsetA = (other.ax - segment.ax) * normalX + (other.ay - segment.ay) * normalY;
      const offsetB = (other.bx - segment.ax) * normalX + (other.by - segment.ay) * normalY;
      const offset = Math.abs((offsetA + offsetB) / 2);

      if (offset < SPARSE_MIN_ROW_OFFSET_METERS || offset > SPARSE_MAX_ROW_OFFSET_METERS) {
        return;
      }

      const alongA = (other.ax - segment.ax) * segment.ux + (other.ay - segment.ay) * segment.uy;
      const alongB = (other.bx - segment.ax) * segment.ux + (other.by - segment.ay) * segment.uy;
      const overlap =
        Math.min(segment.length, Math.max(alongA, alongB)) - Math.max(0, Math.min(alongA, alongB));

      if (overlap < SPARSE_MIN_OVERLAP_RATIO * Math.min(segment.length, other.length)) {
        return;
      }

      neighbors[segmentIndex].push({index: otherIndex, offset});
    });
  });

  const isWorking = neighbors.map(list => list.length >= SPARSE_MIN_NEIGHBOR_PASSES);

  // Edge rows (the first/last rows of a field) only have neighbours on ONE side, so they miss
  // the threshold above and the polygon would shrink by a few rows at each end. Pull in rows
  // that sit right beside rows already known to be working (2 rounds, stricter in round 2 so the
  // growth cannot creep along a lane).
  for (let round = 0; round < SPARSE_EDGE_GROW_ROUNDS; round += 1) {
    const needed = round === 0 ? 1 : 2;
    const toAdd = [];

    neighbors.forEach((list, segmentIndex) => {
      if (!isWorking[segmentIndex]) {
        const workingNeighbors = list.filter(neighbor => isWorking[neighbor.index]).length;
        if (workingNeighbors >= needed) {
          toAdd.push(segmentIndex);
        }
      }
    });

    toAdd.forEach(segmentIndex => {
      isWorking[segmentIndex] = true;
    });
  }

  // 4) group working passes that touch each other = one field each
  const parent = segments.map((_, index) => index);
  const findRoot = index => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let walker = index;
    while (parent[walker] !== root) {
      const next = parent[walker];
      parent[walker] = root;
      walker = next;
    }
    return root;
  };

  neighbors.forEach((list, segmentIndex) => {
    if (!isWorking[segmentIndex]) {
      return;
    }
    list.forEach(({index: otherIndex}) => {
      if (isWorking[otherIndex]) {
        parent[findRoot(segmentIndex)] = findRoot(otherIndex);
      }
    });
  });

  const components = new Map();

  segments.forEach((_, segmentIndex) => {
    if (isWorking[segmentIndex]) {
      const root = findRoot(segmentIndex);
      if (!components.has(root)) {
        components.set(root, []);
      }
      components.get(root).push(segmentIndex);
    }
  });

  // 5) turn each group into a field polygon
  const projectedAll = valid.map(point => projectPointToMeters(point, centroid));
  // parse every timestamp ONCE (moment is slow; doing it per field made big files crawl)
  const validSeconds = valid.map((point, pointIndex) => {
    const millis = getPointTimestampMillis(point);
    return millis != null ? millis / 1000 : pointIndex * 30;
  });
  const farmingAreas = [];

  components.forEach(memberIndexes => {
    if (memberIndexes.length < SPARSE_MIN_COMPONENT_PASSES) {
      return;
    }

    const members = memberIndexes.map(index => segments[index]).sort((a, b) => a.ia - b.ia);
    const memberSet = new Set(memberIndexes);

    // row spacing = typical distance to the nearest neighbouring row
    const nearestOffsets = memberIndexes
      .map(index => {
        const offsets = neighbors[index]
          .filter(neighbor => memberSet.has(neighbor.index))
          .map(neighbor => neighbor.offset);
        return offsets.length ? Math.min(...offsets) : null;
      })
      .filter(value => value != null);
    const rowSpacingMeters = calculateMedian(nearestOffsets);
    const halfWidth = Math.min(
      4,
      Math.max(MIN_IMPLEMENT_HALF_WIDTH_METERS, rowSpacingMeters * 0.6),
    );

    // coordinates = the pass end points; pairs = which two points form one pass
    const pointIndexes = [...new Set(members.flatMap(member => [member.ia, member.ib]))].sort(
      (a, b) => a - b,
    );
    const localIndex = new Map(pointIndexes.map((keptIndex, position) => [keptIndex, position]));
    const coordinates = pointIndexes.map(keptIndex => kept[keptIndex].point);
    const segmentPairs = members.map(member => [localIndex.get(member.ia), localIndex.get(member.ib)]);

    const area = buildFarmingArea(coordinates, 0, {
      skipSpeedFilter: true,
      implementHalfWidth: halfWidth,
      segmentPairs,
    });

    if (!area) {
      return;
    }

    if (Math.min(area.widthFeet, area.heightFeet) / 3.28084 < SPARSE_MIN_FIELD_WIDTH_METERS) {
      return; // long thin strip = repeated road trips, not a field
    }

    // every GPS point recorded while working this field (for times / duration)
    const startTime = Math.min(...members.map(member => member.ta));
    const endTime = Math.max(...members.map(member => member.tb));
    const xs = pointIndexes.map(keptIndex => kept[keptIndex].x);
    const ys = pointIndexes.map(keptIndex => kept[keptIndex].y);
    const minX = Math.min(...xs) - SPARSE_BBOX_MARGIN_METERS;
    const maxX = Math.max(...xs) + SPARSE_BBOX_MARGIN_METERS;
    const minY = Math.min(...ys) - SPARSE_BBOX_MARGIN_METERS;
    const maxY = Math.max(...ys) + SPARSE_BBOX_MARGIN_METERS;
    const areaPoints = valid.filter((point, pointIndex) => {
      const t = validSeconds[pointIndex];
      if (t < startTime || t > endTime) {
        return false;
      }
      const {x, y} = projectedAll[pointIndex];
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    });

    let turnCount = 0;
    for (let index = 1; index < members.length; index += 1) {
      const dot = members[index - 1].ux * members[index].ux + members[index - 1].uy * members[index].uy;
      if ((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI >= MIN_TURN_DEGREES) {
        turnCount += 1;
      }
    }

    farmingAreas.push({
      ...area,
      points: areaPoints.length ? areaPoints : area.points,
      pointCount: areaPoints.length || area.pointCount,
      turnCount,
      pathLengthFeet: members.reduce((sum, member) => sum + member.length, 0) * 3.28084,
      startSeconds: startTime,
      passCount: members.length,
      rowSpacingMeters: Math.round(rowSpacingMeters * 10) / 10,
      detectionMode: 'sparse',
    });
  });

  return farmingAreas
    .sort((first, second) => first.startSeconds - second.startSeconds)
    .map(({startSeconds, ...area}, index) => ({...area, id: index + 1}));
};

// mode: 'auto' (default) | 'dense' | 'sparse'
const detectAreasByMode = (points, mode = 'auto') => {
  const sampling = measureSamplingDensity(points);
  let resolvedMode = mode === 'dense' || mode === 'sparse' ? mode : sampling.isSparse ? 'sparse' : 'dense';
  let areas = resolvedMode === 'sparse' ? detectSparseFarmingAreas(points) : detectFarmingAreas(points);

  // auto: dense rules found nothing -> the data may still be a sparse track
  if (mode !== 'dense' && mode !== 'sparse' && resolvedMode === 'dense' && !areas.length) {
    const sparseAreas = detectSparseFarmingAreas(points);
    if (sparseAreas.length) {
      areas = sparseAreas;
      resolvedMode = 'sparse';
    }
  }

  return {areas, mode: resolvedMode, sampling};
};

// ---- Date/time info per area (same rules as the app: active time = sum of gaps <= MAX_CLUSTER_TIME_GAP_SECONDS)
const FMT = 'YYYY-MM-DD HH:mm:ss';
const formatHMS = totalSeconds => {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  return `${Math.floor(s / 3600)} Hrs ${Math.floor((s % 3600) / 60)} min ${s % 60} sec`;
};
const getAreaTimeInfo = area => {
  const moments = (area?.points || [])
    .map(p => getValidMoment(getPointTimestamp(p)))
    .filter(Boolean)
    .sort((a, b) => a.valueOf() - b.valueOf());
  if (!moments.length) {
    return {date: null, startTime: null, endTime: null, activeDurationSeconds: 0,
      activeDuration: '--', elapsedDuration: '--'};
  }
  let active = 0;
  for (let i = 1; i < moments.length; i += 1) {
    const gap = Math.max(0, moments[i].diff(moments[i - 1], 'seconds', true));
    if (gap <= MAX_CLUSTER_TIME_GAP_SECONDS) active += gap;
  }
  const start = moments[0];
  const end = moments[moments.length - 1];
  return {
    date: start.format('YYYY-MM-DD'),
    startTime: start.format(FMT),
    endTime: end.format(FMT),
    activeDurationSeconds: Math.round(active),
    activeDuration: formatHMS(active),
    elapsedDuration: formatHMS(end.diff(start, 'seconds', true)),
  };
};

// Combined helper: raw replay points -> detected areas with % adjustment applied

// Clients sometimes send points out of order. The detector assumes time order, so sort by time
// (only when most points have a readable time and the list is actually out of order).
const sortPointsByTime = points => {
  const list = points || [];
  const times = list.map(point => getPointTimestampMillis(point));
  const stamped = times.filter(time => time != null).length;

  if (stamped < 2 || stamped < list.length * 0.9) {
    return {points: list, reordered: false, droppedWithoutTime: 0};
  }

  let inOrder = true;
  let last = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < times.length; index += 1) {
    if (times[index] == null) {
      continue;
    }
    if (times[index] < last) {
      inOrder = false;
      break;
    }
    last = times[index];
  }

  if (inOrder) {
    return {points: list, reordered: false, droppedWithoutTime: 0};
  }

  const order = [];
  times.forEach((time, index) => {
    if (time != null) {
      order.push(index);
    }
  });
  order.sort((first, second) => times[first] - times[second] || first - second);

  return {
    points: order.map(index => list[index]),
    reordered: true,
    droppedWithoutTime: list.length - order.length,
  };
};

const rawDateCache = new Map();
const getRawPointDate = p => {
  const stamp = getPointTimestamp(p);
  if (!stamp) {
    return null;
  }
  const key = typeof stamp === 'string' ? stamp : null;
  if (key !== null && rawDateCache.has(key)) {
    return rawDateCache.get(key);
  }
  const m = getValidMoment(stamp);
  const result = m ? m.format('YYYY-MM-DD') : null;
  if (key !== null) {
    if (rawDateCache.size > 200000) {
      rawDateCache.clear();
    }
    rawDateCache.set(key, result);
  }
  return result;
};

// date (optional, 'YYYY-MM-DD'): analyse ONLY that day's points
const analyzeFarming = (inputPoints, farmingPercent = 0, date = null, mode = 'auto') => {
  const {points: rawPoints, reordered, droppedWithoutTime} = sortPointsByTime(inputPoints);

  // list of all dates present in the data (before filtering)
  const dateCounts = {};
  (rawPoints || []).forEach(p => {
    const d = getRawPointDate(p);
    if (d) dateCounts[d] = (dateCounts[d] || 0) + 1;
  });
  const availableDates = Object.keys(dateCounts).sort().map(d => ({date: d, pointCount: dateCounts[d]}));

  const selectedDate = date || null;
  const sourcePoints = selectedDate
    ? (rawPoints || []).filter(p => getRawPointDate(p) === selectedDate)
    : rawPoints;

  const points = normalizeReplayPoints(sourcePoints);
  const {areas, mode: detectionMode, sampling} = detectAreasByMode(points, mode);

  const result = areas.map(area => {
    const adjustedSqFt = adjustAreaForFarmingPercent(area.areaSquareFeet, farmingPercent);
    return {
      ...area,
      ...getAreaTimeInfo(area),
      adjustedAreaSquareFeet: adjustedSqFt,
      areaByUnit: {
        acres: convertSquareFeetToUnitValue(adjustedSqFt, AREA_UNIT_TYPES.ACRES),
        guntha: convertSquareFeetToUnitValue(adjustedSqFt, AREA_UNIT_TYPES.GUNTHA),
        bigha: convertSquareFeetToUnitValue(adjustedSqFt, AREA_UNIT_TYPES.BIGHA),
        squareFeet: adjustedSqFt,
      },
    };
  });

  const totalAdjustedSqFt = result.reduce((s, a) => s + a.adjustedAreaSquareFeet, 0);
  const totalActiveSeconds = result.reduce((s, a) => s + (a.activeDurationSeconds || 0), 0);

  // Day-wise summary (a file can span many days)
  const dayMap = {};
  result.forEach(a => {
    const key = a.date || 'unknown';
    const d = dayMap[key] || (dayMap[key] = {date: key, areaCount: 0, sqft: 0, seconds: 0, first: null, last: null});
    d.areaCount += 1;
    d.sqft += a.adjustedAreaSquareFeet;
    d.seconds += a.activeDurationSeconds || 0;
    if (a.startTime && (!d.first || a.startTime < d.first)) d.first = a.startTime;
    if (a.endTime && (!d.last || a.endTime > d.last)) d.last = a.endTime;
  });
  const byDate = Object.values(dayMap).sort((x, y) => x.date.localeCompare(y.date)).map(d => ({
    date: d.date,
    areaCount: d.areaCount,
    firstStart: d.first,
    lastEnd: d.last,
    activeDuration: formatHMS(d.seconds),
    activeDurationSeconds: d.seconds,
    totalByUnit: {
      acres: convertSquareFeetToUnitValue(d.sqft, AREA_UNIT_TYPES.ACRES),
      guntha: convertSquareFeetToUnitValue(d.sqft, AREA_UNIT_TYPES.GUNTHA),
      bigha: convertSquareFeetToUnitValue(d.sqft, AREA_UNIT_TYPES.BIGHA),
      squareFeet: d.sqft,
    },
  }));

  const allTimes = points.map(p => getValidMoment(getPointTimestamp(p))).filter(Boolean).sort((a, b) => a.valueOf() - b.valueOf());
  const dataFrom = allTimes.length ? allTimes[0].format(FMT) : null;
  const dataTo = allTimes.length ? allTimes[allTimes.length - 1].format(FMT) : null;

  return {
    reordered,
    droppedWithoutTime,
    detectionMode,
    sampling,
    selectedDate,
    availableDates,
    path: points.map(p => [p.latitude, p.longitude]),
    dataFrom,
    dataTo,
    totalPoints: points.length,
    areaCount: result.length,
    totalActiveDuration: formatHMS(totalActiveSeconds),
    totalActiveDurationSeconds: totalActiveSeconds,
    byDate,
    totalAreaSquareFeet: totalAdjustedSqFt,
    totalByUnit: {
      acres: convertSquareFeetToUnitValue(totalAdjustedSqFt, AREA_UNIT_TYPES.ACRES),
      guntha: convertSquareFeetToUnitValue(totalAdjustedSqFt, AREA_UNIT_TYPES.GUNTHA),
      bigha: convertSquareFeetToUnitValue(totalAdjustedSqFt, AREA_UNIT_TYPES.BIGHA),
      squareFeet: totalAdjustedSqFt,
    },
    areas: result,
  };
};

export {analyzeFarming};
