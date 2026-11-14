/* ═══════════════════════════════════════════════════════
   YourVibe — API server (Node + Express)
   Serves the static app AND the video API.

   POST   /api/videos            (multipart: video, thumb?, title, description, category, type, duration, uploader)
   GET    /api/videos
   DELETE /api/videos/:id        { del_key }
   POST   /api/videos/:id/like   { delta: +1 | -1 }
   POST   /api/videos/:id/view
   GET    /api/videos/:id/comments
   POST   /api/videos/:id/comments { author, text }
   GET    /api/creators          → { name: subscriberCount }
   POST   /api/admin/video/:id/{views|likes|subs|comments}  { n }   (X-Admin-Key required)
   GET    /api/health

   Files live in Supabase Storage (public bucket "media"),
   metadata in Supabase Postgres. Env vars:
     SUPABASE_URL, SUPABASE_SERVICE_KEY, DATABASE_URL, ADMIN_KEY?
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const Busboy = require('busboy');
const multer = require('multer');
const { Client, Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const dns = require('dns');
const https = require('https');

/* Supabase db.* hosts resolve to IPv6 first (or only), but Render free
   instances have no IPv6 egress — force IPv4. */
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, X-Auth, X-Upload-Offset');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

/* ── Bunny Stream config ── */
const BUNNY_LIBRARY = process.env.BUNNY_LIBRARY_ID || '';
const BUNNY_KEY = process.env.BUNNY_API_KEY || '';

/* serve Bunny credentials to the browser (for direct uploads) */
app.get('/api/bunny', (req, res) => {
  if (!BUNNY_LIBRARY || !BUNNY_KEY) return res.json(null);
  res.json({ libraryId: BUNNY_LIBRARY, apiKey: BUNNY_KEY });
});

/* publish a video stored on Bunny CDN */
app.post('/api/videos/bunny', async (req, res) => {
  try {
    const b = req.body || {};
    const guid = String(b.guid || '');
    if (!/^[a-f0-9-]{36}$/i.test(guid)) return res.status(400).json({ error: 'bad guid' });
    const authName = await authUser(req);
    const uploader = authName || String(b.uploader || 'Anonymous').slice(0, 50);
    const delKey = crypto.randomBytes(16).toString('hex');
    const title = String(b.title || 'Untitled vibe').slice(0, 100);
    const description = String(b.description || '').slice(0, 2000);
    const category = String(b.category || 'Other').slice(0, 30);
    const type = b.type === 'short' ? 'short' : 'video';

    /* client thumbnail (auto-captured or custom) → stored instantly */
    let thumbUrl = null;
    const thumbData = String(b.thumb || '');
    if (thumbData.startsWith('data:image/') && thumbData.length < 2000000) {
      try {
        const tp = 'thumbs/' + guid + '.jpg';
        await sbPut(tp, Buffer.from(thumbData.split(',')[1], 'base64'), 'image/jpeg');
        thumbUrl = pubUrl(tp);
      } catch (e) { console.error('thumb store failed:', e.message); }
    }

    /* duration now; Bunny fills its own thumbnail in later (bg job, only if client sent none) */
    let duration = String(b.duration || '').slice(0, 10);
    try {
      const bv = await fetch('https://video.bunnycdn.com/library/' + BUNNY_LIBRARY + '/videos/' + guid, { headers: { AccessKey: BUNNY_KEY } });
      if (bv.ok) {
        const info = await bv.json();
        if (info.length) duration = Math.floor(info.length / 60) + ':' + String(Math.floor(info.length % 60)).padStart(2, '0');
      }
    } catch (e) {}

    const embedUrl = 'https://iframe.mediadelivery.net/' + BUNNY_LIBRARY + '/' + guid;

    await q(`insert into videos (id,title,description,category,type,duration,uploader,video_path,thumb_path,video_url,thumb_url,del_key,parts,sizes,store,bunny_guid)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'bunny',$15)`,
      [guid, title, description, category, type, duration, uploader, 'bunny:'+guid, null, embedUrl, thumbUrl, delKey, 1, '[0]', guid]);

    try { await q('insert into creators (name, subs) values ($1, 0) on conflict (name) do nothing', [uploader]); } catch (e) {}

    /* bg: if no client thumbnail, pick up Bunny's generated one when ready */
    if (!thumbUrl) {
      (async () => {
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 10000));
          try {
            const bv = await fetch('https://video.bunnycdn.com/library/' + BUNNY_LIBRARY + '/videos/' + guid, { headers: { AccessKey: BUNNY_KEY } });
            if (!bv.ok) continue;
            const info = await bv.json();
            if (info.thumbnailUrl) {
              await q('update videos set thumb_url = $2 where id = $1 and thumb_url is null', [guid, info.thumbnailUrl]);
              metaCache.delete(guid);
              console.log('bunny thumbnail ready:', guid);
              return;
            }
          } catch (e) {}
        }
      })();
    }

    res.status(201).json({ id: guid, video_url: embedUrl, thumb_url: thumbUrl, del_key: delKey, parts: 1, store: 'bunny' });

    /* background: wait for Bunny to finish processing, then store the real
       thumbnail + duration (Bunny needs ~1 min to encode) */
    (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 10000));
        try {
          const bv = await fetch('https://video.bunnycdn.com/library/' + BUNNY_LIBRARY + '/videos/' + guid, { headers: { AccessKey: BUNNY_KEY } });
          if (!bv.ok) continue;
          const info = await bv.json();
          if (info.thumbnailUrl) {
            const host = new URL(info.thumbnailUrl).hostname;
            const dur = info.length ? Math.floor(info.length / 60) + ':' + String(Math.floor(info.length % 60)).padStart(2, '0') : duration;
            const play = 'https://' + host + '/' + guid + '/play_' + bestRendition(info.availableResolutions) + '.mp4';
            await q('update videos set thumb_url = $2, duration = $3, video_url = $4 where id = $1', [guid, info.thumbnailUrl, dur, play]);
            metaCache.delete(guid);
            console.log('bunny ready:', guid, '→', play);
            return;
          }
        } catch (e) {}
      }
    })();
  } catch (e) {
    console.error('bunny publish error:', e.message);
    res.status(500).json({ error: 'publish failed' });
  }
});

/* crash shields: log async errors instead of letting them kill the process */
process.on('unhandledRejection', e => console.error('unhandled rejection:', (e && e.message) || e));
process.on('uncaughtException', e => console.error('uncaught exception:', (e && e.message) || e));
const MAX_MB = 50;
const ADMIN_KEY = process.env.ADMIN_KEY || 'neon-admin';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const DB_URL = process.env.DATABASE_URL || '';

/* ── GitHub Releases storage (no-card, big files) ── */
const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_MEDIA_REPO || '';
const ghMode = () => !!(GH_TOKEN && GH_REPO);
const ghPartUrl = (id, i) => `https://github.com/${GH_REPO}/releases/download/v-${id}/part${i}.mp4`;

async function ghApi(path, opts = {}) {
  return fetch(path.startsWith('http') ? path : 'https://api.github.com' + path, Object.assign({}, opts, {
    headers: Object.assign({
      Authorization: 'Bearer ' + GH_TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'yourvibe',
    }, opts.headers || {}),
  }));
}

/* get-or-create the release that holds one video's segments (race-safe:
   parallel segment workers may create the same release simultaneously) */
