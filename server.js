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
   GET    /api/health

   Files live in Supabase Storage (public bucket "media"),
   metadata in Supabase Postgres. Env vars needed:
     SUPABASE_URL, SUPABASE_SERVICE_KEY, DATABASE_URL
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const multer = require('multer');
const { Client } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_MB = 50;

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const DB_URL = process.env.DATABASE_URL || '';

/* ── CORS (static site calls this API cross-origin) ── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

/* ── Postgres (Supabase) with auto-reconnect ── */
let pg = null;
let migrated = false;

async function q(sql, params) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (!pg || pg._ended) {
        pg = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
        pg.on('error', () => { try { pg.end(); } catch (e) {} pg = null; });
        await pg.connect();
      }
      return await pg.query(sql, params);
    } catch (e) {
      try { if (pg) pg.end(); } catch (e2) {}
      pg = null;
      if (attempt === 2) throw e;
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

/* ── API ── */
app.get('/api/health', async (req, res) => {
  try { await q('select 1'); res.json({ ok: true, migrated }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/videos', async (req, res) => {
  try {
    const r = await q(`select id,title,description,category,type,duration,uploader,thumb_url,video_url,views,likes,created_at
                       from videos order by created_at desc limit 200`);
    res.json(r.rows);
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
    res.json({ likes: Number(r.rows[0].likes) });
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
    const r = await q('select id, author, text, created_at from comments where video_id = $1 order by created_at desc limit 200', [req.params.id]);
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

/* ── static app ── */
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log('⚡ YourVibe API on port ' + PORT));
