/**
 * Phase 8 Cleanup #2 — Shared Report Request Parsing
 *
 * Goal: eliminate param parsing drift across:
 * - sales.routes.js
 * - voidsComps.routes.js
 * - labor.routes.js
 * - exports.routes.js
 *
 * Reports remain backend-authoritative; this is input normalization only.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function getRestaurantId(req) {
  return req?.actor?.restaurantId ?? null;
}

function asInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function requireQuery(req, keys) {
  for (const k of keys) {
    if (req.query?.[k] === undefined || req.query?.[k] === null || req.query?.[k] === '') {
      return { ok: false, missing: k };
    }
  }
  return { ok: true };
}

function parseTz(req, { defaultTz = 'UTC' } = {}) {
  const rawTz = req.query?.tz;

  if (rawTz !== undefined && typeof rawTz !== 'string') {
    return { ok: false, status: 400, error: 'Invalid tz' };
  }

  const tz = String(rawTz ?? defaultTz).trim();

  // Validate against the runtime's IANA timezone database.
  if (!tz || tz.length > 64) {
    return { ok: false, status: 400, error: 'Invalid tz' };
  }

  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { ok: false, status: 400, error: 'Invalid tz' };
  }

  return { ok: true, tz };
}

function parseDayRange(req) {
  const check = requireQuery(req, ['start_date', 'end_date']);
  if (!check.ok) {
    return { ok: false, status: 400, error: `${check.missing} is required` };
  }

  const start_date = String(req.query.start_date);
  const end_date = String(req.query.end_date);

  // Expect YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    return { ok: false, status: 400, error: 'start_date and end_date must be YYYY-MM-DD' };
  }

  const start = new Date(`${start_date}T00:00:00Z`);
  const end = new Date(`${end_date}T00:00:00Z`);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.toISOString().slice(0, 10) !== start_date ||
    end.toISOString().slice(0, 10) !== end_date
  ) {
    return { ok: false, status: 400, error: 'start_date and end_date must be valid calendar dates' };
  }

  if (start > end) {
    return { ok: false, status: 400, error: 'start_date must be less than or equal to end_date' };
  }

  return { ok: true, start_date, end_date };
}

function parseTimeRange(req) {
  const rawStart = req.query?.start;
  const rawEnd = req.query?.end;

  if (!rawStart && !rawEnd) {
    const now = new Date();
    const startOfRange = new Date(now);
    startOfRange.setDate(startOfRange.getDate() - 30);

    return {
      ok: true,
      start: startOfRange.toISOString(),
      end: now.toISOString(),
    };
  }

  if (!rawStart) {
    return { ok: false, status: 400, error: 'start is required' };
  }

  if (!rawEnd) {
    return { ok: false, status: 400, error: 'end is required' };
  }

  const start = String(rawStart);
  const end = String(rawEnd);

  const isoPattern =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

  function isValidIsoTimestamp(value) {
    const match = isoPattern.exec(value);
    if (!match) return false;

    const [, year, month, day, hour, minute, second, , offset] = match;
    const yearNumber = Number(year);
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    const hourNumber = Number(hour);
    const minuteNumber = Number(minute);
    const secondNumber = Number(second);

    if (
      monthNumber < 1 ||
      monthNumber > 12 ||
      hourNumber > 23 ||
      minuteNumber > 59 ||
      secondNumber > 59
    ) {
      return false;
    }

    const daysInMonth = new Date(
      Date.UTC(yearNumber, monthNumber, 0)
    ).getUTCDate();

    if (dayNumber < 1 || dayNumber > daysInMonth) {
      return false;
    }

    if (offset !== 'Z') {
      const offsetHour = Number(offset.slice(1, 3));
      const offsetMinute = Number(offset.slice(4, 6));

      if (offsetHour > 23 || offsetMinute > 59) {
        return false;
      }
    }

    return !Number.isNaN(new Date(value).getTime());
  }

  if (!isValidIsoTimestamp(start) || !isValidIsoTimestamp(end)) {
    return {
      ok: false,
      status: 400,
      error: 'start and end must be valid ISO-8601 timestamps',
    };
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (startDate > endDate) {
    return {
      ok: false,
      status: 400,
      error: 'start must be less than or equal to end',
    };
  }

  return { ok: true, start, end };
}

function parsePagination(req, { defaultLimit = 200, maxLimit = 1000 } = {}) {
  const limit = clamp(asInt(req.query?.limit, defaultLimit), 1, maxLimit);
  const offset = Math.max(0, asInt(req.query?.offset, 0));
  return { ok: true, limit, offset };
}

function requireRestaurantScope(req) {
  const restaurantId = getRestaurantId(req);
  if (!isUuid(restaurantId)) {
    return { ok: false, status: 400, error: 'restaurant_id missing from auth context' };
  }
  return { ok: true, restaurantId };
}

function sendError(res, parsed) {
  return res.status(parsed.status || 400).json({ error: parsed.error || 'Bad Request' });
}

module.exports = {
  isUuid,
  getRestaurantId,
  requireRestaurantScope,
  parseTz,
  parseDayRange,
  parseTimeRange,
  parsePagination,
  sendError,
};