async function ghReleaseId(tag) {
  let r = await ghApi(`/repos/${GH_REPO}/releases/tags/${tag}`);
  if (r.status === 200) return (await r.json()).id;
  r = await ghApi(`/repos/${GH_REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag }),
  });
  if (r.status === 201) return (await r.json()).id;
  if (r.status === 422) { // another worker created it first — look it up
    const g = await ghApi(`/repos/${GH_REPO}/releases/tags/${tag}`);
    if (g.status === 200) return (await g.json()).id;
  }
  throw new Error('release create failed (' + r.status + ') ' + (await r.text()).slice(0, 120));
}

/* upload one segment as a release asset (replaces on name conflict) */
async function ghPutAsset(tag, name, buffer, ctype) {
  const rid = await ghReleaseId(tag);
  const up = async () => await ghApi(
    `https://uploads.github.com/repos/${GH_REPO}/releases/${rid}/assets?name=${name}`,
    { method: 'POST', headers: { 'Content-Type': ctype || 'video/mp4' }, body: buffer });
  let r = await up();
  if (r.status === 422) { // asset name exists → delete and retry once
    const list = await (await ghApi(`/repos/${GH_REPO}/releases/${rid}/assets`)).json();
    for (const a of (list || [])) if (a.name === name) await ghApi(`/repos/${GH_REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
    r = await up();
  }
  if (r.status !== 201) throw new Error('asset upload failed (' + r.status + ') ' + (await r.text()).slice(0, 120));
  return await r.json();
}

/* ── CORS (static site calls this API cross-origin) ── */
/* ── Postgres (Supabase) with auto-reconnect ── */
let migrated = false;
let DB_CFG = null;
let pgPool = null;

/* Build a connection config with an IPv4 address (Render free has no IPv6) */
async function dbConfig() {
  if (DB_CFG) return DB_CFG;
  const u = new URL(DB_URL);
  let host = u.hostname;
  try {
    host = await new Promise((res, rej) =>
      dns.lookup(u.hostname, { family: 4 }, (e, addr) => e ? rej(e) : res(addr)));
  } catch (e) { /* keep hostname */ }
  DB_CFG = {
    host,
    port: u.port || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: (u.pathname || '/postgres').slice(1) || 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  };
  return DB_CFG;
}

/* Postgres via a small pool (safe for concurrent requests + merge worker) */
async function getPool() {
  if (pgPool) return pgPool;
  const cfg = await dbConfig();
  pgPool = new Pool({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, ssl: cfg.ssl,
    max: 4, idleTimeoutMillis: 30000,
  });
  pgPool.on('error', () => {});
  return pgPool;
}

async function q(sql, params) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const pool = await getPool();
      return await pool.query(sql, params);
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 350));
    }
  }
}

async function migrate() {
  await q(`create table if not exists videos (
    id uuid primary key,
    title text not null,
    description text default '',
    category text default 'Other',
    type text default 'video',
    duration text default '',
    uploader text not null,
    video_path text not null,
    thumb_path text,
    video_url text not null,
    thumb_url text,
    views bigint default 0,
    likes bigint default 0,
    del_key text not null,
    created_at timestamptz default now()
  )`);
  await q(`create table if not exists comments (
    id bigserial primary key,
    video_id uuid references videos(id) on delete cascade,
    author text not null,
    text text not null,
    created_at timestamptz default now()
  )`);
  await q(`create index if not exists comments_video_idx on comments(video_id)`);
  await q(`create table if not exists creators (
    name text primary key,
    subs bigint default 0
  )`);
  await q(`alter table videos add column if not exists parts int default 1`);
  await q(`alter table videos add column if not exists sizes jsonb default '[]'`);
  await q(`alter table videos add column if not exists store text default 'sb'`);
  await q(`alter table videos add column if not exists bunny_guid text`);
  await q(`update videos set bunny_guid = replace(video_path, 'bunny:', '') where store = 'bunny' and bunny_guid is null`);
  await q(`alter table videos add column if not exists merge_state text default 'idle'`);
  await q(`create table if not exists users (
    username text primary key,
    pass_hash text not null,
    token text,
    created_at timestamptz default now()
  )`);
  await q(`alter table users add column if not exists avatar text`);
  await q(`alter table users add column if not exists banner text`);
  await q(`alter table users add column if not exists avatar_url text`);
  await q(`alter table users add column if not exists banner_url text`);
  await q(`alter table users add column if not exists bio text`);
  await q(`create table if not exists polls (
    id uuid primary key default gen_random_uuid(),
    video_id uuid references videos(id) on delete cascade,
    question text not null,
    options jsonb not null,
    created_at timestamptz default now()
  )`);
  await q(`create table if not exists poll_votes (
    poll_id uuid references polls(id) on delete cascade,
    voter text not null,
    opt int not null,
    created_at timestamptz default now(),
    primary key (poll_id, voter)
  )`);
  await q(`create table if not exists announcements (
    id bigserial primary key,
    text text not null,
    created_at timestamptz default now()
  )`);
  await q(`insert into storage.buckets (id, name, public)
           values ('media', 'media', true) on conflict (id) do nothing`);
  migrated = true;
}

/* ── auth helpers (scrypt, no external deps) ── */
const hashPass = (pass) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pass, salt, 64).toString('hex');
};
const verifyPass = (pass, stored) => {
  const [salt, key] = String(stored || '').split(':');
  if (!salt || !key) return false;
  const h = crypto.scryptSync(pass, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(key));
};
async function authUser(req) {
  const token = req.get('x-auth');
  if (!token || !/^[a-f0-9]{20,80}$/.test(token)) return null;
  try {
    const r = await q('select username from users where token = $1', [token]);
    return r.rows.length ? r.rows[0].username : null;
  } catch (e) { return null; }
}

/* retry migration until it works (DB may not be ready on first boot) */
(function migrateLoop() {
  migrate().then(async () => {
    /* a merge left 'running' across a restart = it crashed the server →
       mark it failed and NEVER retry it (this is what stops crash loops) */
    try {
      await q("update videos set merge_state = 'failed' where merge_state = 'running'");
      const r = await q("select id from videos where parts > 1 and merge_state = 'idle'");
      r.rows.forEach(x => enqueueMerge(x.id));
    } catch (e) {}
  }).catch(e => {
    console.error('migration failed, retrying in 15s:', e.message);
    setTimeout(migrateLoop, 15000);
  });
})();

/* ── background merger: combine segments into ONE GitHub asset.
   After merging, the video plays DIRECTLY from GitHub's CDN (no proxy,
   instant load/seek). Runs one at a time, streams (no big RAM use). ── */
const mergeQueue = [];
let merging = false;
const mergeAttempts = new Map(); // id → attempts this boot (stops crash loops)

function enqueueMerge(id) {
  if (!mergeQueue.includes(id)) mergeQueue.push(id);
  runMergeQueue();
}

async function runMergeQueue() {
  if (merging) return;
  merging = true;
  try {
    while (mergeQueue.length) {
      const id = mergeQueue.shift();
      const tries = mergeAttempts.get(id) || 0;
      if (tries >= 2) { console.error('merge giving up (2 tries this boot):', id); continue; }
      mergeAttempts.set(id, tries + 1);
      try {
        await mergeVideo(id);
      } catch (e) {
        console.error('merge failed', id, e.message);
        try { await q("update videos set merge_state = 'failed' where id = $1", [id]); } catch (x) {}
      }
    }
  } finally { merging = false; }
}

/* stream an asset upload with a known total length (chunked from an async generator) */
function ghStreamUpload(rid, name, totalLen, source) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'uploads.github.com',
      path: `/repos/${GH_REPO}/releases/${rid}/assets?name=${encodeURIComponent(name)}`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + GH_TOKEN,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'yourvibe',
        'Content-Type': 'video/mp4',
        'Content-Length': String(totalLen),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 201) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else reject(new Error('asset upload ' + res.statusCode + ' ' + data.slice(0, 120)));
      });
    });
    req.on('error', reject);
    (async () => {
      for await (const chunk of source) {
        if (!req.write(chunk)) await new Promise(w => req.once('drain', w));
      }
      req.end();
    })().catch(reject);
  });
}

async function mergeVideo(id) {
  /* MERGING DISABLED for stability: the free instance's 512MB RAM cannot
     reliably stream-merge big videos — it OOMs and crash-loops the whole
     API. Multi-part videos play fine through the proxy. Already-merged
     videos keep their direct-CDN speed. */
  if (process.env.MERGE_ENABLED !== '1') return;

  const r = await q('select video_path, parts, sizes, store, merge_state from videos where id = $1', [id]);
  if (!r.rows.length) return;
  const row = r.rows[0];
  const parts = Math.max(1, Number(row.parts) || 1);
  if (parts < 2) return;
  if (row.merge_state === 'failed') return; // already crashed once — never retry
  const store = row.store === 'gh' ? 'gh' : 'sb';
  const sizes = Array.isArray(row.sizes) ? row.sizes.map(Number) : [];
  const total = sizes.reduce((a, b) => a + (b || 0), 0);
  if (!total || total > 8e8) { // unknown size or too big for free-tier RAM → skip safely
    try { await q("update videos set merge_state = 'failed' where id = $1", [id]); } catch (e) {}
    return;
  }
  await q("update videos set merge_state = 'running' where id = $1", [id]);
  /* free up memory before streaming a big merge */
  segCache.clear();
  const authH = store === 'gh'
    ? { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'yourvibe' }
    : { Authorization: 'Bearer ' + SB_KEY, apikey: SB_KEY };
  const rid = await ghReleaseId('v-' + id);

  async function* chunks() {
    for (let i = 0; i < parts; i++) {
      const url = store === 'gh'
        ? ghPartUrl(id, i)
        : SB_URL + '/storage/v1/object/media/' + row.video_path.replace(/part\d+\.mp4$/, 'part' + i + '.mp4');
      const resp = await fetch(url, { headers: authH });
      if (!resp.ok) throw new Error('part fetch failed ' + resp.status);
      for await (const c of resp.body) yield c;
    }
  }

  let asset;
  try {
    asset = await ghStreamUpload(rid, 'full.mp4', total, chunks());
  } catch (e) {
    if (String(e.message).includes('422')) { // name exists → delete and retry once
      const list = await (await ghApi(`/repos/${GH_REPO}/releases/${rid}/assets`)).json();
      for (const a of (list || [])) if (a.name === 'full.mp4') await ghApi(`/repos/${GH_REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
      asset = await ghStreamUpload(rid, 'full.mp4', total, chunks());
    } else throw e;
  }

  await q("update videos set video_url = $2, parts = 1, sizes = $3, store = 'gh', merge_state = 'done' where id = $1",
    [id, asset.browser_download_url, JSON.stringify([total])]);

  /* drop the old part assets (and supabase objects if it was sb-stored) */
  const list = await (await ghApi(`/repos/${GH_REPO}/releases/${rid}/assets`)).json();
  for (const a of (list || [])) {
    if (a.name && a.name.startsWith('part')) ghApi(`/repos/${GH_REPO}/releases/assets/${a.id}`, { method: 'DELETE' }).catch(() => {});
  }
  if (store === 'sb') {
    for (let i = 0; i < parts; i++) {
      sbDelete(row.video_path.replace(/part\d+\.mp4$/, 'part' + i + '.mp4')).catch(() => {});
    }
  }
  metaCache.delete(id);
  segCache.clear();
  console.log('✅ merged video ' + id + ' → direct CDN (' + Math.round(total / 1048576) + ' MB)');
}

/* ── Supabase Storage upload ── */
async function sbPut(objPath, buffer, contentType) {
  const r = await fetch(SB_URL + '/storage/v1/object/media/' + objPath, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SB_KEY,
      'apikey': SB_KEY,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!r.ok) throw new Error('storage upload failed (' + r.status + ')');
}
async function sbDelete(objPath) {
  try {
    await fetch(SB_URL + '/storage/v1/object/media/' + objPath, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + SB_KEY, 'apikey': SB_KEY },
    });
  } catch (e) { /* non-fatal */ }
}
const pubUrl = p => SB_URL + '/storage/v1/object/public/media/' + p;

