# ⚡ YourVibe — Neon Video Universe

A fully functional YouTube-style app with a neon/cyberpunk look. 100% front-end (HTML + CSS + vanilla JS), zero build tools, zero dependencies to install.

## 🚀 Run it on your PC

**Easiest:** double-click `index.html` (Chrome or Edge recommended).

**Optional (local server):**
```
cd yourvibe
python -m http.server 8080
```
then open http://localhost:8080

## ✨ Features

| Page | What it does |
|---|---|
| 🏠 **Home** | Category chips, 🔥 Trending shelf, ⚡ Shorts shelf, recommended grid |
| ⚡ **Shorts** | Vertical snap-scroll feed, autoplay on scroll, like / sound toggle, tap to pause |
| 📺 **Subscriptions** | Videos from channels you subscribed to (+ channel shortcuts) |
| 📚 **Library** | History, Liked videos, Watch Later, Your uploads |
| 🎨 **Your Channel** | Banner, avatar, name/handle/bio, your videos + shorts, manage/delete uploads |
| ⬆️ **Upload** | Drag & drop any video → auto thumbnail capture + duration → publish |
| ▶️ **Watch** | Custom neon player (seek, volume, fullscreen, keyboard: space/k/m/f, ← →), 👍 like, 🔔 subscribe, comments, share, related videos |
| 🔍 **Search** | Header search by title / channel / category |

## 💾 Where is data stored?

Everything lives **in your browser only**:

- `localStorage` → likes, subscriptions, history, comments, channel settings
- `IndexedDB` → the actual video files you upload (stays after refresh)

**Reset everything:** Your Channel → Customize channel → “Reset ALL YourVibe data”.
(Or clear site data in browser settings.)

## 📦 Copy it to CodePen

CodePen has 3 panels — paste each file:

1. **HTML panel** → everything inside `<body>…</body>` from `index.html` (drop the `<script src>` tags at the bottom, CodePen adds those)
2. **CSS panel** → all of `css/style.css` + add this line at the very top for the fonts:
   ```css
   @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@400;500;600;700&display=swap');
   ```
3. **JS panel** → paste `js/data.js`, then `js/storage.js`, then `js/app.js` (in that order, one after another in the same panel)

Everything works identically in CodePen, including uploads (IndexedDB works there too).

## 📁 Files

```
yourvibe/
├── index.html      — page shell (header, sidebar, router mount)
├── css/style.css   — the whole neon theme
└── js/
    ├── data.js     — seed channels, videos, shorts, comments
    ├── storage.js  — localStorage + IndexedDB layer
    └── app.js      — router, views, player, uploads, everything
```

Seed videos stream from free public sample CDNs (`media.w3.org`, `test-videos.co.uk`, `cdn.plyr.io`, `cdn.jsdelivr.net`, MDN examples), so demo content plays without you uploading anything — needs internet for those, but **your uploads and all interactions work offline**. Cards use neon gradient + emoji thumbnails, so the UI itself never depends on an image CDN.
