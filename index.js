const express = require('express');
const bodyParser = require('body-parser');
const supabaseClient = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Supabase ────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('WARNING: SUPABASE_URL or SUPABASE_KEY env vars are not set.');
}

const supabase = supabaseClient.createClient(supabaseUrl, supabaseKey);

// ── OpenF1 helper ────────────────────────────────────────────────────────────
const OPENF1_BASE = 'https://api.openf1.org/v1';

/**
 * Fetch from OpenF1 API. Returns parsed JSON or throws.
 */
async function fetchOpenF1(endpoint, params = {}) {
  const url = new URL(`${OPENF1_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.append(k, v);
    }
  });

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`OpenF1 responded ${response.status} for ${url}`);
  }
  return response.json();
}

/**
 * Cache-aside helper:
 *   1. Check Supabase table for a fresh row (within ttlSeconds).
 *   2. If found, return cached data.
 *   3. Otherwise fetch from OpenF1, upsert into Supabase, return data.
 */
async function cachedFetch(table, cacheKey, fetchFn, ttlSeconds = 30) {
  // Try cache
  const { data: cached, error: cacheErr } = await supabase
    .from(table)
    .select('payload, updated_at')
    .eq('cache_key', cacheKey)
    .single();

  if (!cacheErr && cached) {
    const age = (Date.now() - new Date(cached.updated_at).getTime()) / 1000;
    if (age < ttlSeconds) {
      return { data: cached.payload, fromCache: true };
    }
  }

  // Fetch fresh
  const fresh = await fetchFn();

  // Upsert into Supabase (best-effort — don't fail the request if this errors)
  const { error: upsertErr } = await supabase
    .from(table)
    .upsert(
      { cache_key: cacheKey, payload: fresh, updated_at: new Date().toISOString() },
      { onConflict: 'cache_key' }
    );

  if (upsertErr) {
    console.warn('Supabase upsert warning:', upsertErr.message);
  }

  return { data: fresh, fromCache: false };
}

// ── Error wrapper ─────────────────────────────────────────────────────────────
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Meetings (Race Calendar) ─────────────────────────────────────────────────
// GET /api/meetings?year=2025
app.get(
  '/api/meetings',
  asyncHandler(async (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    const cacheKey = `meetings_${year}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('meetings', { year }),
      300 // 5-minute TTL for schedule data
    );

    res.json(data);
  })
);

// ── Sessions ─────────────────────────────────────────────────────────────────
// GET /api/sessions?year=2025&country_name=Belgium&session_name=Race
app.get(
  '/api/sessions',
  asyncHandler(async (req, res) => {
    const { year, country_name, session_name, meeting_key } = req.query;
    const cacheKey = `sessions_${year || ''}_${country_name || ''}_${session_name || ''}_${meeting_key || ''}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('sessions', { year, country_name, session_name, meeting_key }),
      300
    );

    res.json(data);
  })
);

// ── Latest / current session ──────────────────────────────────────────────────
// GET /api/sessions/latest  →  returns the most recent session
app.get(
  '/api/sessions/latest',
  asyncHandler(async (req, res) => {
    const { data } = await cachedFetch(
      'f1_cache',
      'sessions_latest',
      () => fetchOpenF1('sessions', { session_key: 'latest' }),
      30
    );

    res.json(data);
  })
);

// ── Drivers ───────────────────────────────────────────────────────────────────
// GET /api/drivers?session_key=9158&driver_number=1
app.get(
  '/api/drivers',
  asyncHandler(async (req, res) => {
    const { session_key, driver_number } = req.query;
    const cacheKey = `drivers_${session_key || 'all'}_${driver_number || 'all'}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('drivers', { session_key, driver_number }),
      120
    );

    res.json(data);
  })
);

// ── Laps ──────────────────────────────────────────────────────────────────────
// GET /api/laps?session_key=9161&driver_number=63&lap_number=8
app.get(
  '/api/laps',
  asyncHandler(async (req, res) => {
    const { session_key, driver_number, lap_number } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `laps_${session_key}_${driver_number || 'all'}_${lap_number || 'all'}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('laps', { session_key, driver_number, lap_number }),
      10 // live data — short TTL
    );

    res.json(data);
  })
);

// ── Car Telemetry ─────────────────────────────────────────────────────────────
// GET /api/car_data?session_key=9159&driver_number=55
app.get(
  '/api/car_data',
  asyncHandler(async (req, res) => {
    const { session_key, driver_number } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `car_data_${session_key}_${driver_number || 'all'}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('car_data', { session_key, driver_number }),
      10
    );

    res.json(data);
  })
);

// ── Pit Stops ─────────────────────────────────────────────────────────────────
// GET /api/pit?session_key=9877
app.get(
  '/api/pit',
  asyncHandler(async (req, res) => {
    const { session_key, driver_number } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `pit_${session_key}_${driver_number || 'all'}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('pit', { session_key, driver_number }),
      10
    );

    res.json(data);
  })
);

// ── Stints ────────────────────────────────────────────────────────────────────
// GET /api/stints?session_key=9165&driver_number=55
app.get(
  '/api/stints',
  asyncHandler(async (req, res) => {
    const { session_key, driver_number } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `stints_${session_key}_${driver_number || 'all'}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('stints', { session_key, driver_number }),
      10
    );

    res.json(data);
  })
);

// ── Position / Leaderboard ────────────────────────────────────────────────────
// GET /api/position?session_key=9161&driver_number=63
app.get(
  '/api/position',
  asyncHandler(async (req, res) => {
    const { session_key, driver_number } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `position_${session_key}_${driver_number || 'all'}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('position', { session_key, driver_number }),
      10
    );

    res.json(data);
  })
);

// ── Race Control Messages ─────────────────────────────────────────────────────
// GET /api/race_control?session_key=9161
app.get(
  '/api/race_control',
  asyncHandler(async (req, res) => {
    const { session_key } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `race_control_${session_key}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('race_control', { session_key }),
      10
    );

    res.json(data);
  })
);

// ── Weather ───────────────────────────────────────────────────────────────────
// GET /api/weather?session_key=9161
app.get(
  '/api/weather',
  asyncHandler(async (req, res) => {
    const { session_key } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `weather_${session_key}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('weather', { session_key }),
      30
    );

    res.json(data);
  })
);

// ── Team Radio ────────────────────────────────────────────────────────────────
// GET /api/team_radio?session_key=9161&driver_number=1
app.get(
  '/api/team_radio',
  asyncHandler(async (req, res) => {
    const { session_key, driver_number } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `team_radio_${session_key}_${driver_number || 'all'}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('team_radio', { session_key, driver_number }),
      15
    );

    res.json(data);
  })
);

// ── Intervals (live gaps) ─────────────────────────────────────────────────────
// GET /api/intervals?session_key=9161
app.get(
  '/api/intervals',
  asyncHandler(async (req, res) => {
    const { session_key, driver_number } = req.query;

    if (!session_key) {
      return res.status(400).json({ error: 'session_key is required' });
    }

    const cacheKey = `intervals_${session_key}_${driver_number || 'all'}`;

    const { data } = await cachedFetch(
      'f1_cache',
      cacheKey,
      () => fetchOpenF1('intervals', { session_key, driver_number }),
      10
    );

    res.json(data);
  })
);

// ── SPA fallback — serve index.html for all non-API routes ───────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(port, () => {
  console.log(`ThePitwall API running on port ${port}`);
});

module.exports = app;