/* numbers from pg come back as strings — normalize rows */
const num = v => Number(v) || 0;

/* ── API ── */

/* anti-spam cooldowns (seconds left, or 0 = allowed) */
const cooldowns = new Map();
function cdCheck(key, ms) {
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < ms) return Math.ceil((ms - (now - last)) / 1000);
  if (cooldowns.size > 4000) cooldowns.clear();
  cooldowns.set(key, now);
  return 0;
}
const clientIp = req => String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || 'anon';

/* ONE round-trip boot: feed + creators + avatars + announcement + account */
app.get('/api/boot', async (req, res) => {
  try {
    const vids = await q(`select id,title,description,category,type,duration,uploader,thumb_url,video_url,views,likes,parts,store,created_at
                          from videos order by created_at desc limit 200`);
    let creators = {};
    try {
      await q('insert into creators (name, subs) select distinct uploader, 0 from videos on conflict (name) do nothing');
      const cr = await q('select name, subs from creators');
      cr.rows.forEach(r => { creators[r.name] = num(r.subs); });
    } catch (e) {}
    const avatars = {};
    try {
      const ups = [];
      const seen = {};
      vids.rows.forEach(r => { const k = String(r.uploader || '').toLowerCase(); if (k && !seen[k]) { seen[k] = 1; ups.push(k); } });
      if (ups.length) {
        const av = await q('select username, avatar_url from users where username = any($1) and avatar_url is not null', [ups.slice(0, 60)]);
        av.rows.forEach(r => { avatars[r.username] = r.avatar_url; });
      }
    } catch (e) {}
    let announcement = null;
    try {
      const ann = await q('select id, text, created_at from announcements order by id desc limit 1');
      announcement = ann.rows[0] || null;
    } catch (e) {}
    let me = null;
    const u = await authUser(req);
    if (u) {
      try {
        const r = await q('select username, avatar_url, banner_url, bio from users where username = $1', [u]);
        me = r.rows[0] || { username: u };
      } catch (e) { me = { username: u }; }
    }
    res.json({
      videos: vids.rows.map(row => Object.assign({}, row, {
        views: num(row.views), likes: num(row.likes), parts: Math.max(1, Number(row.parts) || 1),
      })),
      creators, avatars, announcement, me,
    });
  } catch (e) { res.status(500).json({ error: 'boot failed' }); }
});

