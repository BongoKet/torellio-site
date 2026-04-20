/**
 * Torellio Cloudflare Worker
 * 
 * Endpoints:
 *   POST /api/waitlist  — saves email + timestamp to KV
 *   POST /api/ideas     — saves feature request to KV
 *   GET  /api/export    — returns all data as JSON (for Sheets import)
 * 
 * KV Bindings needed (set in wrangler.toml or Cloudflare dashboard):
 *   TORELLIO_KV
 * 
 * Environment variables needed:
 *   EXPORT_SECRET  — a password you choose to protect the export endpoint
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // ── POST /api/waitlist ──────────────────────────────────────────────────
    if (url.pathname === '/api/waitlist' && request.method === 'POST') {
      try {
        const { email } = await request.json();

        if (!email || !email.includes('@')) {
          return json({ error: 'Valid email required' }, 400);
        }

        const normalised = email.toLowerCase().trim();

        // Check for duplicates
        const existing = await env.TORELLIO_KV.get(`waitlist:${normalised}`);
        if (existing) {
          return json({ success: true, message: 'already_registered' });
        }

        // Store in KV — key includes email for dedup, value has metadata
        const entry = {
          email: normalised,
          joined_at: new Date().toISOString(),
          source: request.headers.get('Referer') || 'direct',
        };

        await env.TORELLIO_KV.put(
          `waitlist:${normalised}`,
          JSON.stringify(entry)
        );

        // Also keep a counter
        const count = parseInt(await env.TORELLIO_KV.get('waitlist:_count') || '0');
        await env.TORELLIO_KV.put('waitlist:_count', String(count + 1));

        return json({ success: true, message: 'added' });

      } catch (err) {
        return json({ error: 'Something went wrong' }, 500);
      }
    }

    // ── POST /api/ideas ─────────────────────────────────────────────────────
    if (url.pathname === '/api/ideas' && request.method === 'POST') {
      try {
        const { idea, category, email } = await request.json();

        if (!idea || idea.trim().length < 10) {
          return json({ error: 'Please describe your idea in a bit more detail' }, 400);
        }

        const id = `idea:${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        const entry = {
          id,
          idea: idea.trim(),
          category: category || 'Other',
          email: email ? email.toLowerCase().trim() : null,
          submitted_at: new Date().toISOString(),
        };

        await env.TORELLIO_KV.put(id, JSON.stringify(entry));

        // Counter
        const count = parseInt(await env.TORELLIO_KV.get('ideas:_count') || '0');
        await env.TORELLIO_KV.put('ideas:_count', String(count + 1));

        return json({ success: true });

      } catch (err) {
        return json({ error: 'Something went wrong' }, 500);
      }
    }

    // ── GET /api/export ─────────────────────────────────────────────────────
    // Protected endpoint — hit this to get all data as JSON, then paste into Sheets
    // Usage: GET /api/export?secret=YOUR_SECRET&type=waitlist
    //        GET /api/export?secret=YOUR_SECRET&type=ideas
    if (url.pathname === '/api/export' && request.method === 'GET') {
      const secret = url.searchParams.get('secret');
      const type = url.searchParams.get('type') || 'waitlist';

      if (!secret || secret !== env.EXPORT_SECRET) {
        return json({ error: 'Unauthorised' }, 401);
      }

      const prefix = type === 'ideas' ? 'idea:' : 'waitlist:';
      const listed = await env.TORELLIO_KV.list({ prefix });

      const entries = [];
      for (const key of listed.keys) {
        // Skip counter keys
        if (key.name.includes('_count')) continue;
        const val = await env.TORELLIO_KV.get(key.name);
        if (val) entries.push(JSON.parse(val));
      }

      // Sort by date
      entries.sort((a, b) =>
        new Date(b.joined_at || b.submitted_at) - new Date(a.joined_at || a.submitted_at)
      );

      return json({ count: entries.length, data: entries });
    }

    // ── GET /api/stats ──────────────────────────────────────────────────────
    // Public endpoint — shows just the counts (useful for displaying on site)
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      const waitlist = await env.TORELLIO_KV.get('waitlist:_count') || '0';
      const ideas = await env.TORELLIO_KV.get('ideas:_count') || '0';
      return json({ waitlist: parseInt(waitlist), ideas: parseInt(ideas) });
    }

    return json({ error: 'Not found' }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
