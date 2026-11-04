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

/* ── CORS (static site calls this API cross-origin) ── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
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
  await q(`insert into storage.buckets (id, name, public)
           values ('media', 'media', true) on conflict (id) do nothing`);
  migrated = true;
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
app.get('/api/health', async (req, res) => {
  try { await q('select 1'); res.json({ ok: true, migrated }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/videos', async (req, res) => {
  try {
    const r = await q(`select id,title,description,category,type,duration,uploader,thumb_url,video_url,views,likes,created_at
                       from videos order by created_at desc limit 200`);
    res.json(r.rows.map(row => Object.assign({}, row, { views: num(row.views), likes: num(row.likes) })));
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

app.get('/api/creators', async (req, res) => {
  try {
    const r = await q('select name, subs from creators');
    const out = {};
    r.rows.forEach(row => out[row.name] = num(row.subs));
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 2 },
});

app.post('/api/videos', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), async (req, res) => {
  try {
    const f = req.files && req.files.video && req.files.video[0];
    if (!f) return res.status(400).json({ error: 'no video file' });
    if (f.size > MAX_MB * 1024 * 1024) return res.status(400).json({ error: 'file too big (max ' + MAX_MB + ' MB)' });

    const id = crypto.randomUUID();
    const vExt = (path.extname(f.originalname || '') || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
    const videoPath = 'videos/' + id + vExt;

    await sbPut(videoPath, f.buffer, f.mimetype || 'video/mp4');

    let thumbPath = null, thumbUrl = null;
    const tf = req.files && req.files.thumb && req.files.thumb[0];
    if (tf) {
      thumbPath = 'thumbs/' + id + '.jpg';
      await sbPut(thumbPath, tf.buffer, tf.mimetype || 'image/jpeg');
      thumbUrl = pubUrl(thumbPath);
    }

    const b = req.body || {};
    const delKey = crypto.randomBytes(16).toString('hex');
    const title = String(b.title || 'Untitled vibe').slice(0, 100);
    const description = String(b.description || '').slice(0, 2000);
    const category = String(b.category || 'Other').slice(0, 30);
    const type = b.type === 'short' ? 'short' : 'video';
    const duration = String(b.duration || '').slice(0, 10);
    const uploader = String(b.uploader || 'Anonymous').slice(0, 50);

    await q(`insert into videos (id,title,description,category,type,duration,uploader,video_path,thumb_path,video_url,thumb_url,del_key)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, title, description, category, type, duration, uploader, videoPath, thumbPath, pubUrl(videoPath), thumbUrl, delKey]);

    res.status(201).json({ id, video_url: pubUrl(videoPath), thumb_url: thumbUrl, del_key: delKey });
  } catch (e) {
    console.error('upload error:', e.message);
    res.status(500).json({ error: 'upload failed' });
  }
});

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
    const author = String((req.body && req.body.author) || 'Anonymous').slice(0, 50);
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
    const r = await q('select video_path, thumb_path, del_key from videos where id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const row = r.rows[0];
    if (!key || key !== row.del_key) return res.status(403).json({ error: 'wrong delete key' });
    await q('delete from videos where id = $1', [req.params.id]); // cascades comments
    await sbDelete(row.video_path);
    if (row.thumb_path) await sbDelete(row.thumb_path);
    res.sendStatus(204);
  } catch (e) { res.status(500).json({ error: 'db down' }); }
});

/* ── ADMIN (panel opens with F4 in the app) ── */
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
function randAccount() {
  return randPick(RAND_ADJ) + randPick(RAND_NOUN) + (crypto.randomInt(10) < 4 ? '_' + crypto.randomInt(100) : '');
}

app.post('/api/admin/video/:id/:action', async (req, res) => {
  try {
    if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
    const action = req.params.action;
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
      const chunks = [], params = [];
      for (let i = 0; i < count; i++) {
        const b = i * 3;
        chunks.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
        params.push(req.params.id, randAccount(), randPick(RAND_TEXTS));
      }
      await q('insert into comments (video_id, author, text) values ' + chunks.join(','), params);
      return res.json({ ok: true, inserted: count });
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
