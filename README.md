# Farming Report API

Send a vehicle's GPS points, get back the farmed plots as **polygons (latitude/longitude)** plus the
**calculations** (area in guntha / acres / bigha / hectares, date, start & end time, farming duration)
ready to draw on a map and show on a screen.

Works for trackers that report every few seconds **and** for sparse trackers (a point every 20-60 s, 30-70 m apart).

---------------------------------------------------------------------

## 1. Run it locally (2 minutes)

    npm install
    npm start                     # node server.js -> http://localhost:3000   (test page with map + file upload at "/")
    npm run dev                   # same, restarts on file changes
    npm test                      # 15 API tests

The test page at `/` lets you upload a CSV / Excel / JSON file and see the plots on a satellite map.
It is switched **off** in production (`SERVE_TEST_PAGE=false`).

### Project structure

    server.js                         entry point: loads .env (if present), starts the HTTP server, graceful shutdown
    src/
      app.js                          Express app: security headers, CORS, logging, JSON body, routes, errors
      config/index.js                 settings from environment variables (+ VERSION)
      routes/index.js                 GET /health, POST /api/v1/farming/analyze, GET /
      controllers/                    request handlers (farming.controller.js, health.controller.js)
      middlewares/                    auth (API keys), rateLimiter, requestLogger, errorHandler (404 + errors)
      validators/farming.validator.js request body checks
      services/
        jobRunner.js                  runs analyses in worker threads (limit, queue, timeout)
        farming/farmingEngine.js      detection engine (analyzeFarming)
        farming/inputNormalizer.js    accepts many point formats -> engine format
        farming/responseFormatter.js  engine result -> API response
      workers/analyze.worker.js       worker thread that calls the engine
      utils/response.js               error response helper
    public/                           test page (only served when SERVE_TEST_PAGE=true)
    test/api.test.js                  API tests (fixtures in test/fixtures)
    deploy/                           IIS: web.config + deploy-iis.ps1
    docs/openapi.yaml                 API spec

---------------------------------------------------------------------

## 2. The API

### `POST /api/v1/farming/analyze`

Headers: `Content-Type: application/json` and `X-API-Key: <key>` (or `Authorization: Bearer <key>`).
Send **one vehicle for one day (or trip) per request.**

**Request body**

Send the GPS data **either** as `points`, **or** as `deviceId` + `fromDate` + `toDate`. With a device, the server reads
the points from MySQL (`CALL usp_history_replay(deviceId, fromDate, toDate)`). It uses only latitude, longitude,
time_stamp and speed, and returns exactly the same response as if those points had been sent.

    {"deviceId": 1555, "fromDate": "2026-10-12 00:00:00", "toDate": "2026-10-12 23:00:00",
     "farmingPercent": 0, "date": "2026-10-12", "mode": "auto", "includePath": true}

| field | required | meaning |
|---|---|---|
| `deviceId` | instead of `points` | device id passed to `usp_history_replay` |
| `fromDate` / `toDate` | with `deviceId` | `"2026-10-12 00:00:00"`, IST, sent to the SP as is. A date alone means 00:00:00 / 23:59:59 |
| `points` | if no `deviceId` | array of GPS points, oldest first (unordered input is sorted by time). Max 200,000. |
| `date` | no | `"2026-11-02"` - analyse only that day |
| `mode` | no | `auto` (default), `sparse`, `dense` - auto measures your data and picks |
| `farmingPercent` | no | 0-100, optional reduction applied to every area |
| `includePoints` | no | `true` = add the raw GPS points used for each area (bigger response) |
| `includePath` | no | `true` = add the whole travelled path `[[lat,lng],...]` |

**A point** - any of these shapes work:

    {"latitude": 18.141023, "longitude": 74.88322, "timeStamp": "2026-11-02 11:02:35", "speed": 6}
    {"lat": 18.141023, "lng": 74.88322, "time": "2026-11-02T11:02:35", "speed": 6}
    [18.141023, 74.88322, "2026-11-02 11:02:35", 6]            // [lat, lng, time, speed]

- Timestamps: ISO text, `YYYY-MM-DD HH:mm:ss`, `DD-MM-YYYY hh:mm A`, or epoch seconds/milliseconds.
  **Send seconds** (`11:02:35`, not `11:02`) for exact farming time. Without timestamps the plots can still
  be drawn, but farming time is not available and detection is less reliable (a warning is returned).
- `speed` is km/h and optional.
- Points with missing/invalid coordinates or exactly (0,0) are ignored and reported in `warnings`.

**Response (real output for a sparse tracker, shortened)**

