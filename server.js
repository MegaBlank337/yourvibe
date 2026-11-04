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
const multer = require('multer');
const { Client } = require('pg');
const crypto = require('crypto');
const path = require('path');
const dns = require('dns');

/* Supabase db.* hosts resolve to IPv6 first (or only), but Render free
   instances have no IPv6 egress — force IPv4. */
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;
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

/* get-or-create the release that holds one video's segments */
async function ghReleaseId(tag) {
  let r = await ghApi(`/repos/${GH_REPO}/releases/tags/${tag}`);
  if (r.status === 200) return (await r.json()).id;
  r = await ghApi(`/repos/${GH_REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag }),
  });
  if (!r.ok) throw new Error('release create failed (' + r.status + ') ' + (await r.text()).slice(0, 120));
  return (await r.json()).id;
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
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, X-Auth, X-Upload-Offset');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

/* ── Postgres (Supabase) with auto-reconnect ── */
let pg = null;
let migrated = false;
let DB_CFG = null;

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

async function q(sql, params) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!pg || pg._ended) {
        pg = new Client(await dbConfig());
        pg.on('error', () => { try { pg.end(); } catch (e) {} pg = null; });
        await pg.connect();
      }
      return await pg.query(sql, params);
    } catch (e) {
      try { if (pg) pg.end(); } catch (e2) {}
      pg = null;
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
  await q(`create table if not exists users (
    username text primary key,
    pass_hash text not null,
    token text,
    created_at timestamptz default now()
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
  migrate().catch(e => {
    console.error('migration failed, retrying in 15s:', e.message);
    setTimeout(migrateLoop, 15000);
  });
})();

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
  res.json({ username });
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
    const r = await q(`select id,title,description,category,type,duration,uploader,thumb_url,video_url,views,likes,parts,created_at
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

app.post('/api/videos/:id/segment', uploadSeg.single('video'), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'no segment file' });
    const id = req.params.id;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const idx = Math.max(0, Math.min(45, parseInt((req.body && req.body.index) || '0', 10) || 0));

    if (ghMode()) {
      const asset = await ghPutAsset('v-' + id, 'part' + idx + '.mp4', f.buffer, f.mimetype || 'video/mp4');
      return res.json({ index: idx, size: f.size, url: asset.browser_download_url, store: 'gh' });
    }

    const p = partPath(id, idx);
    await sbPut(p, f.buffer, f.mimetype || 'video/mp4');
    res.json({ index: idx, size: f.size, url: pubUrl(p), store: 'sb' });
  } catch (e) {
    console.error('segment error:', e.message);
    res.status(500).json({ error: 'segment upload failed' });
  }
});

/* size of a remote part (Supabase object or GitHub asset) */
async function partSize(url, store) {
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

app.post('/api/videos/complete', async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.id || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: 'bad id' });
    const parts = Math.max(1, Math.min(46, parseInt(b.parts, 10) || 1));
    const store = ghMode() ? 'gh' : 'sb';

    const partUrl0 = store === 'gh' ? ghPartUrl(id, 0) : pubUrl(partPath(id, 0));
    const sizes = [];
    for (let i = 0; i < parts; i++) {
      sizes.push(await partSize(store === 'gh' ? ghPartUrl(id, i) : SB_URL + '/storage/v1/object/media/' + partPath(id, i), store));
    }
    if (!sizes[0]) return res.status(400).json({ error: 'segments missing — upload failed' });

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

    res.status(201).json({ id, video_url: partUrl0, thumb_url: thumbUrl, del_key: delKey, parts, store });
  } catch (e) {
    console.error('complete error:', e.message);
    res.status(500).json({ error: 'publish failed' });
  }
});

/* ── Stream a (possibly multi-segment) video as ONE file with Range support ── */
async function streamOut(req, res) {
  try {
    const r = await q('select video_path, parts, sizes, store from videos where id = $1', [req.params.id]);
    if (!r.rows.length) { res.status(404).end(); return; }
    const row = r.rows[0];
    const parts = Math.max(1, Number(row.parts) || 1);
    const store = row.store === 'gh' ? 'gh' : 'sb';
    let sizes = [];
    if (Array.isArray(row.sizes)) sizes = row.sizes.map(Number);
    else { try { sizes = JSON.parse(row.sizes || '[]').map(Number); } catch (e) { sizes = []; } }
    const paths = [];
    for (let i = 0; i < parts; i++) {
      paths.push(store === 'gh'
        ? ghPartUrl(req.params.id, i)
        : SB_URL + '/storage/v1/object/media/' + row.video_path.replace(/part\d+\.mp4$/, 'part' + i + '.mp4'));
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
      for (const p of paths) {
        const rr = await fetch(p, { headers: authH });
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
      const segStart = offset, segEnd = offset + size - 1;
      offset += size;
      if (segEnd < cursor) continue;
      const from = cursor - segStart;
      const to = end - segStart;
      const rr = await fetch(paths[i], {
        headers: Object.assign({}, authH, { Range: `bytes=${from}-${to}` }),
      });
      if (rr.ok) await pipe(rr.body);
      cursor = segEnd + 1;
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
    const r = await q('select id, author, text, created_at from comments where video_id = $1 order by created_at desc limit 500', [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

app.post('/api/videos/:id/comments', async (req, res) => {
  try {
    const authName = await authUser(req);
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
    await q('delete from videos where id = $1', [req.params.id]); // cascades comments

    if (row.store === 'gh' && ghMode()) {
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
      const count = Math.max(1, Math.min(500, Math.round(nRaw)));
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