/* auth: signup / login / me / logout */
app.post('/api/auth/signup', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'username must be 3-20 chars (letters, numbers, _)' });
    if (password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
    const token = crypto.randomBytes(24).toString('hex');
    try {
      await q('insert into users (username, pass_hash, token) values ($1,$2,$3)', [username, hashPass(password), token]);
    } catch (e) {
      if (String(e.message || '').includes('duplicate key')) return res.status(409).json({ error: 'that username is taken' });
      throw e;
    }
    res.status(201).json({ token, username });
  } catch (e) { res.status(500).json({ error: 'signup failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const r = await q('select username, pass_hash from users where username = $1', [username]);
    if (!r.rows.length || !verifyPass(password, r.rows[0].pass_hash)) {
      return res.status(401).json({ error: 'wrong username or password' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    await q('update users set token = $1 where username = $2', [token, username]);
    res.json({ token, username });
  } catch (e) { res.status(500).json({ error: 'login failed' }); }
});

app.get('/api/auth/me', async (req, res) => {
  const username = await authUser(req);
  if (!username) return res.status(401).json({ error: 'not logged in' });
  try {
    const r = await q('select username, avatar_url, banner_url, bio from users where username = $1', [username]);
    const u = r.rows[0] || {};
    res.json({ username, avatar_url: u.avatar_url || null, banner_url: u.banner_url || null, bio: u.bio || null });
  } catch (e) { res.json({ username }); }
});

/* save account avatar/banner as FILES (browser-cacheable URLs) */
app.post('/api/auth/profile', async (req, res) => {
  const username = await authUser(req);
  if (!username) return res.status(401).json({ error: 'not logged in' });
  const b = req.body || {};
  const out = {};
  try {
    if (b.avatar) {
      if (!String(b.avatar).startsWith('data:image/') || String(b.avatar).length > 2000000) return res.status(400).json({ error: 'bad avatar' });
      const p = 'avatars/' + username + '.jpg';
      await sbPut(p, Buffer.from(String(b.avatar).split(',')[1], 'base64'), 'image/jpeg');
      await q('update users set avatar_url = $2 where username = $1', [username, pubUrl(p)]);
      out.avatar_url = pubUrl(p);
    }
    if (b.bio !== undefined) {
      const bio = String(b.bio || '').slice(0, 1000);
      await q('update users set bio = $2 where username = $1', [username, bio]);
      out.bio = bio;
    }
    if (b.banner) {
      if (!String(b.banner).startsWith('data:image/') || String(b.banner).length > 2000000) return res.status(400).json({ error: 'bad banner' });
      const p = 'banners/' + username + '.jpg';
      await sbPut(p, Buffer.from(String(b.banner).split(',')[1], 'base64'), 'image/jpeg');
      await q('update users set banner_url = $2 where username = $1', [username, pubUrl(p)]);
      out.banner_url = pubUrl(p);
    }
    res.json(Object.assign({ ok: true }, out));
  } catch (e) { res.status(500).json({ error: 'failed' }); }
});

/* batch avatar lookup (URLs — tiny payload) */
app.get('/api/avatars', async (req, res) => {
  try {
    const names = String(req.query.names || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 60);
    if (!names.length) return res.json({});
    const r = await q('select username, avatar_url from users where username = any($1) and avatar_url is not null', [names]);
    const out = {};
    r.rows.forEach(row => { out[row.username] = row.avatar_url; });
    res.json(out);
  } catch (e) { res.json({}); }
});

app.post('/api/auth/logout', async (req, res) => {
  const username = await authUser(req);
  if (username) await q('update users set token = null where username = $1', [username]).catch(() => {});
  res.json({ ok: true });
});

/* claim guest uploads for the logged-in account (del_key proves ownership) */
app.post('/api/auth/claim', async (req, res) => {
  try {
    const username = await authUser(req);
    if (!username) return res.status(401).json({ error: 'not logged in' });
    const claims = (req.body && Array.isArray(req.body.claims)) ? req.body.claims.slice(0, 200) : [];
    let moved = 0;
    for (const c of claims) {
      if (!c || !/^[A-Za-z0-9-]{8,64}$/.test(String(c.id || ''))) continue;
      try {
        const r = await q('update videos set uploader = $1 where id = $2 and del_key = $3 and uploader <> $1',
          [username, c.id, String(c.del_key || '')]);
        moved += r.rowCount || 0;
      } catch (e) { /* skip */ }
    }

    /* also merge videos whose uploader matches the account name
       ignoring spaces/underscores/case ("Vadim Playground" ≈ vadim_playground) */
    try {
      const olds = await q(
        `select distinct uploader from videos where uploader <> $1
         and regexp_replace(lower(uploader), '[^a-z0-9]', '', 'g') = regexp_replace(lower($1), '[^a-z0-9]', '', 'g')`,
        [username]);
      const r = await q(
        `update videos set uploader = $1 where uploader <> $1
         and regexp_replace(lower(uploader), '[^a-z0-9]', '', 'g') = regexp_replace(lower($1), '[^a-z0-9]', '', 'g')`,
        [username]);
      moved += r.rowCount || 0;
      if (olds.rows.length) {
        try { await q('insert into creators (name, subs) values ($1, 0) on conflict (name) do nothing', [username]); } catch (e) {}
        for (const o of olds.rows) {
          try {
            await q(`update creators set subs = creators.subs + (select coalesce(subs, 0) from creators where name = $2) where name = $1`, [username, o.uploader]);
            await q('delete from creators where name = $1', [o.uploader]);
          } catch (e) {}
        }
      }
    } catch (e) { /* non-fatal */ }

    if (moved > 0) {
      try { await q('insert into creators (name, subs) values ($1, 0) on conflict (name) do nothing', [username]); } catch (e) {}
    }
    res.json({ ok: true, moved });
  } catch (e) { res.status(500).json({ error: 'claim failed' }); }
});

app.get('/api/health', async (req, res) => {
  try { await q('select 1'); res.json({ ok: true, migrated }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/videos', async (req, res) => {
  try {
    const r = await q(`select id,title,description,category,type,duration,uploader,thumb_url,video_url,views,likes,parts,store,created_at
                       from videos order by created_at desc limit 200`);
    res.json(r.rows.map(row => Object.assign({}, row, {
      views: num(row.views), likes: num(row.likes),
      parts: Math.max(1, Number(row.parts) || 1),
    })));
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

app.get('/api/creators', async (req, res) => {
  try {
    /* self-heal: every uploader that appears in videos gets a counter row */
    await q('insert into creators (name, subs) select distinct uploader, 0 from videos on conflict (name) do nothing').catch(() => {});
    const r = await q('select name, subs from creators');
    const out = {};
    r.rows.forEach(row => out[row.name] = num(row.subs));
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

/* ── Segmented uploads (big videos are split client-side into ≤50MB segments,
      stored as separate objects, and streamed back as ONE file via /stream) ── */
const uploadSeg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
});

const partPath = (id, i) => `videos/${id}/part${i}.mp4`;

/* ── SEGMENT UPLOAD — fully STREAMING (zero-buffering): video bytes flow
   straight through the server to GitHub. Memory stays flat regardless of
   video size → no more OOM crashes killing uploads. ── */
app.post('/api/videos/:id/segment', (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  const idx = Math.max(0, Math.min(95, parseInt(String(req.query.index || '0'), 10) || 0));
  const size = parseInt(String(req.query.size || '0'), 10);
  if (!size || size > 50 * 1024 * 1024) return res.status(400).json({ error: 'bad size' });
  if (!ghMode()) return res.status(500).json({ error: 'storage not configured' });

  let handled = false;
  const bb = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  bb.on('file', (fieldname, file) => {
    if (handled) { file.resume(); return; }
    handled = true;
    /* buffer the file so we can retry if the release vanished (404) */
    const chunks = [];
    file.on('data', c => chunks.push(c));
    file.on('end', () => {
      const buffer = Buffer.concat(chunks);
      /* wrap the buffer in an async generator that yields it as ONE chunk
         (iterating a raw Buffer yields individual bytes = crash) */
      async function* bufSource() { yield buffer; }
      (async () => {
        const name = 'part' + idx + '.mp4';
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const rid = await ghReleaseId('v-' + id);
            const asset = await ghStreamUpload(rid, name, size, bufSource());
            return res.json({ index: idx, size, url: asset.browser_download_url, store: 'gh' });
          } catch (e) {
            const msg = String(e.message || '');
            if (msg.includes('422')) {
              /* segment already exists (resumed publish) — treat as done */
              return res.status(409).json({ error: 'segment exists' });
            }
            if (msg.includes('404') && attempt < 3) {
              console.error('segment 404 — release vanished, recreating (attempt ' + attempt + ')');
              continue;
            }
            console.error('segment error:', msg.slice(0, 120));
            return res.status(500).json({ error: 'segment upload failed' });
          }
        }
        res.status(500).json({ error: 'segment upload failed after retries' });
      })();
    });
    file.on('error', () => {
      if (!handled) { handled = true; res.status(400).json({ error: 'bad upload' }); }
    });
  });

  bb.on('error', () => { if (!handled) { handled = true; res.status(400).json({ error: 'bad upload' }); } });
  req.on('error', () => {});
  req.pipe(bb);
});

/* size of a remote part (Supabase object or GitHub asset) with retries
   (freshly-uploaded GitHub assets can take a few seconds to appear) */
async function partSizeOnce(url, store) {
  const authHeaders = store === 'gh' && GH_TOKEN
    ? { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'yourvibe' }
    : { Authorization: 'Bearer ' + SB_KEY, apikey: SB_KEY };
  try {
    const r = await fetch(url, { method: 'HEAD', headers: authHeaders });
    const cl = Number(r.headers.get('content-length'));
    if (cl > 0) return cl;
  } catch (e) {}
  try {
    const r = await fetch(url, { headers: Object.assign({}, authHeaders, { Range: 'bytes=0-0' }) });
    const cr = r.headers.get('content-range'); // bytes 0-0/TOTAL
    if (cr) return Number(cr.split('/')[1]) || 0;
  } catch (e) {}
  return 0;
}

async function partSize(url, store, tries) {
  tries = tries || 3;
  for (let t = 1; t <= tries; t++) {
    const v = await partSizeOnce(url, store);
    if (v > 0) return v;
    if (t < tries) await new Promise(r => setTimeout(r, 1300));
  }
  return 0;
}

app.post('/api/videos/complete', async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.id || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const parts = Math.max(1, Math.min(96, parseInt(b.parts, 10) || 1));
    const store = ghMode() ? 'gh' : 'sb';

    const partUrl0 = store === 'gh' ? ghPartUrl(id, 0) : pubUrl(partPath(id, 0));

    /* FAST PATH: the client sliced the file, so it knows every segment's exact
       size — trust it. Finalizing becomes instant (no HEAD round-trips). */
    let sizes = [];
    const clientSizes = Array.isArray(b.sizes) ? b.sizes.map(Number) : null;
    if (clientSizes && clientSizes.length === parts && clientSizes.every(s => s > 0 && s <= 50 * 1024 * 1024)) {
      sizes = clientSizes;
    } else {
      /* fallback: ask storage for each segment's size */
      const sizePs = [];
      for (let i = 0; i < parts; i++) {
        sizePs.push(partSize(store === 'gh' ? ghPartUrl(id, i) : SB_URL + '/storage/v1/object/media/' + partPath(id, i), store));
      }
      sizes = await Promise.all(sizePs);
      for (let round = 0; round < 12 && sizes.some(s => !s); round++) {
        await new Promise(r => setTimeout(r, 2500));
        const missing = [];
        sizes.forEach((s, i) => {
          if (!s) missing.push(partSize(store === 'gh' ? ghPartUrl(id, i) : SB_URL + '/storage/v1/object/media/' + partPath(id, i), store, 1).then(v => { if (v) sizes[i] = v; }));
        });
        await Promise.all(missing);
      }
      if (!sizes[0] || sizes.some(s => !s)) {
        return res.status(400).json({ error: 'segments still processing — press Publish again in a minute (your upload progress is saved)' });
      }
    }

    let thumbPath = null, thumbUrl = null;
    const thumb = String(b.thumb || '');
    if (thumb.startsWith('data:image/') && thumb.length < 2000000) {
      thumbPath = 'thumbs/' + id + '.jpg';
      await sbPut(thumbPath, Buffer.from(thumb.split(',')[1], 'base64'), 'image/jpeg');
      thumbUrl = pubUrl(thumbPath);
    }

    const delKey = crypto.randomBytes(16).toString('hex');
    const videoPath = partPath(id, 0);
    const title = String(b.title || 'Untitled vibe').slice(0, 100);
    const description = String(b.description || '').slice(0, 2000);
    const category = String(b.category || 'Other').slice(0, 30);
    const type = b.type === 'short' ? 'short' : 'video';
    const duration = String(b.duration || '').slice(0, 10);
    /* logged-in users publish under their account name (can't be spoofed) */
    const authName = await authUser(req);
    const uploader = authName || String(b.uploader || 'Anonymous').slice(0, 50);

    await q(`insert into videos (id,title,description,category,type,duration,uploader,video_path,thumb_path,video_url,thumb_url,del_key,parts,sizes,store)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, title, description, category, type, duration, uploader, videoPath, thumbPath, partUrl0, thumbUrl, delKey, parts, JSON.stringify(sizes), store]);

    /* every uploader gets a creators row so subscriber counts always exist */
    try { await q('insert into creators (name, subs) values ($1, 0) on conflict (name) do nothing', [uploader]); } catch (e) {}

    /* warm the first segments into memory so playback starts instantly */
    try {
      const warmAuth = store === 'gh'
        ? { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'yourvibe' }
        : { Authorization: 'Bearer ' + SB_KEY, apikey: SB_KEY };
      segWarm(store === 'gh' ? ghPartUrl(id, 0) : SB_URL + '/storage/v1/object/media/' + videoPath, warmAuth);
      if (parts > 1) segWarm(store === 'gh' ? ghPartUrl(id, 1) : SB_URL + '/storage/v1/object/media/' + partPath(id, 1), warmAuth);
    } catch (e) {}

    /* merge multi-part videos into ONE CDN file in the BACKGROUND
       (publish finishes right after the upload; playback becomes
       direct-from-CDN a couple of minutes later, automatically) */
    if (parts > 1) enqueueMerge(id);

    res.status(201).json({ id, video_url: partUrl0, thumb_url: thumbUrl, del_key: delKey, parts, store });
  } catch (e) {
    console.error('complete error:', e.message);
    res.status(500).json({ error: 'publish failed' });
  }
});

/* ── Stream a (possibly multi-segment) video as ONE file with Range support.
   Segments are cached in memory (LRU ~3 × 32MB) and the NEXT segment is
   prefetched in the background while the current one plays → instant switches. ── */
const segCache = new Map(); // url -> { buf: Buffer|null, done: boolean }

/* video meta cache: skip the DB round-trip on hot streams */
const metaCache = new Map(); // id -> row (LRU 100)
function metaGet(id) {
  if (!metaCache.has(id)) return null;
  const row = metaCache.get(id);
  metaCache.delete(id); metaCache.set(id, row); // refresh LRU position
  return row;
}
function metaSet(id, row) {
  metaCache.set(id, row);
  while (metaCache.size > 100) metaCache.delete(metaCache.keys().next().value);
}

function segWarm(url, authH) {
  if (segCache.has(url)) return;
  const e = { buf: null, done: false };
  segCache.set(url, e);
  while (segCache.size > 3) segCache.delete(segCache.keys().next().value);
  (async () => {
    const r = await fetch(url, { headers: authH });
    if (!r.ok || !r.body) { segCache.delete(url); return; }
    const chunks = [];
    for await (const c of r.body) chunks.push(Buffer.from(c));
    e.buf = Buffer.concat(chunks);
    e.done = true;
  })().catch(() => { try { segCache.delete(url); } catch (x) {} });
}

function segSlice(url, from, to, res) {
  const e = segCache.get(url);
  if (e && e.done && e.buf && e.buf.length > from) {
    res.end(e.buf.subarray(from, Math.min(to, e.buf.length - 1) + 1));
    return true;
  }
  return false;
}

async function streamOut(req, res) {
  try {
    let row = metaGet(req.params.id);
    if (!row) {
      const r = await q('select video_path, parts, sizes, store from videos where id = $1', [req.params.id]);
      if (!r.rows.length) { res.status(404).end(); return; }
      row = r.rows[0];
      metaSet(req.params.id, row);
    }
    const parts = Math.max(1, Number(row.parts) || 1);
    const store = row.store === 'gh' ? 'gh' : 'sb';

    /* single-file video → redirect straight to the CDN (works even for
       players holding old /stream links after a background merge) */
    if (parts === 1 && row.video_url) {
      return res.redirect(302, row.video_url);
    }
    let sizes = [];
    if (Array.isArray(row.sizes)) sizes = row.sizes.map(Number);
    else { try { sizes = JSON.parse(row.sizes || '[]').map(Number); } catch (e) { sizes = []; } }
    const paths = [];   // server-side fetch URLs (authenticated)
    const pubPaths = []; // PUBLIC urls for redirecting viewers (CDN direct)
    for (let i = 0; i < parts; i++) {
      const rel = row.video_path.replace(/part\d+\.mp4$/, 'part' + i + '.mp4');
      if (store === 'gh') {
        paths.push(ghPartUrl(req.params.id, i));
        pubPaths.push(ghPartUrl(req.params.id, i)); // GitHub release URLs are public
      } else {
        paths.push(SB_URL + '/storage/v1/object/media/' + rel);
        pubPaths.push(SB_URL + '/storage/v1/object/public/media/' + rel); // PUBLIC url
      }
    }

    const authH = store === 'gh'
      ? { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'yourvibe' }
      : { Authorization: 'Bearer ' + SB_KEY, apikey: SB_KEY };
    const pipe = async body => { for await (const chunk of body) { if (!res.write(chunk)) await new Promise(w => res.once('drain', w)); } };

    const total = sizes.reduce((a, b) => a + (b || 0), 0);
    const rangeH = req.headers.range;

    if (!rangeH || !total) {
      res.status(200);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'video/mp4');
      for (let i = 0; i < paths.length; i++) {
        if (i + 1 < paths.length) segWarm(paths[i + 1], authH); // prefetch next
        if (segSlice(paths[i], 0, Infinity, res)) continue;
        const rr = await fetch(paths[i], { headers: authH });
        if (rr.ok) await pipe(rr.body);
      }
      res.end();
      return;
    }

    const m = /bytes=(\d*)-(\d*)/.exec(rangeH);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = (m && m[2]) ? parseInt(m[2], 10) : total - 1;
    if (end >= total) end = total - 1;
    if (start > end || start >= total) { res.status(416).setHeader('Content-Range', 'bytes */' + total).end(); return; }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(end - start + 1));

    let offset = 0;
    let cursor = start;
    for (let i = 0; i < paths.length && cursor <= end; i++) {
      const size = sizes[i] || 0;
      const segStartL = offset, segEndL = offset + size - 1;
      offset += size;
      if (segEndL < cursor) continue;
      const from = cursor - segStartL;
      const to = end - segStartL;

      /* prefetch next segment in the background → instant switching */
      if (i + 1 < paths.length) segWarm(paths[i + 1], authH);

      if (segSlice(paths[i], from, to, res)) { cursor = segEndL + 1; break; }
      const rr = await fetch(paths[i], {
        headers: Object.assign({}, authH, { Range: `bytes=${from}-${to}` }),
      });
      if (rr.ok) await pipe(rr.body);
      cursor = segEndL + 1;
    }
    res.end();
  } catch (e) {
    console.error('stream error:', e.message);
    try { res.status(500).end(); } catch (x) {}
  }
}
app.get('/stream/:id', streamOut);



app.post('/api/videos/:id/like', async (req, res) => {
  try {
    const delta = (req.body && req.body.delta) === -1 ? -1 : 1;
    const r = await q('update videos set likes = greatest(0, likes + $1) where id = $2 returning likes', [delta, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ likes: num(r.rows[0].likes) });
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

app.post('/api/videos/:id/view', async (req, res) => {
  try {
    await q('update videos set views = views + 1 where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

app.get('/api/videos/:id/comments', async (req, res) => {
  try {
    const r = await q('select id, author, text, created_at from comments where video_id = $1 order by created_at desc limit 10000', [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

app.post('/api/videos/:id/comments', async (req, res) => {
  try {
    const authName = await authUser(req);
    const wait = cdCheck('cm:' + (authName || clientIp(req)), 10000);
    if (wait) return res.status(429).json({ error: 'cooldown — wait ' + wait + 's before commenting again' });
    const author = authName || String((req.body && req.body.author) || 'Anonymous').slice(0, 50);
    const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'empty comment' });
    const r = await q('insert into comments (video_id, author, text) values ($1,$2,$3) returning id, author, text, created_at',
      [req.params.id, author, text]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

app.delete('/api/videos/:id', async (req, res) => {
  try {
    const key = (req.body && req.body.del_key) || '';
    const r = await q('select video_path, thumb_path, del_key, parts, uploader, store from videos where id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const row = r.rows[0];
    /* owner = matching delete key OR logged-in account that uploaded it */
    const authName = await authUser(req);
    const owner = (key && key === row.del_key) || (authName && authName === row.uploader);
    if (!owner) return res.status(403).json({ error: 'not your video' });
    metaCache.delete(req.params.id);
    await q('delete from videos where id = $1', [req.params.id]); // cascades comments

    if (row.store === 'bunny' && BUNNY_LIBRARY && BUNNY_KEY) {
      const bg = row.bunny_guid || (row.video_path || '').replace('bunny:', '');
      if (bg) {
        await fetch('https://video.bunnycdn.com/library/' + BUNNY_LIBRARY + '/videos/' + bg, {
          method: 'DELETE', headers: { AccessKey: BUNNY_KEY }
        }).catch(() => {});
      }
    } else if (row.store === 'gh' && ghMode()) {
      /* delete the whole release + its git tag */
      const tag = 'v-' + req.params.id;
      const rel = await ghApi(`/repos/${GH_REPO}/releases/tags/${tag}`);
      if (rel.status === 200) {
        const rid = (await rel.json()).id;
        await ghApi(`/repos/${GH_REPO}/releases/${rid}`, { method: 'DELETE' }).catch(() => {});
      }
      await ghApi(`/repos/${GH_REPO}/git/refs/tags/${tag}`, { method: 'DELETE' }).catch(() => {});
    } else {
      const parts = Math.max(1, Number(row.parts) || 1);
      for (let i = 0; i < parts; i++) {
        if (/part\d+\.mp4$/.test(row.video_path)) {
          await sbDelete(row.video_path.replace(/part\d+\.mp4$/, 'part' + i + '.mp4'));
        } else if (i === 0) {
          await sbDelete(row.video_path);
        }
      }
    }
    if (row.thumb_path) await sbDelete(row.thumb_path);
    res.sendStatus(204);
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

/* ── polls on videos ── */
async function pollFor(videoId, req) {
  const r = await q('select id, question, options, created_at from polls where video_id = $1 order by created_at desc limit 1', [videoId]);
  if (!r.rows.length) return null;
  const p = r.rows[0];
  let options = p.options;
  if (!Array.isArray(options)) { try { options = JSON.parse(options); } catch (e) { options = []; } }
  const counts = await q('select opt, count(*)::int as n from poll_votes where poll_id = $1 group by opt', [p.id]);
  const tally = new Array(options.length).fill(0);
  counts.rows.forEach(c => { const i = Number(c.opt); if (i >= 0 && i < tally.length) tally[i] = Number(c.n); });
  let myVote = null;
  const authName = await authUser(req);
  const vid = String((req.query && req.query.voter) || authName || '');
  if (vid) {
    const mv = await q('select opt from poll_votes where poll_id = $1 and voter = $2', [p.id, vid]);
    myVote = mv.rows.length ? Number(mv.rows[0].opt) : null;
  }
  return { id: p.id, question: p.question, options, counts: tally, total: tally.reduce((a, b) => a + b, 0), myVote };
}



/* best available MP4 rendition for a bunny video */
function bestRendition(available) {
  const list = String(available || '').toLowerCase();
  /* 720p max for direct MP4 — 1080p files are huge and slow to first byte.
     Full adaptive quality comes from the HLS playlist instead. */
  const order = ['720p', '480p', '360p', '240p'];
  const found = order.find(x => list.includes(x));
  return found || '360p';
}

/* resolve the direct playable URL for a bunny video (live from Bunny API) */
app.get('/api/videos/:id/playurl', async (req, res) => {
  try {
    const r = await q('select video_url, thumb_url, bunny_guid, store from videos where id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const row = r.rows[0];
    if (row.store !== 'bunny') return res.json({ play: row.video_url, thumb: row.thumb_url });
    if (!BUNNY_LIBRARY || !BUNNY_KEY) return res.json({ play: row.video_url, thumb: row.thumb_url });

    let host = null, dur = null;
    const bg = row.bunny_guid || (row.video_path || '').replace('bunny:', '');
    const bv = await fetch('https://video.bunnycdn.com/library/' + BUNNY_LIBRARY + '/videos/' + bg, { headers: { AccessKey: BUNNY_KEY } });
    if (bv.ok) {
      info = await bv.json();
      if (info.thumbnailUrl) host = new URL(info.thumbnailUrl).hostname;
      if (info.length) dur = Math.floor(info.length / 60) + ':' + String(Math.floor(info.length % 60)).padStart(2, '0');
    }
    if (host) {
      const play = 'https://' + host + '/' + bg + '/play_' + bestRendition(info ? info.availableResolutions : '') + '.mp4';
      const hls = 'https://' + host + '/' + bg + '/playlist.m3u8';
      const thumb = row.thumb_url || ('https://' + host + '/' + bg + '/thumbnail.jpg');
      const durFinal = dur || null;
      await q('update videos set video_url = $2, thumb_url = $3, duration = coalesce($4, duration) where id = $1', [req.params.id, play, thumb, durFinal]);
      metaCache.delete(req.params.id);
      return res.json({ play, hls, thumb, progress: 100 });
    }
    /* still encoding — report real progress so the page shows a % */
    return res.json({ processing: true, progress: info ? Math.round(info.encodeProgress || 0) : 0, play: row.video_url, thumb: row.thumb_url });
  } catch (e) { res.status(500).json({ error: 'failed' }); }
});

app.get('/api/videos/:id/poll', async (req, res) => {
  try { res.json(await pollFor(req.params.id, req)); } catch (e) { res.json(null); }
});

app.post('/api/videos/:id/poll', async (req, res) => {
  try {
    const b = req.body || {};
    const isAdmin = req.get('x-admin-key') === ADMIN_KEY;
    const authName = await authUser(req);
    let allowed = isAdmin;
    if (!allowed && authName) {
      const r = await q('select uploader from videos where id = $1', [req.params.id]);
      allowed = r.rows.length && r.rows[0].uploader === authName;
    }
    if (!allowed) return res.status(403).json({ error: 'only the owner or admin can add polls' });
    const wait = cdCheck('pollcreate:' + req.params.id, 10000);
    if (wait) return res.status(429).json({ error: 'cooldown — wait ' + wait + 's' });
    const question = String(b.question || '').trim().slice(0, 200);
    let options = (Array.isArray(b.options) ? b.options : String(b.options || '').split(','))
      .map(o => String(o).trim()).filter(Boolean).slice(0, 6);
    if (!question || options.length < 2) return res.status(400).json({ error: 'need a question and 2-6 options' });
    await q('delete from polls where video_id = $1', [req.params.id]);
    await q('insert into polls (video_id, question, options) values ($1,$2,$3)', [req.params.id, question, JSON.stringify(options)]);
    res.status(201).json(await pollFor(req.params.id, req));
  } catch (e) { res.status(500).json({ error: 'poll failed' }); }
});

app.post('/api/polls/:id/vote', async (req, res) => {
  try {
    const opt = parseInt((req.body && req.body.opt), 10);
    const authName = await authUser(req);
    const voter = String((req.body && req.body.voter) || authName || '').slice(0, 60).toLowerCase();
    if (!voter || !Number.isInteger(opt)) return res.status(400).json({ error: 'bad vote' });
    const wait = cdCheck('vote:' + voter, 3000);
    if (wait) return res.status(429).json({ error: 'cooldown — wait ' + wait + 's' });
    const p = await q('select id, options from polls where id = $1', [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ error: 'poll not found' });
    let options = p.rows[0].options;
    if (!Array.isArray(options)) { try { options = JSON.parse(options); } catch (e) { options = []; } }
    if (opt < 0 || opt >= options.length) return res.status(400).json({ error: 'bad option' });
    const done = await q('insert into poll_votes (poll_id, voter, opt) values ($1,$2,$3) on conflict (poll_id, voter) do nothing returning opt', [req.params.id, voter, opt]);
    if (!done.rows.length) return res.status(409).json({ error: 'you already voted' });
    const full = await q('select video_id from polls where id = $1', [req.params.id]);
    res.json(await pollFor(full.rows[0].video_id, req));
  } catch (e) { res.status(500).json({ error: 'vote failed' }); }
});

app.delete('/api/videos/:id/poll', async (req, res) => {
  try {
    const isAdmin = req.get('x-admin-key') === ADMIN_KEY;
    const authName = await authUser(req);
    let allowed = isAdmin;
    if (!allowed && authName) {
      const r = await q('select uploader from videos where id = $1', [req.params.id]);
      allowed = r.rows.length && r.rows[0].uploader === authName;
    }
    if (!allowed) return res.status(403).json({ error: 'not allowed' });
    await q('delete from polls where video_id = $1', [req.params.id]);
    res.sendStatus(204);
  } catch (e) { res.status(500).json({ error: 'failed' }); }
});

/* ── announcements (single active, admin-managed) ── */
app.get('/api/announcement', async (req, res) => {
  try {
    const r = await q('select id, text, created_at from announcements order by id desc limit 1');
    res.json(r.rows.length ? r.rows[0] : null);
  } catch (e) { res.json(null); }
});

/* ── ADMIN (panel opens with F4 in the app) ── */
app.post('/api/admin/announcement', async (req, res) => {
  try {
    if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
    const text = String((req.body && req.body.text) || '').trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: 'empty announcement' });
    await q('delete from announcements');
    await q('insert into announcements (text) values ($1)', [text]);
    const r = await q('select id, text, created_at from announcements order by id desc limit 1');
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'failed' }); }
});

app.delete('/api/admin/announcement', async (req, res) => {
  try {
    if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
    await q('delete from announcements');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'failed' }); }
});

const RAND_ADJ = ['Neon', 'Cyber', 'Pixel', 'Glitch', 'Retro', 'Synth', 'Astro', 'Laser', 'Turbo', 'Hyper', 'Ultra', 'Quantum', 'Vapor', 'Chrome', 'Plasma'];
const RAND_NOUN = ['Fox', 'Wolf', 'Tiger', 'Panda', 'Falcon', 'Viper', 'Phoenix', 'Ninja', 'Ghost', 'Wizard', 'Rider', 'Byte', 'Drifter', 'Nomad', 'Samurai'];
const RAND_TEXTS = [
  'this goes hard 🔥', 'the algorithm blessed me today ⚡', 'watching this at 3am hits different 🌃',
  'the vibes are immaculate ✨', 'who else here from the future? 🚀', 'instant classic 💯',
  'looped it 10 times already 🔁', 'the neon aesthetic though 😍', 'my brain: dopamine approved ✅',
  'certified banger 🎧', 'no way this is real 😳', 'the edit is clean, respect 👏',
  'subscribed instantly 🔔', 'this deserves 1M views', 'absolute masterpiece 🎨',
  'POV: you found the best video today', 'the transitions 💀🔥', 'saving this to my library right now',
  'the glow is unreal 💜', 'came for 5 seconds, stayed 20 minutes', 'send this to your best friend 📤',
  'playing this on repeat till 2077', 'cinema. pure cinema. 🍿', 'bro really uploaded a classic',
  'first 🥇', 'I was here before it was cool 😎', 'the server is working overtime for this one',
  'my playlist needed this', 'grandma asked why the screen is pink and glowing',
];
const randPick = arr => arr[crypto.randomInt(arr.length)];

/* ── Russian pool for the RU admin button ── */
const RU_ADJ = ['Neon', 'Cyber', 'Pixel', 'Glitch', 'Retro', 'Synth', 'Laser', 'Turbo', 'Ultra', 'Vapor', 'Chrome', 'Plasma', 'Kiber', 'Neonovyi'];
const RU_NOUN = ['Lis', 'Volk', 'Medved', 'Sokol', 'Zayac', 'Drakon', 'Kot', 'Barsuk', 'Enot', 'Voron', 'Belka', 'Tigr', 'Filin', 'Tuman'];
const RU_TEXTS = [
  'это огонь 🔥', 'алгоритм привёл меня сюда ⚡', 'смотрю в 3 ночи, вайбы топ 🌃',
  'мгновенная классика 💯', 'лайк не глядя 👍', 'реплей уже 10 раз 🔁',
  'неоновая эстетика 😍', 'дофамин утверждён ✅', 'сертифицированный бэнгер 🎧',
  'неужели это реально 😳', 'мурашки по коже 🤯', 'подписался мгновенно 🔔',
  'этот ролик заслуживает 1M просмотров', 'шедевр просто 🎨', 'сохранил в избранное ⭐',
  'переслал другу 📤', 'буду смотреть до 2077', 'кино, чистое кино 🍿',
  'первый 🥇', 'я был здесь до того, как это стало мейнстримом 😎',
  'сервер старается на полную 💪', 'мне в плейлист, срочно!', 'бабушка спросила, почему экран розовый',
  'лайк за старания ❤️', 'контент растёт не по дням 🔥', 'жду продолжения 👀', 'это база 🔥',
  'лучшее, что я видел сегодня', 'звук на максимум 🎶', 'вау, просто вау 😍',
];

function randAccount(lang) {
  const adj = lang === 'ru' ? RU_ADJ : RAND_ADJ;
  const noun = lang === 'ru' ? RU_NOUN : RAND_NOUN;
  return randPick(adj) + randPick(noun) + (crypto.randomInt(10) < 4 ? '_' + crypto.randomInt(100) : '');
}

app.post('/api/admin/video/:id/:action', async (req, res) => {
  try {
    if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
    const action = req.params.action;

    /* transfer a video to another creator/account */
    if (action === 'transfer') {
      const to = String((req.body && req.body.to) || '').trim().slice(0, 50);
      if (!to) return res.status(400).json({ error: 'missing target name' });
      const r = await q('update videos set uploader = $1 where id = $2 returning uploader', [to, req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      try { await q('insert into creators (name, subs) values ($1, 0) on conflict (name) do nothing', [to]); } catch (e) {}
      return res.json({ ok: true, uploader: to });
    }

    const nRaw = Number(req.body && req.body.n);
    if (!Number.isFinite(nRaw)) return res.status(400).json({ error: 'bad n' });

    if (action === 'views' || action === 'likes') {
      const n = Math.max(0, Math.min(1000000, Math.round(nRaw)));
      const col = action === 'views' ? 'views' : 'likes';
      const r = await q(`update videos set ${col} = ${col} + $1 where id = $2 returning ${col}`, [n, req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true, [action]: num(r.rows[0][col]) });
    }

    if (action === 'subs') {
      const n = Math.max(0, Math.min(10000000, Math.round(nRaw)));
      const r = await q('select uploader from videos where id = $1', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      const name = r.rows[0].uploader;
      await q(`insert into creators (name, subs) values ($1, $2)
               on conflict (name) do update set subs = creators.subs + $2`, [name, n]);
      const c = await q('select subs from creators where name = $1', [name]);
      return res.json({ ok: true, creator: name, subs: num(c.rows[0].subs) });
    }

    if (action === 'comments') {
      const count = Math.max(1, Math.min(10000, Math.round(nRaw)));
      const lang = (req.body && req.body.lang) === 'ru' ? 'ru' : 'en';
      const pool = lang === 'ru' ? RU_TEXTS : RAND_TEXTS;
      const chunks = [], params = [];
      for (let i = 0; i < count; i++) {
        const b = i * 3;
        chunks.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
        params.push(req.params.id, randAccount(lang), randPick(pool));
      }
      await q('insert into comments (video_id, author, text) values ' + chunks.join(','), params);
      return res.json({ ok: true, inserted: count, lang });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('admin error:', e.message);
    res.status(500).json({ error: 'admin failed' });
  }
});

/* ── static app ── */
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log('⚡ YourVibe API on port ' + PORT));