```json
{
  "status": true,
  "data": {
    "summary": {
      "areaCount": 2,
      "totalArea": {
        "acres": 9.7478,
        "guntha": 389.91,
        "bigha": 15.596,
        "squareFeet": 424614,
        "squareMeters": 39448,
        "hectares": 3.9448
      },
      "totalFarmingTime": {
        "seconds": 6141,
        "label": "1 Hrs 42 min 21 sec"
      },
      "dataFrom": "2026-11-02 00:00:47",
      "dataTo": "2026-11-02 23:43:32",
      "pointsReceived": 1630,
      "pointsUsed": 1630
    },
    "areas": [
      {
        "id": 1,
        "date": "2026-11-02",
        "startTime": "2026-11-02 10:57:47",
        "endTime": "2026-11-02 12:10:46",
        "farmingTime": {
          "seconds": 3708,
          "label": "1 Hrs 1 min 48 sec"
        },
        "areaByUnit": {
          "acres": 4.9317,
          "guntha": 197.27,
          "bigha": 7.891,
          "squareFeet": 214826,
          "squareMeters": 19958,
          "hectares": 1.9958
        },
        "areaSquareMeters": 19958,
        "polygon": [
          {
            "latitude": 18.1447517,
            "longitude": 74.8853925
          },
          {
            "latitude": 18.1447607,
            "longitude": 74.8854303
          },
          "... more vertices ..."
        ],
        "center": {
          "latitude": 18.1456199,
          "longitude": 74.8844653
        },
        "region": {
          "latitude": 18.1455611,
          "longitude": 74.8844698,
          "latitudeDelta": 0.003,
          "longitudeDelta": 0.0031089
        },
        "widthMeters": 258.9,
        "heightMeters": 111.8,
        "pathLengthMeters": 4177.1,
        "turnCount": 46,
        "passCount": 95,
        "rowSpacingMeters": 3.5,
        "detectionMode": "sparse"
      },
      "... second plot ..."
    ],
    "availableDates": [
      {
        "date": "2026-11-02",
        "pointCount": 1630
      }
    ],
    "detectionMode": "sparse",
    "sampling": {
      "medianStepMeters": 30.1,
      "medianIntervalSeconds": 18,
      "timeResolutionSeconds": 1,
      "isSparse": true
    }
  },
  "warnings": [],
  "meta": {
    "processingMs": 870,
    "version": "1.0.0"
  }
}
```

- `polygon` = outline of one plot, `[{latitude, longitude}, ...]` - draw it as a closed polygon.
- `region` is ready for react-native-maps (`initialRegion` / `animateToRegion`).
- Coordinates are rounded to 7 decimals (about 1 cm). The response is about 15 KB (about 3 KB gzipped) for a full day.
- `warnings` lists anything worth telling the user (ignored points, missing timestamps, re-sorted input).

**Errors** are always `{"status": false, "code": "...", "message": "..."}`

| HTTP | code | meaning |
|---|---|---|
| 400 | `BAD_REQUEST`, `BAD_JSON` | invalid field / body is not JSON |
| 401 | `UNAUTHORIZED` | missing or wrong API key |
| 413 | `TOO_MANY_POINTS`, `BODY_TOO_LARGE` | send fewer points (one day at a time) |
| 422 | `NOT_ENOUGH_POINTS` | fewer than 2 valid points |
| 429 | `RATE_LIMITED` | too many requests (default 60/min per key) |
| 404 | `NO_DATA` | `deviceId` request: no GPS records in that time range |
| 502 | `DB_ERROR` | `deviceId` request: database could not be reached / SP failed |
| 503 | `DB_NOT_CONFIGURED` | `deviceId` request but `DB_CONNECTION_STRING` is not set |
| 503 | `BUSY` | all workers busy and queue full - retry after `Retry-After` seconds |
| 504 | `TIMEOUT` | analysis exceeded `JOB_TIMEOUT_SECONDS` - send fewer points |

`GET /health` (no key) -> `{"ok": true, "running": 0, "queued": 0, ...}` for load balancers / uptime monitors.

Full machine-readable spec: `docs/openapi.yaml` (open it in Swagger Editor or import into Postman).
The old route `/api/farming/analyze` still works and behaves the same.

---------------------------------------------------------------------

## 3. Using it from your front end

`area.polygon` is already `{latitude, longitude}` points, so it can go straight into a `react-native-maps` `<Polygon>`.
`api.http` has ready-to-send requests (VS Code "REST Client" extension).

Google Maps (web):

    new google.maps.Polygon({
      paths: area.polygon.map(p => ({lat: p.latitude, lng: p.longitude})),
      strokeColor: '#39ff14', fillColor: '#39ff14', fillOpacity: 0.3, map
    });

**Keep the API key safe.** A key inside a mobile app or website can be extracted. Use one key per client so you can
revoke one without breaking the others, and prefer having **your own backend call this API** and pass results on to the apps.

---------------------------------------------------------------------

## 4. Deploy to a server

### Windows Server + IIS

