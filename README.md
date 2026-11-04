# ⚡ YourVibe — Neon Video Universe

A YouTube-style neon app with **real server-side uploads** — anyone can publish a video and everyone sees it.

## 🏗️ How it works

```
Browser (static site on Render CDN)
   │  fetch /api/*
   ▼
Node API (Render Web Service — server.js)
   │  metadata        │  video/thumbnail files
   ▼                  ▼
Supabase Postgres   Supabase Storage (public bucket "media")
```

- **Videos + thumbnails** → stored on the server (Supabase Storage), served from its CDN
- **Comments, views, likes** → shared in Postgres (everyone sees the same)
- **Your likes/subs/history/channel look** → private, in your browser (localStorage)
- **Delete protection** → each upload returns a secret delete key kept in the uploader's browser

## ✨ Features

| Page | What it does |
|---|---|
| 🏠 Home | Category chips, 🔥 Trending, ⚡ Shorts shelf, recommended grid |
| ⚡ Shorts | Vertical snap-scroll feed, autoplay, like, sound toggle |
| 📺 Subscriptions | Uploads from creators you subscribed to |
| 📚 Library | History, Liked, Watch Later, Your uploads |
| 🎨 Your Channel | Banner/avatar/name/bio, your videos, delete your uploads |
| ⬆️ Upload | Drag & drop (max 50 MB), **custom thumbnail picker** (or auto-captured frame), duration auto-detected |
| ▶️ Watch | Custom neon player (keyboard: space/k, m, f, ←→), like, comments, share, related |

## 🚀 Run locally

Frontend only: open `index.html` (needs the API for videos — see below).

Full stack:
```
npm install
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... DATABASE_URL=... node server.js
```
Tables + storage bucket are created automatically on boot.

## ☁️ Deploy on Render

- **Static Site** → publish dir `.` (the frontend)
- **Web Service** → `npm install` / `node server.js`, env vars:
  - `SUPABASE_URL` — https://xxx.supabase.co
  - `SUPABASE_SERVICE_KEY` — service_role key
  - `DATABASE_URL` — Postgres connection string
- The frontend calls the API at `https://yourvibe-api.onrender.com` (override via localStorage `yv_api_base`).

## 📁 Files

```
yourvibe/
├── index.html      — page shell
├── css/style.css   — neon theme
├── js/
│   ├── data.js     — categories & defaults (no fake content)
│   ├── storage.js  — localStorage layer
│   └── app.js      — router, views, player, uploads
└── server.js       — Express API (uploads, comments, likes, views)
```

## Notes

- Free tiers: Render web service sleeps after inactivity (first API call may take ~1 min); Supabase free project pauses after ~1 week of zero traffic — log in to restore.
- No accounts/moderation — anyone can upload. Don't post anything private.
