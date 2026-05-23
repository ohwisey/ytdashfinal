// ============================================================
// POST /api/sleep-log — receives a sleep row from the iOS Shortcut
// and upserts it into the user's Supabase `sleep_logs` table.
//
// Auth:   Authorization: Bearer <SLEEP_API_SECRET>
// Body:   { sleep_start: ISO8601, wake_time: ISO8601, duration_hours?: number }
// Reply:  { ok: true, row: <inserted row> }   on success
//         { error: '...' }                    on failure (status 400/401/500)
//
// Vercel: drop into the host dashboard's `api/` folder. Set env vars
// SUPABASE_URL, SUPABASE_SERVICE_KEY, SLEEP_API_SECRET in Vercel.
// ============================================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // ----- CORS (so the function is callable from anywhere, incl. Shortcut) -----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ----- Auth: shared secret in the Authorization header -----
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const expected = process.env.SLEEP_API_SECRET;
  if (!expected) {
    console.error('SLEEP_API_SECRET env var is not set');
    return res.status(500).json({ error: 'server misconfigured' });
  }
  if (!token || token !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // ----- Parse body -----
  // Vercel parses JSON automatically when Content-Type: application/json,
  // but Shortcuts sometimes sends as a string — handle both.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { sleep_start, wake_time } = body;
  let { duration_hours } = body;

  if (!sleep_start || !wake_time) {
    return res.status(400).json({ error: 'sleep_start and wake_time are required (ISO 8601)' });
  }

  const startDate = new Date(sleep_start);
  const wakeDate  = new Date(wake_time);
  if (isNaN(startDate.getTime()) || isNaN(wakeDate.getTime())) {
    return res.status(400).json({ error: 'sleep_start / wake_time must be valid ISO 8601' });
  }

  // Compute duration if the Shortcut didn't send it.
  if (duration_hours == null || isNaN(Number(duration_hours))) {
    duration_hours = (wakeDate.getTime() - startDate.getTime()) / 3600000;
  }
  duration_hours = Math.round(Number(duration_hours) * 100) / 100;

  // Sanity bound — anything outside [0, 24] is almost certainly garbage.
  if (duration_hours < 0 || duration_hours > 24) {
    return res.status(400).json({ error: 'duration_hours out of range', got: duration_hours });
  }

  // Use the LOCAL date of wake-up as the row key. The Shortcut sends ISO
  // strings with timezone offsets, so wakeDate already represents the
  // correct moment — we just need its YYYY-MM-DD in the wake's local tz.
  // Trick: build the date from the raw string's date portion if present.
  const isoWake = String(wake_time);
  let date;
  const m = isoWake.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    date = `${m[1]}-${m[2]}-${m[3]}`;
  } else {
    // Fallback to UTC date
    const y = wakeDate.getUTCFullYear();
    const mo = String(wakeDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(wakeDate.getUTCDate()).padStart(2, '0');
    date = `${y}-${mo}-${d}`;
  }

  // ----- Insert into Supabase -----
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL or SUPABASE_SERVICE_KEY env var not set');
    return res.status(500).json({ error: 'server misconfigured' });
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await supabase
    .from('sleep_logs')
    .upsert(
      { date, sleep_start, wake_time, duration_hours },
      { onConflict: 'date' }
    )
    .select()
    .single();

  if (error) {
    console.error('supabase upsert failed', error);
    return res.status(500).json({ error: 'db write failed', detail: error.message });
  }

  return res.status(200).json({ ok: true, row: data });
}