Node runs `server.js` as a Windows service (NSSM) on port **3001**; IIS listens on port **3000** and forwards
every request to it (URL Rewrite + ARR, see `deploy/web.config`). Copy this folder to the server, edit the
SETTINGS block at the top of `deploy/deploy-iis.ps1`, then in PowerShell **as Administrator**:

    Set-ExecutionPolicy Bypass -Scope Process -Force
    .\deploy\deploy-iis.ps1

It installs IIS, URL Rewrite, ARR, Node.js and NSSM if missing, copies the app to `C:\apps\farming-api`,
creates the service and the IIS site, opens the firewall port and tests `/health`. Re-run it to deploy updates.

    C:\tools\nssm\nssm.exe restart FarmingAPI           # restart the API
    Get-Content C:\apps\farming-api\logs\err.log -Tail 50

### Any other host
Build `npm ci --omit=dev`, start `npm start` (`node server.js`). Set the environment variables below
(at least `NODE_ENV=production`, `API_KEYS`, `TZ`), or put them in a `.env` file next to `server.js`.
Variables already set in the environment win over `.env`.

### Production checklist
- [ ] `API_KEYS` set (the server **refuses to start** in production without keys)
- [ ] HTTPS in front (IIS binding with a certificate, e.g. win-acme)
- [ ] `TZ` set to your timezone (timestamps ending in `Z` / epoch numbers are converted to it)
- [ ] `CORS_ORIGINS` lists your website (not needed for mobile apps)
- [ ] `TRUST_PROXY=1` when behind IIS / a load balancer, so rate limits see the real client IP
- [ ] `SERVE_TEST_PAGE=false` (default in production)
- [ ] uptime monitor on `/health`

### Configuration (environment variables)

| variable | default | meaning |
|---|---|---|
| `PORT` | 3000 | listen port |
| `API_KEYS` | - | comma separated keys, **required in production** |
| `CORS_ORIGINS` | none (dev: any) | allowed website origins, comma separated |
| `RATE_LIMIT_PER_MIN` | 60 | requests per minute per key |
| `MAX_POINTS` | 200000 | points per request |
| `MAX_BODY_MB` | 25 | request size |
| `MAX_CONCURRENT` | CPU cores | analyses running at once (each uses one core) |
| `MAX_QUEUE` | 20 | extra requests allowed to wait, beyond that 503 |
| `JOB_TIMEOUT_SECONDS` | 120 | per-analysis time limit |
| `TRUST_PROXY` | 1 in production | number of proxies in front |
| `TZ` | system | timezone for timestamps |
| `DB_CONNECTION_STRING` | - | MySQL, `Server=..;Database=..;User ID=..;Password=..;Port=3306;SslMode=None;` - needed for `deviceId` requests (one connection per request) |
| `SERVE_TEST_PAGE` | off in production | upload/map test page at `/` |

### How it behaves under load
Each analysis runs in its own worker thread, so heavy requests never freeze the server: with 6 heavy requests at once
and 2 workers, `/health` kept answering in 1-2 ms and all 6 requests succeeded (2 running, 4 queued).
Typical day (about 1,600 points) takes under 1 second. Capacity: roughly 1 request/second per CPU core for such a day.
Logs are one JSON line per request (time, path, status, duration, client IP, point count) - GPS data is never logged.

---------------------------------------------------------------------

## 5. How detection works

The server measures how often your tracker reports and picks a method (`detectionMode` in the response):

- **dense** (a point every few seconds): finds areas where the vehicle repeatedly covers the same ground, trims
  the strips the vehicle drives along between plots, and splits plots that were joined by such a strip.
- **sparse** (a point every 20-60 s, 30-70 m apart): looks for many near-parallel passes lying side by side, made close
  together in time (a road, a single trip or a parked vehicle never looks like that), then pulls in the edge rows.

Tuning (constants at the top of `src/services/farming/farmingEngine.js`):
- connecting strip between plots still visible -> raise `NECK_OPENING_FACTOR` (2.0 -> 2.5/3)
- sparse: field missed -> lower `SPARSE_MIN_NEIGHBOR_PASSES` (4) or raise `SPARSE_MAX_ROW_OFFSET_METERS` (10, wide implements)
- sparse: road marked as field -> raise `SPARSE_MIN_NEIGHBOR_PASSES` or `SPARSE_MIN_FIELD_WIDTH_METERS`
- sparse: vehicle works faster -> `SPARSE_MAX_SPEED_KMH` (14)

Known limits: rows that were never driven (no GPS passes) are not "seen"; two plots that touch each other are reported as one;
fields worked in two sessions hours apart are reported as two areas (one per session).

---------------------------------------------------------------------

## 6. Tests

    npm test                                  # API: auth, validation, formats, detection, limits, timeouts (15 tests)
