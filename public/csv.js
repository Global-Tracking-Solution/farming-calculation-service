// CSV -> array of GPS points. Works in browser and Node.
(function (root) {
  const ALIASES = {
    latitude: ['latitude', 'lat', 'y'],
    longitude: ['longitude', 'lng', 'lon', 'long', 'x'],
    timeStamp: ['timestamp', 'time', 'datetime', 'date time', 'date', 'gpstime', 'createdat', 'devicetime'],
    speed: ['speed', 'speedkmh', 'speed kmh', 'speed (km/h)', 'speed km/h', 'vehiclespeed'],
    heading: ['heading', 'course', 'bearing', 'direction', 'angle'],
  };

  function splitLine(line, delim) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  // "30-10-2026 06:15:30" / "30/10/2026 6:15:30 PM" -> "2026-10-30 06:15:30" ; ISO text is left unchanged.
  // order: 'dmy' = day first (30/10/2026), 'mdy' = month first (10/30/2026)
  const DATE_RE = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/;
  function fixDate(v, order) {
    const m = String(v).trim().match(DATE_RE);
    if (!m) return String(v).trim();
    let [, a, b, y, h, mi, s, ap] = m;
    const d = order === 'mdy' ? b : a;
    const mo = order === 'mdy' ? a : b;
    h = +h;
    if (ap) { ap = ap.toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
    const p = n => String(n).padStart(2, '0');
    return `${y}-${p(mo)}-${p(d)} ${p(h)}:${mi}:${p(s || 0)}`;
  }

  // Look at every date in the file: a first number above 12 proves day-first, a second number above 12
  // proves month-first. If neither proves it (e.g. all dates are 2 Nov), guess day-first and say so.
  function detectDateOrder(values) {
    let dayFirst = false, monthFirst = false, slashDates = 0;
    for (const v of values) {
      const m = String(v).trim().match(DATE_RE);
      if (!m) continue;
      slashDates++;
      if (+m[1] > 12) dayFirst = true;
      if (+m[2] > 12) monthFirst = true;
    }
    if (!slashDates) return {order: 'dmy', guessed: false, hasSlashDates: false};
    if (dayFirst && !monthFirst) return {order: 'dmy', guessed: false, hasSlashDates: true};
    if (monthFirst && !dayFirst) return {order: 'mdy', guessed: false, hasSlashDates: true};
    return {order: 'dmy', guessed: true, hasSlashDates: true};
  }

  function parseCsvToPoints(text, dateOrderOption) {
    text = String(text).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
    const first = lines[0];
    const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const header = splitLine(first, delim).map(h => h.toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim());
    const idx = {};
    for (const key in ALIASES) {
      idx[key] = header.findIndex(h => ALIASES[key].includes(h) || ALIASES[key].includes(h.replace(/ /g, '')));
    }
    if (idx.latitude < 0 || idx.longitude < 0) {
      throw new Error('Could not find latitude/longitude columns. Header found: ' + header.join(' | '));
    }
    const rows = lines.slice(1).map(l => splitLine(l, delim));
    const det = idx.timeStamp >= 0 ? detectDateOrder(rows.map(c => c[idx.timeStamp] || '')) : {order: 'dmy', guessed: false, hasSlashDates: false};
    const order = dateOrderOption === 'dmy' || dateOrderOption === 'mdy' ? dateOrderOption : det.order;
    const orderGuessed = det.hasSlashDates && det.guessed && !(dateOrderOption === 'dmy' || dateOrderOption === 'mdy');
    const points = [];
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      const lat = parseFloat(c[idx.latitude]), lng = parseFloat(c[idx.longitude]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const p = {latitude: lat, longitude: lng};
      if (idx.timeStamp >= 0 && c[idx.timeStamp]) p.timeStamp = fixDate(c[idx.timeStamp], order);
      if (idx.speed >= 0 && c[idx.speed] !== '' && isFinite(+c[idx.speed])) p.speed = +c[idx.speed];
      if (idx.heading >= 0 && c[idx.heading] !== '' && isFinite(+c[idx.heading])) p.heading = +c[idx.heading];
      points.push(p);
    }
    if (!points.length) throw new Error('No valid rows found (check latitude/longitude values)');
    return {points, columns: Object.keys(idx).filter(k => idx[k] >= 0), dateOrder: order, dateOrderGuessed: orderGuessed};
  }

  // Excel stores a date as a number (days since 1899-12-30). Read that number directly instead of
  // the cell's display text, because the display text can be US month/day order with seconds cut off.
  function excelSerialToString(serial) {
    const secs = Math.round((serial - 25569) * 86400);
    const d = new Date(secs * 1000);
    const p = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
      p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
  }

  // Excel rows (array of objects from SheetJS sheet_to_json with {raw:true}) -> points
  function excelRowsToPoints(rows, dateOrderOption) {
    if (!rows || !rows.length) throw new Error('The Excel sheet is empty');
    const header = Object.keys(rows[0]);
    const norm = h => String(h).toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const timeCols = new Set(header.filter(h => ALIASES.timeStamp.includes(norm(h)) || ALIASES.timeStamp.includes(norm(h).replace(/ /g, ''))));
    const cell = (h, v) => {
      if (timeCols.has(h)) {
        if (typeof v === 'number' && v > 20000 && v < 80000) return excelSerialToString(v);
        if (v instanceof Date) return excelSerialToString(v.getTime() / 86400000 + 25569);
      }
      return v;
    };
    const esc = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const csv = [header.map(esc).join(',')].concat(rows.map(r => header.map(h => esc(cell(h, r[h]))).join(','))).join('\n');
    return parseCsvToPoints(csv, dateOrderOption);
  }

  root.parseCsvToPoints = parseCsvToPoints;
  root.excelRowsToPoints = excelRowsToPoints;
  if (typeof module !== 'undefined') module.exports = {parseCsvToPoints, excelRowsToPoints};
})(typeof window !== 'undefined' ? window : globalThis);
