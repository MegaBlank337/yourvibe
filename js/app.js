/* ═══════════════════════════════════════════════════════
   YourVibe — App (real backend edition)
   All videos/comments live on the server (Render API +
   Supabase storage). Likes/history/subs are per-browser.
   Routes: #/home #/shorts[/:id] #/subscriptions #/library
           #/channel #/c/:name #/watch/:id #/upload
           #/settings #/results?q=…
   ═══════════════════════════════════════════════════════ */
(function () {
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [].slice.call((r || document).querySelectorAll(s));
  const S  = YV.store.state;

  const main   = $('#main');
  const toasts = $('#toasts');
  let cleanups = [];
  let shortsMuted = true;
  let UPLOADING = false; // true while a video upload is in flight
  /* publisher's local file blob → instant playback of your own just-uploaded video */
  const LOCAL_PLAYBACK = {}; // videoId -> objectURL

  /* don't let a reload kill an active upload */
  window.addEventListener('beforeunload', e => {
    if (UPLOADING) { e.preventDefault(); e.returnValue = ''; }
  });

  function runCleanups() { cleanups.forEach(f => { try { f(); } catch (e) {} }); cleanups = []; }

  /* ═══════════ API ═══════════ */
  /* the API serves the website itself → same origin (no hardcoded URLs) */
  const API_BASE = (function(){ try { const saved = localStorage.getItem('yv_api_base'); if (saved) return saved; } catch(e){} return ''; })();

  async function api(path, opts) {
    const headers = Object.assign({}, (opts && opts.headers) || {});
    if (S.auth && S.auth.token) headers['X-Auth'] = S.auth.token;
    const r = await fetch(API_BASE + path, Object.assign({}, opts, { headers }));
    if (!r.ok) {
      let m = '';
      try { m = (await r.json()).error || ''; } catch (e) {}
      throw new Error(m || ('HTTP ' + r.status));
    }
    if (r.status === 204) return null;
    return r.json();
  }

  let LIVE_NOW = [];          // currently live streams
  let VERIFIED = new Set();   // creator names with the verified badge
  let COLORS = {};            // creator name -> channel rank color (bronze..ruby)
  let NOTIFS = [];            // admin notifications (latest 10)
  let VIDEOS = [];
  let CREATORS = {};   // { uploaderName: subscriberCount }
  let videosLoaded = false;

  /* ONE round-trip boot (fast): feed + creators + avatars + announcement + account.
     Falls back to the split endpoints if /api/boot hiccups. */
  async function loadBoot() {
    let b;
    try {
      b = await api('/api/boot');
    } catch (e) {
      const vids = await api('/api/videos');
      const creators = await api('/api/creators').catch(() => ({}));
      b = { videos: vids, creators: creators || {}, avatars: {}, announcement: null };
    }
    VIDEOS = b.videos || [];
    CREATORS = b.creators || {};
    AVATARS = Object.assign({}, b.avatars || {});
    COLORS = b.colors || {};
    VERIFIED = new Set(b.verified || []);
    NOTIFS = b.notifications || [];
    videosLoaded = true;
    if (b.announcement !== undefined) { ANN = b.announcement; renderAnnouncement(); }
    renderNotifs();
    if (b.me && S.auth && S.auth.token) {
      if (b.me.avatar_url) { S.acctAvatar = b.me.avatar_url; AVATARS[S.auth.username.toLowerCase()] = b.me.avatar_url; }
      if (b.me.banner_url) S.acctBanner = b.me.banner_url;
      if (b.me.bio) S.myChannel.bio = b.me.bio;
      if (b.me.channel_color) S.myColor = b.me.channel_color;
      renderMe();
    }
    saveFeedCache();
  }

  async function loadVideos() { return loadBoot(); }

  /* ── instant-load feed cache (stale-while-revalidate) ── */
  const FEED_CACHE = 'yv_feed_v1';

  function saveFeedCache() {
    try { localStorage.setItem(FEED_CACHE, JSON.stringify({ v: VIDEOS, c: CREATORS, a: AVATARS, ver: [...VERIFIED], n: NOTIFS, col: COLORS, t: Date.now() })); } catch (e) {}
  }

  function hydrateFeedCache() {
    try {
      const raw = localStorage.getItem(FEED_CACHE);
      if (!raw) return false;
      const j = JSON.parse(raw);
      if (!Array.isArray(j.v)) return false;
      VIDEOS = j.v;
      CREATORS = j.c || {};
      AVATARS = j.a || {};
      VERIFIED = new Set(j.ver || []);
      NOTIFS = j.n || [];
      COLORS = j.col || {};
      videosLoaded = true;
      return true;
    } catch (e) { return false; }
  }

  function feedSig() {
    return VIDEOS.length + '|' + VIDEOS.map(x => x.id + ':' + (x.views || 0) + ':' + (x.likes || 0) + ':' + (x.parts || 1) + ':' + (x.video_url || '').length + ':' + (x.thumb_url || '').length).join(',').length
      + '|' + Object.keys(CREATORS).map(k => k + CREATORS[k]).join('').length
      + '|' + Object.keys(AVATARS).length
      + '|' + VERIFIED.size + ':' + NOTIFS.length + ':' + Object.keys(COLORS).length;
  }

  function byId(id) { return VIDEOS.find(v => v.id === id); }

  const loadingHTML = () => '<div class="loading-box"><div class="spinner"></div><p>Waking up the servers…</p></div>';

  function apiErrHTML() {
    return '<div class="empty"><div class="empty-ico">📡</div>'
      + '<h3>Can\'t reach the video server</h3>'
      + '<p>The free API may be waking up (takes up to a minute) — or it isn\'t connected yet.</p>'
      + '<button class="btn-neon" data-action="retry">↻ Try again</button></div>';
  }

  /* ensure feed is loaded; retry once silently before showing any error */
  async function ensureVideos() {
    if (videosLoaded) return true;
    main.innerHTML = loadingHTML();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await loadVideos(); main.innerHTML = ''; return true; }
      catch (e) { if (attempt === 1) await new Promise(r => setTimeout(r, 4000)); }
    }
    main.innerHTML = apiErrHTML();
    return false;
  }

  /* ═══════════ helpers ═══════════ */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtNum(n) {
    n = Math.round(n || 0);
    const t = x => parseFloat(x.toFixed(1));
    if (n >= 1e6) return t(n / 1e6) + 'M';
    if (n >= 1e3) return t(n / 1e3) + 'K';
    return String(n);
  }

  function timeAgo(ts) {
    if (!ts) return 'just now';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' minute' + (m > 1 ? 's' : '') + ' ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' hour' + (h > 1 ? 's' : '') + ' ago';
    const d = Math.floor(h / 24);
    if (d < 7) return d + ' day' + (d > 1 ? 's' : '') + ' ago';
    const w = Math.floor(d / 7);
    return w + ' week' + (w > 1 ? 's' : '') + ' ago';
  }

  function prettyName(fn) {
    return fn.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\b\w/g, c => c.toUpperCase()) || 'Untitled vibe';
  }

  function fmtSize(b) { return (b / 1048576).toFixed(1) + ' MB'; }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function toast(msg, icon) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = (icon ? '<span class="t-ico">' + icon + '</span>' : '') + '<span>' + msg + '</span>';
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2300);
  }

  /* ═══════════ content model ═══════════ */
  const myName = () => (S.auth && S.auth.username) || S.myChannel.name;
  const meCh = () => ({ id: 'me', isMe: true, name: myName(), colors: S.myChannel.colors });

  const AV_PALETTES = [['#ff2bd6', '#7b2ff7'], ['#00e5ff', '#2d6bff'], ['#39ff14', '#00e5ff'], ['#ff9d00', '#ff2bd6'], ['#8a2be2', '#00e5ff'], ['#00ffa3', '#39ff14']];
  function hashHue(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function palFor(name) { return AV_PALETTES[hashHue(name || '?') % AV_PALETTES.length]; }

  /* account avatars (server-side) → real icons instead of letters */
  let AVATARS = {}; // lowercase name -> dataURL

  async function loadAvatars(names) {
    const uniq = [];
    const seen = {};
    (names || []).forEach(n => {
      const k = String(n || '').toLowerCase();
      if (k && !seen[k] && !AVATARS[k]) { seen[k] = 1; uniq.push(k); }
    });
    if (!uniq.length) return;
    try {
      const m = await api('/api/avatars?names=' + encodeURIComponent(uniq.slice(0, 60).join(',')));
      const before = Object.keys(AVATARS).length;
      Object.assign(AVATARS, m || {});
      if (Object.keys(AVATARS).length !== before && typeof renderMe === 'function') renderMe();
    } catch (e) {}
  }

  /* uploader pseudo-channel of a video */
  function upOf(v) {
    const isMe = v.uploader === S.myChannel.name;
    return { name: v.uploader, isMe, colors: isMe ? S.myChannel.colors : palFor(v.uploader) };
  }

  const isLiked = id => !!S.likes[id];
  const isSub = name => !!S.subs[name];
  /* like count lives on the server now — never add +1 locally */
  const likesOf = v => Number(v.likes) || 0;
  const viewsOf = v => Number(v.views) || 0;
  const subsOfCreator = name => Number(CREATORS[name]) || 0;
  const agoOf = v => timeAgo(v.created_at ? Date.parse(v.created_at) : 0);
  /* thumbnails: bunny-cdn thumbs are hotlink-protected — proxy them same-origin */
  /* thumbnails: one cache-busted retry, then hide gracefully */
  document.addEventListener('error', e => {
    const im = e.target;
    if (!im || im.tagName !== 'IMG' || !im.src || !im.src.includes('/api/thumb/')) return;
    if (!im.dataset.re) { im.dataset.re = '1'; im.src = im.src.split('?')[0] + '?r=' + Date.now(); return; }
    im.style.display = 'none';
  }, true);

  /* ── hover preview: play the first seconds muted when hovering a card ── */
  let hoverTimer = null, hoverVid = null;
  document.addEventListener('mouseover', e => {
    const th = e.target.closest('.thumb[data-vid]');
    if (!th || matchMedia('(hover: none)').matches || hoverTimer) return;
    hoverTimer = setTimeout(() => {
      const v = byId(th.dataset.vid);
      if (!v || th.querySelector('video')) return;
      const el = document.createElement('video');
      el.className = 'thumb-prev';
      el.muted = true; el.loop = true; el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.preload = 'metadata';
      el.src = srcOf(v);
      el.addEventListener('loadeddata', () => { try { el.currentTime = 4; } catch (x) {} });
      el.addEventListener('error', () => { el.remove(); if (hoverVid === el) hoverVid = null; });
      el.play().catch(() => {});
      th.appendChild(el);
      hoverVid = el;
    }, 550);
  });
  document.addEventListener('mouseout', e => {
    if (!e.target.closest || !e.target.closest('.thumb[data-vid]')) return;
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    if (hoverVid) { hoverVid.pause(); hoverVid.remove(); hoverVid = null; }
  });

  /* ── floating hearts / emojis ── */
  function spawnHearts(x, y, emoji) {
    emoji = emoji || '❤️';
    for (let i = 0; i < 7; i++) {
      const h = document.createElement('span');
      h.className = 'float-emoji';
      h.textContent = emoji;
      h.style.left = (x - 14 + (Math.random() * 56 - 28)) + 'px';
      h.style.top = (y - 10) + 'px';
      h.style.setProperty('--dx', (Math.random() * 90 - 45) + 'px');
      h.style.animationDelay = (i * 55) + 'ms';
      document.body.appendChild(h);
      setTimeout(() => h.remove(), 1700);
    }
  }

  /* ── TikTok-style shorts comments drawer ── */
  function openShortComments(id) {
    const old = document.querySelector('.sc-drawer-wrap');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.className = 'sc-drawer-wrap';
    wrap.innerHTML = '<div class="scd-backdrop"></div><div class="scd">'
      + '<div class="scd-head"><b>💬 Comments</b><button class="scd-close">✕</button></div>'
      + '<div class="scd-list">' + loadingHTML() + '</div>'
      + '<form class="scd-form"><div class="c-stick-wrap"><button type="button" class="c-stick" data-stick>😄</button><div class="stick-picker hide">' + STICKERS.map(s => '<button type="button" class="stk" data-e="' + s + '">' + s + '</button>').join('') + '</div></div><input maxlength="150" placeholder="Add a comment…"><button class="pill-btn" type="submit">➤</button></form>'
      + '</div>';
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.scd-backdrop').onclick = close;
    wrap.querySelector('.scd-close').onclick = close;
    const list = wrap.querySelector('.scd-list');
    const load = async () => {
      try {
        const cl = await api('/api/videos/' + id + '/comments');
        list.innerHTML = (cl || []).length ? cl.slice().reverse().map(c => {
          const pal = palFor(c.author);
          return '<div class="scd-item">' + avatarHTML({ name: c.author, colors: pal }, 34)
            + '<div class="scd-body"><div class="scd-name">@' + nameHTML(c.author) + '</div>'
            + '<div class="scd-txt">' + linkify(esc(c.text)) + '</div>'
            + '<div class="scd-time">' + timeAgo(c.created_at ? Date.parse(c.created_at) : Date.now()) + '</div></div></div>';
        }).join('') : '<p class="muted-txt" style="padding:14px;text-align:center">No comments yet — be first 💬</p>';
        list.scrollTop = list.scrollHeight;
      } catch (e) { list.innerHTML = '<p class="muted-txt" style="padding:14px">Failed to load comments</p>'; }
    };
    load();
    const f = wrap.querySelector('.scd-form');
    f.onsubmit = async e2 => {
      e2.preventDefault();
      const inp = f.querySelector('input');
      const text = (inp.value || '').trim();
      if (!text) return;
      inp.value = '';
      try { await api('/api/videos/' + id + '/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: myName(), text }) }); load(); }
      catch (e3) { toast(e3.message || 'failed', '⚠️'); }
    };
  }

  /* ── video settings modal (YouTube-Studio-like) ── */
  async function videoSettingsFlow(id) {
    const v = byId(id);
    if (!v) return;
    const isBunny = v.store === 'bunny';
    let d = document.getElementById('vidSetModal');
    if (d) d.remove();
    d = document.createElement('div');
    d.id = 'vidSetModal';
    d.innerHTML = '<div class="admin-box"><div class="admin-head"><span>⚙ Video settings</span><button class="admin-close" id="vsClose">✕</button></div>'
      + '<div style="padding:16px;display:flex;flex-direction:column;gap:12px;max-height:70vh;overflow-y:auto">'
      + '<div class="field"><label>Title</label><input id="vsTitle" maxlength="100" value="' + esc(v.title) + '"></div>'
      + '<div class="field"><label>Description</label><textarea id="vsDesc" rows="3">' + esc(v.description || '') + '</textarea></div>'
      + '<div class="field-row">'
      + '<div class="field"><label>Category</label><select id="vsCat">' + YV.CATS.map(c2 => '<option' + (c2 === v.category ? ' selected' : '') + '>' + c2 + '</option>').join('') + '</select></div>'
      + '<div class="field"><label>Visibility</label><select id="vsVis"><option value="public"' + (v.visibility !== 'unlisted' ? ' selected' : '') + '>🌐 Public</option><option value="unlisted"' + (v.visibility === 'unlisted' ? ' selected' : '') + '>🔒 Unlisted</option></select></div>'
      + '</div>'
      + '<div class="field"><label>Comments</label><div class="radio-row">'
      + '<label class="rd"><input type="radio" name="vsCom" value="on"' + (v.comments_enabled !== false ? ' checked' : '') + '> 💬 On</label>'
      + '<label class="rd"><input type="radio" name="vsCom" value="off"' + (v.comments_enabled === false ? ' checked' : '') + '> 🚫 Off</label>'
      + '</div></div>'
      + '<div class="field"><label>🖼 Graphics — this device only</label><div class="field-row">'
      + '<div class="field"><label>Playback quality</label><select id="vsQualLocal">'
      + [['auto', 'Auto (best)'], ['1080', 'Max 1080p'], ['720', 'Max 720p'], ['480', 'Max 480p']].map(q3 =>
        '<option value="' + q3[0] + '"' + ((localStorage.getItem('yv_qual') || 'auto') === q3[0] ? ' selected' : '') + '>' + q3[1] + '</option>').join('')
      + '</select></div>'
      + '<div class="field"><label>Display filter</label><select id="vsFltLocal">'
      + [['none', 'None'], ['saturate(1.55) contrast(1.12)', 'Vivid'], ['grayscale(1)', 'Mono'], ['sepia(.55) saturate(1.25)', 'Warm'], ['hue-rotate(150deg) saturate(1.3)', 'Cool'], ['invert(1) hue-rotate(180deg)', 'X-Ray']].map(f4 =>
        '<option value="' + f4[0] + '"' + ((localStorage.getItem('yv_filter') || 'none') === f4[0] ? ' selected' : '') + '>' + f4[1] + '</option>').join('')
      + '</select></div>'
      + '</div><p class="muted-txt">saved on this device — applies to every video you watch here</p></div>'
      + '<div class="field"><label>Quality (bunny videos — CDN re-encodes to fit)</label>'
      + (isBunny
        ? '<select id="vsQual">'
          + [['240p', '240p (mobile data saver)'], ['360p', '360p'], ['480p', '480p'], ['720p', '720p HD'], ['1080p', '1080p Full HD']].map(q2 =>
            '<option value="' + q2[0] + '"' + (v.quality_max === q2[0] ? ' selected' : '') + '>' + q2[1] + '</option>').join('')
          + '</select><p class="muted-txt">max quality — Bunny keeps every resolution below it</p>'
        : '<p class="muted-txt">Multi-quality is available for bunny-hosted videos</p>')
      + '</div>'
      + '<button class="btn-neon" id="vsSave">💾 Save settings</button>'
      + '</div></div>';
    document.body.appendChild(d);
    d.querySelector('#vsClose').onclick = () => d.remove();
    d.querySelector('#vsSave').onclick = async () => {
      try {
        const body = {
          title: d.querySelector('#vsTitle').value.trim(),
          description: d.querySelector('#vsDesc').value,
          category: d.querySelector('#vsCat').value,
          visibility: d.querySelector('#vsVis').value,
          comments_enabled: d.querySelector('input[name="vsCom"]:checked').value === 'on',
        };
        if (!body.title) { toast('Title needed', '⚠️'); return; }
        await api('/api/videos/' + id + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        /* LOCAL graphics settings — per device, like YouTube's player gear */
        try {
          localStorage.setItem('yv_qual', d.querySelector('#vsQualLocal').value);
          localStorage.setItem('yv_filter', d.querySelector('#vsFltLocal').value);
        } catch (e4) {}
        toast('Settings saved ⚙', '✅');
        d.remove();
        await loadVideos();
        navigate();
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
    };
  }

  /* ── subtitles editor (owner) — lines "0:05 text" ── */
  function subsEditor(id) {
    const meta = byId(id) || {};
    const rows = Array.isArray(meta.subtitles) ? meta.subtitles.slice() : [];
    const ta = rows.map(s => fmtT(s.t) + ' ' + (s.text || '')).join('\n');
    let d = document.getElementById('subsModal');
    if (d) d.remove();
    d = document.createElement('div');
    d.id = 'subsModal';
    d.innerHTML = '<div class="admin-box"><div class="admin-head"><span>📝 Subtitles</span><button class="admin-close" id="subsClose">✕</button></div>'
      + '<div style="padding:16px;display:flex;flex-direction:column;gap:10px">'
      + '<p class="muted-txt">One line per subtitle — <b>0:05 текст</b> (shown for 4s). Auto-subs from a live recording appear here too.</p>'
      + '<textarea id="subsTa" rows="10" style="background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:10px;color:var(--txt);padding:10px;font-family:inherit">' + esc(ta) + '</textarea>'
      + '<button class="pill-btn" id="subsSave">💾 Save subtitles</button>'
      + '</div></div>';
    document.body.appendChild(d);
    d.querySelector('#subsClose').onclick = () => d.remove();
    d.querySelector('#subsSave').onclick = async () => {
      const rows2 = String(d.querySelector('#subsTa').value || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const m = l.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.{1,160})$/);
        return m ? { t: (+((m[1] || 0)) * 60) + (+m[2]) * 60 + (+m[3]), text: m[4] } : null;
      }).filter(Boolean).sort((a, b) => a.t - b.t);
      try {
        await api('/api/videos/' + id + '/subs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subs: rows2 }) });
        meta.subtitles = rows2;
        toast('Subtitles saved 📝', '✅');
        d.remove();
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
    };
  }

  /* ── add-to-playlist modal (watch page) ── */
  async function plAddFlow(videoId) {
    let pls = [];
    try { pls = await api('/api/playlists'); } catch (e) { toast('Log in to use playlists 🔒', '🔒'); return; }
    const d = document.createElement('div');
    d.id = 'plModal';
    d.innerHTML = '<div class="admin-box"><div class="admin-head"><span>▶ Add to playlist</span><button class="admin-close" id="plClose">✕</button></div>'
      + '<div style="padding:16px;display:flex;flex-direction:column;gap:10px">'
      + (pls.length ? pls.map(pl => '<div class="pl-row"><b>' + esc(pl.name) + '</b><span class="muted-txt">' + pl.items.length + ' videos</span><button class="pill-btn" data-pl-add="' + pl.id + '" data-vid="' + videoId + '">＋ Add</button></div>').join('') : '<p class="muted-txt">No playlists yet — create one below.</p>')
      + '<div class="admin-row"><input type="text" id="plNewName" maxlength="60" placeholder="New playlist name"><button class="pill-btn" id="plCreate">＋ Create</button></div>'
      + '</div></div>';
    document.body.appendChild(d);
    d.querySelector('#plClose').onclick = () => d.remove();
    d.addEventListener('click', e => {
      if (e.target === d) d.remove();
      const add = e.target.closest('[data-pl-add]');
      if (add) {
        api('/api/playlists/' + add.dataset.plAdd + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: add.dataset.vid }) })
          .then(() => { toast('Added to playlist ▶', '✅'); d.remove(); })
          .catch(e2 => toast(e2.message || 'failed', '⚠️'));
      }
    });
    d.querySelector('#plCreate').onclick = async () => {
      const name = (d.querySelector('#plNewName').value || '').trim();
      if (!name) return;
      try {
        const created = await api('/api/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        await api('/api/playlists/' + created.id + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId }) });
        toast('Playlist "' + name + '" created ▶', '✅');
        d.remove();
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
    };
  }

  /* ── stream bell (channel page) ── */
  let STREAM_SUBS = [];
  async function loadStreamSubs() { try { STREAM_SUBS = await api('/api/stream-subs'); } catch (e) { STREAM_SUBS = []; } }
  function streamBellHTML(name) {
    if (!S.auth || !S.auth.token) return '';
    const on = STREAM_SUBS.includes(name);
    return '<button class="pill-btn' + (on ? ' on' : ' ghost') + '" data-action="stream-bell" data-ch="' + esc(name) + '">' + (on ? '🔔 Notify on' : '🔕 Notify streams') + '</button>';
  }

  document.addEventListener('click', async e => {
    const stk = e.target.closest('[data-stick]');
    if (stk) {
      e.preventDefault();
      const wrap = stk.closest('.c-stick-wrap');
      const pk = wrap && wrap.querySelector('.stick-picker');
      if (pk) pk.classList.toggle('hide');
      return;
    }
    const em = e.target.closest('.stk');
    if (em) {
      e.preventDefault();
      const wrap = em.closest('.c-stick-wrap');
      const form = wrap && wrap.closest('form');
      const inp = form && form.querySelector('input[name="ctext"], input[maxlength="150"], input[maxlength="300"]');
      if (inp) inp.value = (inp.value || '') + em.dataset.e;
      if (wrap) { const pk = wrap.querySelector('.stick-picker'); if (pk) pk.classList.add('hide'); }
      return;
    }
    const cl = e.target.closest('[data-clike]');
    if (cl) {
      e.preventDefault();
      const cid = Number(cl.dataset.clike);
      const n = cl.querySelector('.cl-n');
      try {
        const r = await api('/api/videos/' + curCommentVid + '/comments/' + cid + '/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voter: supportName() }) });
        if (n) n.textContent = r.likes ? fmtNum(r.likes) : '';
        cl.classList.toggle('on', !!r.likes);
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
      return;
    }
    const cr = e.target.closest('[data-creply]');
    if (cr) {
      e.preventDefault();
      const item = cr.closest('.c-item');
      if (!item || item.querySelector('.c-mini-form')) return;
      const form = document.createElement('form');
      form.className = 'c-mini-form';
      form.dataset.form = 'creply';
      form.dataset.parent = cr.dataset.creply;
      form.innerHTML = '<input name="ctext" placeholder="Reply to @' + cr.dataset.cuser + '…" maxlength="300"><button class="pill-btn">➤</button>';
      const box = item.querySelector('.c-replies');
      box.before(form);
      form.querySelector('input').focus();
      return;
    }
    const pp = e.target.closest('[data-pl-play]');
    if (pp) {
      try {
        const pls = await api('/api/playlists');
        const pl = pls.find(x => String(x.id) === pp.dataset.plPlay);
        if (pl && pl.items.length) {
          S.playQueue = pl.items.slice(1);
          YV.store.save();
          location.hash = '#/watch/' + pl.items[0];
          toast('Playing playlist: ' + pl.name + ' ▶', '⏭');
        }
      } catch (e2) {}
      return;
    }
    const ia = e.target.closest('[data-inv-accept]');
    if (ia) {
      try {
        await api('/api/collab-invites/' + ia.dataset.invAccept + '/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        toast('Collab accepted 👥 — the video is on your channel', '✅');
        navigate();
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
      return;
    }
    const idecl = e.target.closest('[data-inv-decline]');
    if (idecl) {
      try {
        await api('/api/collab-invites/' + idecl.dataset.invDecline + '/decline', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        toast('Invite declined', '👥');
        navigate();
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
      return;
    }
    const pd = e.target.closest('[data-pl-del]');
    if (pd) {
      try { await api('/api/playlists/' + pd.dataset.plDel, { method: 'DELETE' }); toast('Playlist deleted 🗑', '🗑'); navigate(); } catch (e2) {}
      return;
    }
    const sb = e.target.closest('[data-action="stream-bell"]');
    if (sb) {
      try {
        const r = await api('/api/stream-subs/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creator: sb.dataset.ch }) });
        toast(r.on ? '🔔 ON — you will know when they go live' : '🔕 Notifications off', r.on ? '🔔' : '🔕');
        navigate();
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
      return;
    }
  });
  document.addEventListener('submit', async e => {
    const f = e.target;
    if (f.dataset && f.dataset.form === 'creply') {
      e.preventDefault();
      const input = f.querySelector('input');
      const text = (input.value || '').trim();
      if (!text) return;
      input.value = '';
      try {
        const c = await api('/api/videos/' + curCommentVid + '/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: myName(), text, parent: f.dataset.parent }) });
        const holder = f.parentElement;
        const box = holder.querySelector('.c-replies');
        if (box) box.insertAdjacentHTML('beforeend', cItemHTML(Object.assign({}, c, { parent_id: Number(f.dataset.parent) })));
        f.remove();
        toast('Reply posted 💬', '↩');
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
    }
  });

  /* ── v100 helpers ── */
  const STICKERS = ['😂', '❤️', '🔥', '👏', '😮', '😢', '🤯', '💩', '🎉', '👍', '🚀', '🌈', '😎', '🥳', '😤', '👻', '🤖', '🐱', '🍕', '⭐', '💀', '🤝'];
  function linkify(s) {
    return String(s)
      .replace(/#([\p{L}\d_]{2,30})/gu, '<a class="tag-link" href="#/tag/$1">#$1</a>')
      .replace(/(^|[\s(])@([a-zA-Z0-9_]{2,20})/g, '$1<a class="mention-link" href="#/c/$2">@$2</a>');
  }
  const fmtT = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  function renderChapters(v) {
    try {
      const rows = String(v.description || '').split('\n').map(l => l.trim())
        .map(l => { const m = l.match(/^(?:\d{1,2}:)?(\d{1,2}):(\d{2})\s+(.{2,80})$/); return m ? { t: (+m[1]) * 60 + (+m[2]), label: m[3] } : null; })
        .filter(Boolean);
      if (rows.length < 2) return;
      const p = document.querySelector('#yvPlayer');
      if (!p || p.parentElement.querySelector('.chapters-row')) return;
      const row = document.createElement('div');
      row.className = 'chapters-row';
      row.innerHTML = '<div class="ch-head">📑 Chapters</div>' + rows.map(c =>
        '<button class="ch-btn" data-t="' + c.t + '">' + esc(c.label) + ' · ' + fmtT(c.t) + '</button>').join('');
      row.querySelectorAll('.ch-btn').forEach(b => b.onclick = () => {
        const v2 = document.querySelector('#yvVideo');
        if (v2) { v2.currentTime = Number(b.dataset.t); v2.play().catch(() => {}); }
      });
      p.parentElement.insertBefore(row, p.nextSibling);
    } catch (e) {}
  }

  /* ── mini-player: a playing video follows you across pages ── */
  let miniBox = null;
  function showMiniPlayer(el, vid, title) {
    closeMiniPlayer();
    const box = document.createElement('div');
    box.className = 'mini-player';
    box.innerHTML = '<div class="mp-head"><span class="mp-t">' + esc(String(title || '').slice(0, 40)) + '</span>'
      + '<button class="mp-go" title="Open">↗</button><button class="mp-x" title="Close">✕</button></div>';
    box.appendChild(el);
    document.body.appendChild(box);
    miniBox = { box, vid, el };
    box.querySelector('.mp-x').onclick = () => { el.pause(); box.remove(); miniBox = null; };
    box.querySelector('.mp-go').onclick = () => { location.hash = '#/watch/' + vid; };
  }
  function closeMiniPlayer() {
    if (miniBox) { try { miniBox.el.pause(); } catch (e) {} miniBox.box.remove(); miniBox = null; }
  }

  /* ── social links row (channel pages) ── */
  function socialHTML(links) {
    if (!links) return '';
    const out = [];
    if (links.yt) out.push('<a class="soc-link" href="' + esc(links.yt) + '" target="_blank" rel="noopener" title="YouTube">▶</a>');
    if (links.tg) out.push('<a class="soc-link" href="' + esc(links.tg) + '" target="_blank" rel="noopener" title="Telegram">✈</a>');
    if (links.ig) out.push('<a class="soc-link" href="' + esc(links.ig) + '" target="_blank" rel="noopener" title="Instagram">📷</a>');
    return out.length ? '<span class="soc-row">' + out.join('') + '</span>' : '';
  }

  function thumbSrc(v) {
    if (v.store === 'bunny' && v.thumb_url && v.thumb_url.includes('b-cdn')) {
      /* same-origin proxy; ?v=2 busts devices that cached the old hotlink-403 */
      return API_BASE + '/api/thumb/' + v.id + '?v=2';
    }
    return v.thumb_url || '';
  }

  /* multi-segment videos stream through the API as one file.
     Publisher's own fresh bunny video → play the LOCAL file instantly (no encoding wait) */
  const srcOf = v => {
    if (LOCAL_PLAYBACK[v.id]) return LOCAL_PLAYBACK[v.id];
    if (Number(v.parts) > 1) return API_BASE + '/stream/' + v.id;
    /* bunny 1080p files are huge — direct playback uses 720p (HLS gives full quality) */
    if (v.store === 'bunny' && /play_1080p/.test(v.video_url || '')) {
      return v.video_url.replace('play_1080p', 'play_720p');
    }
    return v.video_url;
  };

  function bumpView(v) {
    v.views = (Number(v.views) || 0) + 1;
    api('/api/videos/' + v.id + '/view', { method: 'POST' }).catch(() => {});
  }

  function addHistory(id) {
    S.history = [id].concat(S.history.filter(x => x !== id)).slice(0, 60);
    YV.store.save();
  }

  /* ═══════════ avatar & buttons ═══════════ */
  /* channel rank colors (bronze → ruby) */
  const RANKS = {
    bronze: { hex: '#d9a978', label: 'Bronze' },
    silver: { hex: '#d6d9e0', label: 'Silver' },
    gold:   { hex: '#f2d98c', label: 'Gold' },
    diamond: { hex: '#a9d6ef', label: 'Diamond' },
    ruby:   { hex: '#f0a1b0', label: 'Ruby' },
    emerald: { hex: '#3ddc84', label: 'Emerald' },
  };
  function rankOf(name) {
    const c = (COLORS[name] || '').toLowerCase();
    return RANKS[c] ? { key: c, hex: RANKS[c].hex, label: RANKS[c].label } : null;
  }

  /* verified badge next to a creator name */
  function nameHTML(name, cls) {
    const badge = VERIFIED.has(name) ? ' <span class="vrf-badge" title="Verified">✓</span>' : '';
    const rk = rankOf(name);
    const style = rk ? ' style="color:' + rk.hex + ';text-shadow:0 0 10px ' + rk.hex + '88"' : '';
    const klass = (cls ? ' class="' + cls + (rk ? ' ranked-name' : '') + '"' : (rk ? ' class="ranked-name"' : ''));
    return '<span' + klass + style + '>' + esc(name) + badge + '</span>';
  }

  function avatarHTML(c, size) {
    size = size || 36;
    let ch = c;
    if (c && (c.isMe || c.id === 'me')) {
      const mine = (S.auth && S.auth.username ? (S.acctAvatar || AVATARS[S.auth.username.toLowerCase()]) : null) || S.myChannel.avatar;
      if (mine) return '<span class="av av-img" style="width:' + size + 'px;height:' + size + 'px"><img src="' + mine + '" alt=""></span>';
      ch = { name: myName(), colors: S.myChannel.colors };
    }
    const p = (ch && ch.colors) ? ch.colors : palFor(ch && ch.name);
    const rk = rankOf(ch && ch.name);
    const rankStyle = rk ? ';--rank:' + rk.hex : '';
    const accAvatar = AVATARS[((ch && ch.name) || '').toLowerCase()];
    if (accAvatar) return '<span class="av av-img" style="width:' + size + 'px;height:' + size + 'px' + rankStyle + '"><img src="' + accAvatar + '" alt=""></span>';
    const letter = ((ch && ch.name) || '?').trim().charAt(0).toUpperCase();
    return '<span class="av" style="width:' + size + 'px;height:' + size + 'px;--c1:' + p[0] + ';--c2:' + p[1] + rankStyle + '">' + letter + '</span>';
  }

  function subBtnHTML(name, small) {
    if (!name || name === S.myChannel.name) return '';
    const on = isSub(name);
    return '<button class="sub-btn' + (on ? ' subbed' : '') + (small ? ' sm' : '') + '" data-action="sub" data-ch="' + esc(name) + '">' + (on ? '🔔 Subscribed' : 'Subscribe') + '</button>';
  }

  function likeGroupHTML(v) {
    const l = isLiked(v.id), d = !!S.dislikes[v.id];
    return '<div class="like-group">'
      + '<button class="lk-btn' + (l ? ' on' : '') + '" data-action="like" data-id="' + v.id + '">👍 <span class="cnt">' + fmtNum(likesOf(v)) + '</span></button>'
      + '<button class="lk-btn' + (d ? ' on' : '') + '" data-action="dislike" data-id="' + v.id + '">👎</button>'
      + '</div>';
  }

  /* ═══════════ cards & shelves ═══════════ */
  function thumbHTML(v) {
    const up = upOf(v);
    const p = up.colors;
    const img = v.thumb_url ? '<img loading="lazy" src="' + thumbSrc(v) + '" alt="" onerror="this.style.display=\'none\'">' : '';
    const ghost = v.type === 'short' ? '⚡' : '▶';
    return '<div class="thumb" data-vid="' + v.id + '" style="--c1:' + p[0] + ';--c2:' + p[1] + '">'
      + img
      + '<span class="thumb-ghost' + (v.thumb_url ? ' small' : '') + '">' + ghost + '</span>'
      + (v.duration && v.type !== 'short' ? '<span class="dur">' + esc(v.duration) + '</span>' : '')
      + '<button class="later-btn' + (S.later[v.id] ? ' on' : '') + '" data-action="later" data-id="' + v.id + '" title="Watch later">' + (S.later[v.id] ? '✓' : '＋') + '</button>'
      + '</div>';
  }

  function parseSizes(x) {
    if (Array.isArray(x)) return x;
    try { const p = JSON.parse(typeof x === 'string' && x ? x : '[]'); return Array.isArray(p) ? p : []; } catch (e) { return []; }
  }

  function watchHref(v) { return (v.store === 'live' && Number(v.parts) === 0) ? '#/live/' + v.id : '#/watch/' + v.id; }
  function isStream(v) { return v && v.store === 'live'; }
  function streamCardHTML(v) {
    const up = upOf(v);
    const liveNow = Number(v.parts) === 0;
    return '<a class="card stream-card" href="' + watchHref(v) + '">'
      + '<div class="thumb" data-vid="' + v.id + '" style="--c1:' + up.colors[0] + ';--c2:' + up.colors[1] + '">'
      + (v.thumb_url ? '<img loading="lazy" src="' + thumbSrc(v) + '" alt="" onerror="this.style.display=\'none\'">' : '')
      + '<span class="stream-badge' + (liveNow ? ' live' : '') + '">' + (liveNow ? '<span class="live-dot"></span>LIVE' : 'LIVE ENDED') + '</span>'
      + '</div>'
      + '<div class="meta-txt sc-meta"><h3>' + esc(v.title) + '</h3>'
      + '<div class="v-stats">👁 ' + fmtNum(viewsOf(v)) + ' views · 💬 <span class="sc-cnt" data-vid="' + v.id + '">…</span> · ' + agoOf(v) + '</div>'
      + '</div></a>';
  }
  function fillStreamCounts() {
    document.querySelectorAll('.sc-cnt').forEach(async el => {
      try { const list = await api('/api/videos/' + el.dataset.vid + '/comments'); el.textContent = String((list || []).length); }
      catch (e) { el.textContent = '0'; }
    });
  }

  function cardHTML(v) {
    const up = upOf(v);
    return '<a class="card" href="' + watchHref(v) + '">'
      + thumbHTML(v)
      + '<div class="meta">' + avatarHTML(up, 36)
      + '<div class="meta-txt">'
      + '<h3>' + esc(v.title) + '</h3>'
      + '<div class="ch-name">' + nameHTML(v.uploader) + '</div>'
      + '<div class="v-stats">' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + '</div>'
      + '</div></div></a>';
  }

  function relCardHTML(v) {
    const up = upOf(v);
    return '<a class="compact-card" href="' + watchHref(v) + '">'
      + '<div class="thumb sm" data-vid="' + v.id + '" style="--c1:' + up.colors[0] + ';--c2:' + up.colors[1] + '">'
      + (v.thumb_url ? '<img loading="lazy" src="' + thumbSrc(v) + '" alt="" onerror="this.style.display=\'none\'">' : '')
      + '<span class="thumb-ghost' + (v.thumb_url ? ' small' : '') + '">' + (v.type === 'short' ? '⚡' : '▶') + '</span>'
      + (v.duration ? '<span class="dur">' + esc(v.duration) + '</span>' : '')
      + '</div>'
      + '<div class="cc-txt"><h4>' + esc(v.title) + '</h4>'
      + '<div class="ch-name">' + nameHTML(v.uploader) + '</div>'
      + '<div class="v-stats">' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + '</div>'
      + '</div></a>';
  }

  function shortCardHTML(s) {
    const up = upOf(s);
    return '<a class="short-card" href="#/shorts/' + s.id + '">'
      + '<div class="thumb vert" style="--c1:' + up.colors[0] + ';--c2:' + up.colors[1] + '">'
      + (s.thumb_url ? '<img loading="lazy" src="' + thumbSrc(s) + '" alt="" onerror="this.style.display=\'none\'">' : '')
      + '<span class="thumb-ghost' + (s.thumb_url ? ' small' : '') + '">⚡</span>'
      + '</div>'
      + '<h4>' + esc(s.title) + '</h4>'
      + '<div class="v-stats">' + fmtNum(viewsOf(s)) + ' views</div>'
      + '</a>';
  }

  const shelf = (title, inner, extra) =>
    '<section class="shelf-wrap"><div class="shelf-head"><h2 class="section-title">' + title + '</h2>' + (extra || '') + '</div><div class="shelf">' + inner + '</div></section>';

  const emptyHTML = (ico, t, s, btn) =>
    '<div class="empty"><div class="empty-ico">' + ico + '</div><h3>' + t + '</h3><p>' + s + '</p>' + (btn || '') + '</div>';

  /* ═══════════ VIEW: HOME ═══════════ */
  function liveShelfHTML() {
    if (!LIVE_NOW.length) return '';
    return shelf('🔴 Live now', LIVE_NOW.map(s =>
      '<a class="card live-card" href="#/live/' + s.id + '">'
      + '<div class="thumb" style="--c1:#ff2bd6;--c2:#8b5cf6"><div class="live-badge"><span class="live-dot"></span>LIVE</div><span class="thumb-ghost">▶</span></div>'
      + '<div class="meta"><div class="meta-txt"><h3>' + esc(s.title) + '</h3>'
      + '<div class="ch-name">' + esc(s.broadcaster) + '</div>'
      + '<div class="v-stats" style="color:#ff5a78;font-weight:700">🔴 LIVE</div>'
      + '</div></div></a>'
    ).join(''));
  }

  async function viewHome(q) {
    if (!await ensureVideos()) return;
    try { LIVE_NOW = await api('/api/live'); } catch (e) { LIVE_NOW = []; }
    const cat = q.get('cat') || 'All';
    const tp = q.get('tp') || 'all';
    const videos = VIDEOS.filter(v => v.type !== 'short' && !isStream(v));
    const shorts = VIDEOS.filter(v => v.type === 'short');
    const tpDays = tp === 'today' ? 1 : tp === 'week' ? 7 : 0;
    const trendPool = tpDays ? videos.filter(v => Date.now() - Date.parse(v.created_at) < tpDays * 86400000) : videos;
    const trending = trendPool.slice().sort((a, b) => viewsOf(b) - viewsOf(a)).slice(0, 4);
    const filtered = cat === 'All' ? videos : videos.filter(v => v.category === cat);
    const shortList = cat === 'All' ? shorts : shorts.filter(s => s.category === cat);
    const histCats = {};
    S.history.forEach(id2 => { const hv = byId(id2); if (hv && hv.category) histCats[hv.category] = (histCats[hv.category] || 0) + 1; });
    const topCat = Object.keys(histCats).sort((a, b) => histCats[b] - histCats[a])[0] || '';
    const forYou = topCat ? videos.filter(v => v.category === topCat && !S.history.includes(v.id)).slice(0, 4) : [];

    main.innerHTML =
      '<div class="chips">' + ['All'].concat(YV.CATS).map(c =>
        '<a class="chip' + (c === cat ? ' on' : '') + '" href="#/home?cat=' + encodeURIComponent(c) + '">' + c + '</a>').join('') + '</div>'

      + (trending.length ? shelf('<span class="tp-wrap">🔥 Trending <span class="tp-chips">'
        + [['all', 'All time'], ['today', '⚡ Today'], ['week', '📅 Week']].map(pk => '<a class="chip' + (tp === pk[0] ? ' on' : '') + '" href="#/home?tp=' + pk[0] + (cat !== 'All' ? '&cat=' + encodeURIComponent(cat) : '') + '">' + pk[1] + '</a>').join('')
        + '</span></span>', trending.map(cardHTML).join('')) : '')
      + (typeof liveShelfHTML === 'function' ? liveShelfHTML() : '')

      + (shortList.length ? shelf('⚡ Shorts', shortList.slice(0, 10).map(shortCardHTML).join('')) : '')
      + (forYou.length && cat === 'All' ? shelf('🎯 For you' + (topCat ? ' — ' + esc(topCat) : ''), forYou.map(cardHTML).join('')) : '')

      + '<section class="recs"><div class="shelf-head"><h2 class="section-title">✨ Recommended</h2></div>'
      + (filtered.length
        ? '<div class="cards">' + filtered.map(cardHTML).join('') + '</div>'
        : (cat === 'All'
          ? emptyHTML('🎬', 'No videos yet', 'Be the very first to upload something — your video appears here for everyone.',
            '<a class="btn-neon" href="#/upload">＋ Upload the first video</a>')
          : emptyHTML('🕳️', 'Nothing in “' + esc(cat) + '” yet', 'Try another category — or upload the first ' + esc(cat) + ' video.', '<a class="btn-neon" href="#/upload">＋ Upload</a>')))
      + '</section>';
  }

  /* ═══════════ VIEW: SHORTS ═══════════ */
  async function viewShorts(startId) {
    if (!await ensureVideos()) return;
    const shorts = VIDEOS.filter(v => v.type === 'short');
    if (!shorts.length) {
      main.innerHTML = emptyHTML('⚡', 'No Shorts yet', 'Upload a vertical clip and start the feed for everyone.',
        '<a class="btn-neon" href="#/upload">＋ Upload a Short</a>');
      return;
    }

    main.innerHTML = '<div class="shorts-feed">' + shorts.map(s => {
      const up = upOf(s);
      const liveNow = false;
      return '<section class="short" data-short="' + s.id + '">'
        + '<div class="short-stage">'
        + '<div class="short-left">'
        + '<div class="sl-cat">' + (s.category ? '🎮 ' + esc(s.category) : '⚡ Short') + '</div>'
        + '<a class="sl-user" href="#/c/' + encodeURIComponent(s.uploader) + '">' + avatarHTML(up, 42)
        + '<b>@' + esc(s.uploader) + '</b></a>'
        + subBtnHTML(s.uploader, true)
        + '<div class="short-title">' + esc(s.title) + '</div>'
        + '<a class="sl-sound" href="#/watch/' + s.id + '">▶ <span>original sound — ' + esc(s.uploader) + '</span></a>'
        + '</div>'
        + '<div class="short-frame">'
        + '<video loop muted playsinline preload="metadata"' + (s.thumb_url ? ' poster="' + s.thumb_url + '"' : '') + ' src="' + srcOf(s) + '"></video>'
        + '<div class="v-spin v-spin-s"><i></i></div>'
        + '<div class="short-hint">Tap to pause</div>'
        + '</div>'
        + '<div class="short-rail">'
        + '<div class="rail-item"><button class="rail-btn' + (isLiked(s.id) ? ' on' : '') + '" data-action="like" data-id="' + s.id + '"><span class="ric">' + (isLiked(s.id) ? '❤️' : '🤍') + '</span></button><span class="rail-lbl">' + fmtNum(likesOf(s)) + '</span></div>'
        + '<div class="rail-item"><button class="rail-btn" data-action="short-comments" data-id="' + s.id + '" title="Comments"><span class="ric">💬</span></button><span class="rail-lbl rail-cnt-c" data-vid="' + s.id + '">…</span></div>'
        + '<div class="rail-item"><button class="rail-btn" data-action="share" data-id="' + s.id + '"><span class="ric">🔗</span></button><span class="rail-lbl">Share</span></div>'
        + '<div class="rail-item"><button class="rail-btn mute-btn" data-action="mute-shorts"><span class="ric">' + (shortsMuted ? '🔇' : '🔊') + '</span></button><span class="rail-lbl">Sound</span></div>'
        + '</div>'
        + '</div>'
        + '</section>';
    }).join('') + '</div>'
      + '<div class="shorts-nav"><button id="shPrev" title="Previous">↑</button><button id="shNext" title="Next">↓</button></div>';

    /* real comment counters */
    document.querySelectorAll('.rail-cnt-c').forEach(async el => {
      try { const list = await api('/api/videos/' + el.dataset.vid + '/comments'); el.textContent = String((list || []).length); }
      catch (e) { el.textContent = '💬'; }
    });
    /* ↑↓ navigation */
    const feedEl = document.querySelector('.shorts-feed');
    const secEls = Array.from(document.querySelectorAll('.shorts-feed .short'));
    const shStep = dir => {
      if (!feedEl || !secEls.length) return;
      const cur = Math.round(feedEl.scrollTop / Math.max(1, feedEl.clientHeight));
      const idx = Math.max(0, Math.min(secEls.length - 1, cur + dir));
      secEls[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const prevB = document.getElementById('shPrev');
    const nextB = document.getElementById('shNext');
    if (prevB) prevB.onclick = () => shStep(-1);
    if (nextB) nextB.onclick = () => shStep(1);
    const shKeys = e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); shStep(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); shStep(-1); }
    };
    document.addEventListener('keydown', shKeys);
    cleanups.push(() => document.removeEventListener('keydown', shKeys));

    const io = new IntersectionObserver(es => es.forEach(en => {
      const vid = en.target;
      if (en.isIntersecting) {
        if (!vid.dataset.seen) { vid.dataset.seen = '1'; const v = byId(vid.parentElement.dataset.short); if (v) bumpView(v); }
        vid.muted = shortsMuted;
        vid.play().catch(() => {});
      } else vid.pause();
    }), { threshold: 0.6 });
    $$('.shorts-feed video').forEach(v => {
      io.observe(v);
      const sp = v.parentElement.querySelector('.v-spin');
      if (sp) {
        const on = () => sp.classList.add('on');
        const off = () => sp.classList.remove('on');
        v.addEventListener('waiting', on);
        v.addEventListener('seeking', () => { if (v.readyState < 3) on(); });
        v.addEventListener('playing', off);
        v.addEventListener('canplay', off);
        v.addEventListener('seeked', off);
        v.addEventListener('pause', off);
        on();
      }
    });
    cleanups.push(() => io.disconnect());

    if (startId) {
      const el = $('.shorts-feed [data-short="' + startId + '"]');
      if (el) el.scrollIntoView({ block: 'start' });
    }
  }

  /* ═══════════ VIEW: SUBSCRIPTIONS ═══════════ */
  async function viewSubs() {
    if (!await ensureVideos()) return;
    const names = Object.keys(S.subs);
    if (!names.length) {
      main.innerHTML = emptyHTML('📺', 'No subscriptions yet',
        'Hit Subscribe on any creator and their uploads land here.',
        '<a class="btn-neon" href="#/home">Browse videos</a>');
      return;
    }
    const vids = VIDEOS.filter(v => S.subs[v.uploader] && !isStream(v));
    main.innerHTML =
      '<h1 class="page-title">Subscriptions</h1>'
      + '<div class="sub-chips">' + names.map(n =>
        '<a class="sub-chip" href="#/c/' + encodeURIComponent(n) + '">' + avatarHTML({ name: n, colors: palFor(n) }, 44) + '<span>' + nameHTML(n) + '</span></a>').join('') + '</div>'
      + (vids.length ? '<div class="cards">' + vids.map(cardHTML).join('') + '</div>'
        : '<p class="muted-txt pad">No uploads from these creators yet.</p>');
  }

  /* ═══════════ VIEW: GUEST CO-HOST ═══════════ */
  async function viewGuest(id) {
    const t = (location.hash.split('?t=')[1] || '').trim();
    main.innerHTML = '<div class="page up-page"><h1 class="page-title">👥 Co-host camera</h1>'
      + '<p class="muted-txt">Your camera will stream into the live broadcast as a small window 📺</p>'
      + '<div class="up-preview" style="max-width:560px"><video id="gVid" autoplay muted playsinline></video></div>'
      + '<div class="form-err" id="gErr"></div>'
      + '<button class="btn-neon" id="gStart">🎥 Start camera</button>'
      + '<button class="btn-neon danger hide" id="gStop">⏹ Stop</button></div>';
    let stream = null, running = false, i = 0;
    document.getElementById('gStart').onclick = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 }, audio: true });
        document.getElementById('gVid').srcObject = stream;
        document.getElementById('gStart').classList.add('hide');
        document.getElementById('gStop').classList.remove('hide');
        running = true; i = 0;
        toast('You are LIVE as co-host 👥', '🔴');
        (async () => {
          while (running) {
            const sr = await fetch(API_BASE + '/api/live/' + id + '/guest-sign?token=' + encodeURIComponent(t) + '&i=' + i, { headers: { Accept: 'application/json' } }).then(r => r.json()).catch(() => null);
            if (!sr || !sr.upload) { document.getElementById('gErr').textContent = '⚠️ Stream offline — stopped'; return; }
            await new Promise(res => {
              const rr = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
              rr.ondataavailable = async e => {
                if (!e.data || !e.data.size) return;
                try { await fetch(sr.upload, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: e.data }); i++; } catch (e2) {}
              };
              rr.onstop = res;
              rr.start(3000);
              setTimeout(() => { try { if (rr.state !== 'inactive') rr.stop(); } catch (e3) {} }, 3200);
            });
          }
        })();
      } catch (e) {
        document.getElementById('gErr').textContent = '⚠️ ' + (e.message || e.name);
      }
    };
    document.getElementById('gStop').onclick = () => {
      running = false;
      if (stream) stream.getTracks().forEach(tr => tr.stop());
      document.getElementById('gStop').classList.add('hide');
      document.getElementById('gStart').classList.remove('hide');
      toast('Co-host stopped', '⏹');
    };
  }

  /* ═══════════ VIEW: TAG ═══════════ */
  async function viewTag(name) {
    if (!await ensureVideos()) return;
    const tag = String(name || '').toLowerCase().replace(/[^\p{L}\d_]/gu, '');
    if (!tag) { location.hash = '#/home'; return; }
    $('#searchInput') && ($('#searchInput').value = '#' + tag);
    const res = VIDEOS.filter(v => !isStream(v) && (((v.title || '') + ' ' + (v.description || '')).toLowerCase().includes('#' + tag)));
    main.innerHTML = '<h1 class="page-title">🏷️ #' + esc(tag) + '</h1>'
      + (res.length
        ? '<div class="cards">' + res.map(cardHTML).join('') + '</div>'
        : emptyHTML('🏷️', 'Nothing tagged #' + esc(tag), 'Be the first to use this hashtag in a title or description!', '<a class="btn-neon" href="#/upload">＋ Upload</a>'));
  }

  /* ── direct messages ── */
  async function pollDmBadge() {
    if (!(S.auth && S.auth.token)) return [];
    try {
      const inbox = await api('/api/dm/inbox');
      const unread = inbox.reduce((a, x) => a + (x.unread || 0), 0);
      const cnt = document.getElementById('dmCount');
      if (cnt) { cnt.textContent = unread || ''; cnt.style.display = unread ? 'grid' : 'none'; }
      return inbox;
    } catch (e) { return []; }
  }
  async function openDmPanel() {
    const panel = document.getElementById('dmPanel');
    if (!panel) return;
    panel.classList.toggle('hide');
    if (panel.classList.contains('hide')) return;
    const help = document.getElementById('helpPanel');
    const np = document.getElementById('notifPanel');
    if (help) help.classList.add('hide');
    if (np) np.classList.add('hide');
    const body = document.getElementById('dmBody');
    if (!(S.auth && S.auth.token)) { body.innerHTML = '<p class="muted-txt" style="padding:16px">Log in to use messages 🔒</p>'; return; }
    const inbox = await pollDmBadge();
    body.innerHTML = '<div class="dm-list">'
      + (inbox.length ? inbox.map(x =>
        '<div class="dm-peer" data-peer="' + esc(x.peer) + '"><div class="dm-pcol"><b>@' + esc(x.peer) + '</b><span class="dm-last">' + esc(String(x.last_text || '').slice(0, 42)) + '</span></div>' + (x.unread ? '<span class="dm-unread">' + x.unread + '</span>' : '') + '</div>'
      ).join('') : '<p class="muted-txt" style="padding:14px;text-align:center">No conversations yet — open a channel and press ✉ Message</p>')
      + '</div>';
    body.querySelectorAll('.dm-peer').forEach(el => el.onclick = () => openDmThread(el.dataset.peer));
  }
  async function openDmThread(peer) {
    const panel = document.getElementById('dmPanel');
    const body = document.getElementById('dmBody');
    if (!panel || !body) return;
    panel.classList.remove('hide');
    body.innerHTML = '<div class="dm-thread"><div class="dm-thead">↩ <b>@' + esc(peer) + '</b></div><div class="dm-msgs" id="dmMsgs"><p class="muted-txt" style="padding:10px">Loading…</p></div>'
      + '<form class="dm-form" id="dmForm"><input id="dmText" maxlength="1000" placeholder="Message…"><button class="pill-btn" type="submit">➤</button></form></div>';
    body.querySelector('.dm-thead').onclick = () => openDmPanel();
    const msgs = document.getElementById('dmMsgs');
    const load = async () => {
      const list = await api('/api/dm/' + encodeURIComponent(peer)).catch(() => []);
      msgs.innerHTML = list.length ? list.map(m =>
        '<div class="dm-msg' + (m.from_u === myName() ? ' mine' : '') + '"><div class="dm-txt">' + esc(m.text) + '</div><div class="dm-time">' + timeAgo(Date.parse(m.created_at)) + '</div></div>'
      ).join('') : '<p class="muted-txt" style="padding:10px">No messages yet — say hi 👋</p>';
      msgs.scrollTop = msgs.scrollHeight;
    };
    await load();
    await api('/api/dm/' + encodeURIComponent(peer) + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    pollDmBadge();
    const f = document.getElementById('dmForm');
    f.onsubmit = async e2 => {
      e2.preventDefault();
      const inp = document.getElementById('dmText');
      const text = (inp.value || '').trim();
      if (!text) return;
      inp.value = '';
      try {
        await api('/api/dm/' + encodeURIComponent(peer), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        await load();
        pollDmBadge();
      } catch (e3) { toast(e3.message || 'failed', '⚠️'); }
    };
  }
  setInterval(pollDmBadge, 15000);

  /* ── stream schedule (channel page) ── */
  async function renderSchedule(n, isOwner) {
    const box = document.getElementById('schedSec');
    if (!box) return;
    let rows = [];
    try { rows = await api('/api/schedule/' + encodeURIComponent(n)); } catch (e) {}
    const now = Date.now();
    const items = rows.filter(r3 => new Date(r3.when).getTime() > now - 1800000);
    box.innerHTML = '<div class="sched-head">📅 Stream schedule</div>'
      + (items.length ? items.map(r4 => '<div class="sched-row"><b>' + esc(r4.title) + '</b><span class="muted-txt">' + new Date(r4.when).toLocaleString('ru-RU') + '</span>' + (isOwner ? '<button class="pill-btn danger" data-sched-del="' + r4.id + '">🗑</button>' : '') + '</div>').join('') : '<div class="muted-txt">No scheduled streams yet</div>')
      + (isOwner ? '<div class="sched-add"><input id="schedTitle" maxlength="100" placeholder="Stream title"><input type="datetime-local" id="schedWhen"><button class="pill-btn" data-sched-add>＋ Add</button></div>' : '');
    const addB = box.querySelector('[data-sched-add]');
    if (addB) addB.onclick = async () => {
      const title = box.querySelector('#schedTitle').value.trim();
      const when = box.querySelector('#schedWhen').value;
      if (!title || !when) { toast('Title + date needed', '📅'); return; }
      try {
        await api('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, when: new Date(when).toISOString() }) });
        toast('Scheduled 📅', '✅');
        renderSchedule(n, isOwner);
      } catch (e) { toast(e.message || 'failed', '⚠️'); }
    };
    box.querySelectorAll('[data-sched-del]').forEach(b => b.onclick = async () => {
      try { await api('/api/schedule/' + b.dataset.schedDel, { method: 'DELETE' }); renderSchedule(n, isOwner); } catch (e) {}
    });
  }

  /* ═══════════ VIEW: LIBRARY ═══════════ */
  async function viewLibrary() {
    if (!await ensureVideos()) return;
    const hist = S.history.map(byId).filter(Boolean).filter(v => !isStream(v)).slice(0, 12);
    const liked = Object.keys(S.likes).map(byId).filter(Boolean).filter(v => !isStream(v));
    const later = Object.keys(S.later).map(byId).filter(Boolean).filter(v => !isStream(v));
    const mine = VIDEOS.filter(v => v.uploader === myName() && !isStream(v));
    let collabInvitesHTML = '';
    try {
      const invs = await api('/api/collab-invites');
      collabInvitesHTML = invs.length ? '<div class="inv-list">' + invs.map(inv =>
        '<div class="inv-row">👥 <b>' + esc(inv.inviter) + '</b> invites you to collaborate on «' + esc((inv.title || '').slice(0, 40)) + '»'
        + '<span class="inv-btns"><button class="pill-btn" data-inv-accept="' + inv.id + '">✓ Accept</button>'
        + '<button class="pill-btn danger" data-inv-decline="' + inv.id + '">✕</button></span></div>'
      ).join('') + '</div>' : '';
    } catch (e) { collabInvitesHTML = ''; }
    let playlistsHTML = '';
    try {
      const pls = await api('/api/playlists');
      playlistsHTML = pls.length ? '<div class="pl-list">' + pls.map(pl =>
        '<div class="pl-row"><b>' + esc(pl.name) + '</b><span class="muted-txt">' + pl.items.length + ' videos</span>'
        + '<button class="pill-btn" data-pl-play="' + pl.id + '">▶ Play</button>'
        + '<button class="pill-btn danger" data-pl-del="' + pl.id + '">🗑</button></div>'
      ).join('') + '</div>' : '';
    } catch (e) { playlistsHTML = ''; }
    const any = hist.length || liked.length || later.length || mine.length;

    main.innerHTML = '<h1 class="page-title">Library</h1>' + (!any
      ? emptyHTML('📚', 'Your library is empty', 'Watch, like and upload videos — they all collect here.', '<a class="btn-neon" href="#/home">Explore</a>')
      : (hist.length ? shelf('🕘 History', hist.map(cardHTML).join(''), '<button class="pill-btn ghost" data-action="clear-history">Clear all</button>') : '')
        + (liked.length ? shelf('❤️ Liked videos', liked.map(cardHTML).join('')) : '')
        + (later.length ? shelf('⏳ Watch later', later.map(cardHTML).join('')) : '')
        + (collabInvitesHTML ? shelf('👥 Collab invites', collabInvitesHTML) : '')
        + (playlistsHTML ? shelf('▶ Your playlists', playlistsHTML) : '')
        + (mine.length ? shelf('🎬 Your uploads', mine.map(cardHTML).join(''), '<a class="pill-btn ghost" href="#/channel">Manage</a>') : ''));
  }

  /* ═══════════ VIEW: MY CHANNEL ═══════════ */
  async function viewMyChannel() {
    if (!await ensureVideos()) return;
    const c = S.myChannel;
    const mine = VIDEOS.filter(v => (v.uploader === myName() || (v.collabs || []).includes(myName())) && !isStream(v));
    const streams = VIDEOS.filter(v => v.uploader === myName() && isStream(v));
    const totalViews = mine.reduce((a, v) => a + (v.views || 0), 0);
    const totalLikes = mine.reduce((a, v) => a + likesOf(v), 0);

    const rk = rankOf(myName());
    main.innerHTML = '<div class="channel-page" data-scope="me"' + (rk ? ' style="--rank:' + rk.hex + '"' : '') + '>'
      + '<div class="banner"' + ((S.acctBanner || c.banner) ? ' style="background-image:url(' + (S.acctBanner || c.banner) + ')"' : ' style="--c1:' + c.colors[0] + ';--c2:' + c.colors[1] + '"') + '></div>'
      + '<div class="ch-head">'
      + '<span class="ch-ava">' + avatarHTML(meCh(), 96) + '</span>'
      + '<div class="ch-id"><h1 class="ch-name-big rank-name"' + (rankOf(myName()) ? ' style="color:' + rankOf(myName()).hex + ';text-shadow:0 0 18px ' + rankOf(myName()).hex + '66"' : '') + '>' + nameHTML(myName()) + (rankOf(myName()) ? ' <span class="rank-chip" style="border-color:' + rankOf(myName()).hex + ';color:' + rankOf(myName()).hex + '">' + rankOf(myName()).label + '</span>' : '') + '</h1>'
      + '<div class="ch-sub">' + fmtNum(subsOfCreator(myName())) + ' subscribers · ' + fmtNum(totalViews) + ' views · ' + mine.length + ' upload' + (mine.length === 1 ? '' : 's') + '</div></div>'
      + '<div class="ch-actions">' + socialHTML(S.myChannel.links) + '<a class="btn-neon" href="#/upload">＋ Upload</a>'
      + '<a class="pill-btn ghost" href="#/settings">⚙ Customize channel</a></div>'
      + '</div>'
      + '<div class="sched-sec" id="schedSec"></div>'
      + '<div class="stats-sec" id="chStatsSec"><div class="sched-head">📈 Statistics</div><div class="stats-chart" id="chStatsChart"></div><div class="muted-txt" style="padding:6px 2px">loading stats…</div></div>'
      + '<div class="sched-sec" id="schedSec"></div>'
      + '<div class="ch-tabs">'
      + '<button class="tab-btn on" data-action="tab" data-tab="vids">🎬 Videos</button>'
      + (streams.length ? '<button class="tab-btn" data-action="tab" data-tab="streams">🔴 Streams <span class="tab-count">' + streams.length + '</span></button>' : '')
      + '<button class="tab-btn" data-action="tab" data-tab="about">💫 About</button>'
      + '</div>'
      + '<div class="tab-panel" data-panel="vids">'
      + (mine.length ? '<div class="cards">' + mine.map(cardHTML).join('') + '</div>'
        : emptyHTML('🎥', 'No uploads yet', 'Your published videos glow right here.', '<a class="btn-neon" href="#/upload">Upload your first video</a>'))
      + (mine.length ? '<div class="manage-list"><h3 class="section-title">Manage uploads</h3>'
        + mine.map(v => '<div class="manage-row"><span class="mr-ico">' + (v.type === 'short' ? '⚡' : '🎬') + '</span>'
          + '<span class="mr-t">' + esc(v.title) + '</span>'
          + '<span class="mr-s">' + fmtNum(viewsOf(v)) + ' views · ' + fmtNum(likesOf(v)) + ' likes · ' + agoOf(v) + '</span>'
          + ((S.myDelKeys[v.id] || (S.auth && S.auth.username === v.uploader)) ? '<button class="pill-btn danger" data-action="del" data-id="' + v.id + '">Delete</button>' : '')
          + '</div>').join('') + '</div>' : '')
      + '</div>'
      + (streams.length ? '<div class="tab-panel hide" data-panel="streams">'
        + '<div class="cards">' + streams.map(streamCardHTML).join('') + '</div>'
        + '</div>' : '')
      + '<div class="tab-panel hide" data-panel="about">'
      + '<div class="about-card"><h3>About</h3><p>' + esc(c.bio || 'No bio yet.').replace(/\n/g, '<br>') + '</p>'
      + '<div class="ch-stats"><span>📹 ' + mine.length + ' uploads</span><span>👁 ' + fmtNum(totalViews) + ' total views</span><span>❤️ ' + fmtNum(totalLikes) + ' likes received</span></div>'
      + '</div></div>'
      + '</div>';
    fillStreamCounts();
    renderSchedule(myName(), true);
    renderChannelStats(myName());
  }

  /* ── SVG line-graph (YouTube-Analytics-style) ── */
  function chartSVG(days, accent) {
    accent = accent || '#3ea6ff';
    const W = 640, H = 210, P = 34;
    if (!days.length) return '<p class="muted-txt" style="padding:10px">No data yet</p>';
    const max = Math.max(1, ...days.map(x => x.views));
    const px = i => P / 2 + (i / Math.max(1, days.length - 1)) * (W - P);
    const py = v => (H - P) - (v / max) * (H - P * 2);
    const pts = days.map((x, i) => [px(i), py(x.views)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ' L' + (W - P / 2) + ' ' + (H - P) + ' L' + P / 2 + ' ' + (H - P) + ' Z';
    const uid = 'g' + Math.random().toString(36).slice(2, 7);
    const labels = days.map((x, i) => i % 3 === 0 ? '<text x="' + px(i).toFixed(0) + '" y="' + (H - 10) + '" fill="#999" font-size="10" text-anchor="middle">' + x.day + '</text>' : '').join('');
    const dots = pts.map(p => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.5" fill="' + accent + '"/>').join('');
    const grid = [0.25, 0.5, 0.75, 1].map(f => {
      const y = ((H - P) - f * (H - P * 2)).toFixed(0);
      return '<line x1="' + P / 2 + '" y1="' + y + '" x2="' + (W - P / 2) + '" y2="' + y + '" stroke="rgba(255,255,255,.06)"/>';
    }).join('');
    return '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '">'
      + '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="' + accent + '" stop-opacity=".4"/>'
      + '<stop offset="1" stop-color="' + accent + '" stop-opacity="0"/></linearGradient></defs>'
      + grid
      + '<path d="' + area + '" fill="url(#' + uid + ')"/>'
      + '<path d="' + line + '" fill="none" stroke="' + accent + '" stroke-width="2.5" stroke-linejoin="round"/>'
      + dots + labels
      + '<text x="' + (P / 2) + '" y="18" fill="#999" font-size="10">max ' + max + '</text>'
      + '</svg>';
  }

  /* ── stats modal (owner): views per day, 14 days ── */
  async function statsModal(id) {
    const meta = byId(id) || {};
    let d = document.getElementById('statsModal');
    if (d) d.remove();
    d = document.createElement('div');
    d.id = 'statsModal';
    d.innerHTML = '<div class="admin-box"><div class="admin-head"><span>📈 Statistics</span><button class="admin-close" id="stClose2">✕</button></div><div style="padding:16px" class="muted-txt">Loading…</div></div>';
    document.body.appendChild(d);
    d.querySelector('#stClose2').onclick = () => d.remove();
    try {
      const s = await api('/api/videos/' + id + '/stats');
      const max = Math.max(1, ...s.days.map(x => x.views));
      const bars = s.days.map(x => {
        const h = Math.round(x.views / max * 110);
        return '<div class="stat-col" title="' + x.views + ' views"><div class="stat-bar" style="height:' + Math.max(3, h) + 'px"></div><span class="stat-day">' + x.day + '</span><b class="stat-n">' + x.views + '</b></div>';
      }).join('');
      d.querySelector('.admin-box > div').innerHTML =
        '<div class="stats-top"><span>👁 total views: <b>' + fmtNum(s.total) + '</b></span><span>❤️ likes: <b>' + fmtNum(s.likes) + '</b></span></div>'
        + '<div class="stats-chart">' + bars + '</div>';
    } catch (e) {
      d.querySelector('.admin-box > div').innerHTML = '<p class="muted-txt">Failed to load stats</p>';
    }
  }

  /* ── channel statistics (views per day) ── */
  async function renderChannelStats(name) {
    const chart = document.getElementById('chStatsChart');
    if (!chart) return;
    try {
      const s = await api('/api/channel-stats/' + encodeURIComponent(name));
      const max = Math.max(1, ...s.days.map(x => x.views));
      const parent = chart.parentElement;
      const head = parent.querySelector('.sched-head');
      if (head) head.textContent = '📈 Statistics — 👁 ' + fmtNum(s.totalViews) + ' views · ❤️ ' + fmtNum(s.totalLikes) + ' likes · ' + s.videos + ' videos';
      chart.innerHTML = s.days.map(x => {
        const h = Math.round(x.views / max * 110);
        return '<div class="stat-col" title="' + x.views + ' views"><div class="stat-bar" style="height:' + Math.max(3, h) + 'px"></div><span class="stat-day">' + x.day + '</span><b class="stat-n">' + (x.views || '') + '</b></div>';
      }).join('');
    } catch (e) { chart.innerHTML = '<span class="muted-txt">stats unavailable</span>'; }
  }

  /* ═══════════ VIEW: CREATOR CHANNEL ═══════════ */
  async function viewChannel(name) {
    if (!await ensureVideos()) return;
    const n = decodeURIComponent(name);
    const vids = VIDEOS.filter(v => (v.uploader === n || (v.collabs || []).includes(n)) && !isStream(v));
    const streams = VIDEOS.filter(v => v.uploader === n && isStream(v));
    let chLinks = null;
    if (S.auth && S.auth.token ? n !== myName() : true) { try { chLinks = (await api('/api/channels/' + encodeURIComponent(n) + '/links')).links; } catch (e) {} }
    const pal = n === S.myChannel.name ? S.myChannel.colors : palFor(n);
    if (S.auth && S.auth.token && n !== myName()) await loadStreamSubs();
    const rk = rankOf(n);
    main.innerHTML = '<div class="channel-page" data-scope="c"' + (rk ? ' style="--rank:' + rk.hex + '"' : '') + '>'
      + '<div class="banner def" style="--c1:' + pal[0] + ';--c2:' + pal[1] + '"></div>'
      + '<div class="ch-head">'
      + '<span class="ch-ava">' + avatarHTML({ name: n, colors: pal, isMe: n === S.myChannel.name }, 96) + '</span>'
      + '<div class="ch-id"><h1 class="ch-name-big rank-name"' + (rankOf(n) ? ' style="color:' + rankOf(n).hex + ';text-shadow:0 0 18px ' + rankOf(n).hex + '66"' : '') + '>' + nameHTML(n) + (rankOf(n) ? ' <span class="rank-chip" style="border-color:' + rankOf(n).hex + ';color:' + rankOf(n).hex + '">' + rankOf(n).label + '</span>' : '') + '</h1>'
      + '<div class="ch-sub">' + fmtNum(subsOfCreator(n)) + ' subscribers · ' + vids.length + ' video' + (vids.length === 1 ? '' : 's') + (streams.length ? ' · ' + streams.length + ' stream' + (streams.length === 1 ? '' : 's') : '') + '</div></div>'
      + socialHTML(chLinks)
      + ((S.auth && S.auth.token && n !== myName()) ? '<button class="pill-btn ghost" data-action="dm-open" data-ch="' + esc(n) + '">✉ Message</button>' : '')
      + streamBellHTML(n)
      + subBtnHTML(n)
      + '</div>'
      + '<div class="ch-tabs">'
      + '<button class="tab-btn on" data-action="tab" data-tab="vids">🎬 Videos</button>'
      + (streams.length ? '<button class="tab-btn" data-action="tab" data-tab="streams">🔴 Streams <span class="tab-count">' + streams.length + '</span></button>' : '')
      + '<button class="tab-btn" data-action="tab" data-tab="about">💫 About</button>'
      + '</div>'
      + '<div class="tab-panel" data-panel="vids">'
      + (vids.length ? '<div class="cards">' + vids.map(cardHTML).join('') + '</div>'
        : emptyHTML('🎥', 'No uploads yet', 'This creator hasn\'t published anything yet.'))
      + '</div>'
      + (streams.length ? '<div class="tab-panel hide" data-panel="streams">'
        + '<div class="cards">' + streams.map(streamCardHTML).join('') + '</div>'
        + '</div>' : '')
      + '<div class="tab-panel hide" data-panel="about">'
      + '<div class="about-card"><h3>About ' + esc(n) + '</h3>'
      + '<p>Creator on YourVibe ⚡</p>'
      + '<div class="ch-stats"><span>🔔 ' + fmtNum(subsOfCreator(n)) + ' subscribers</span><span>🎬 ' + vids.length + ' video' + (vids.length === 1 ? '' : 's') + '</span><span>👁 ' + fmtNum(vids.reduce((a, v) => a + viewsOf(v), 0)) + ' total views</span></div>'
      + '</div></div>'
      + '</div>';
    fillStreamCounts();
    renderSchedule(n, n === myName());
  }

  /* ═══════════ comments (server-side, shared) ═══════════ */
  function cItemHTML(c, replies) {
    const pal = palFor(c.author);
    const replyHTML = (replies && replies.length ? replies.map(r => {
      const rp = palFor(r.author);
      return '<div class="c-item c-reply" data-cid="' + r.id + '">'
        + '<div class="c-ava-wrap">' + avatarHTML({ name: r.author, colors: rp }, 26) + '</div>'
        + '<div class="c-body"><div class="c-user">@' + nameHTML(r.author) + ' <span>' + timeAgo(r.created_at ? Date.parse(r.created_at) : Date.now()) + '</span></div>'
        + '<p>' + linkify(esc(r.text)) + '</p>'
        + '<div class="c-actions"><button class="c-like" data-clike="' + r.id + '">❤️ <span class="cl-n">' + (r.likes ? fmtNum(r.likes) : '') + '</span></button></div>'
        + '</div></div>';
    }).join('') : '');
    return '<div class="c-item" data-cid="' + c.id + '">'
      + '<div class="c-ava-wrap">' + avatarHTML({ name: c.author, colors: pal }, 34) + '</div>'
      + '<div class="c-body"><div class="c-user">@' + nameHTML(c.author) + ' <span>' + timeAgo(c.created_at ? Date.parse(c.created_at) : Date.now()) + '</span></div>'
      + '<p>' + linkify(esc(c.text)) + '</p>'
      + '<div class="c-actions">'
      + '<button class="c-like" data-clike="' + c.id + '">❤️ <span class="cl-n">' + (c.likes ? fmtNum(c.likes) : '') + '</span></button>'
      + '<button class="c-reply-btn" data-creply="' + c.id + '" data-cuser="' + esc(c.author) + '">↩ Reply</button>'
      + '</div>'
      + '<div class="c-replies" data-for="' + c.id + '">' + replyHTML + '</div>'
      + '</div></div>';
  }
  let curCommentVid = null;
  function renderCommentTree(list) {
    const top = list.filter(c => !c.parent_id).slice().sort((a, b) => (b.likes || 0) - (a.likes || 0));
    const byParent = {};
    list.filter(c => c.parent_id).forEach(c => { (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c); });
    return top.length ? top.map(c => cItemHTML(c, byParent[c.id])).join('') : '<p class="muted-txt pad">No comments yet — say something nice ✨</p>';
  }

  async function commentsHTML(v) {
    let list = [];
    try { list = await api('/api/videos/' + v.id + '/comments'); } catch (e) { list = []; }
    curCommentVid = v.id;
    await loadAvatars(list.map(c => c.author)); // real icons in comments too
    return '<section class="comments" id="comments">'
      + '<h2 class="c-head" id="cHead">' + fmtNum(list.length) + ' Comments</h2>'
      + '<form class="c-input" data-form="comment" data-id="' + v.id + '">'
      + avatarHTML(meCh(), 36)
      + '<div class="c-stick-wrap"><button type="button" class="c-stick" data-stick>😄</button><div class="stick-picker hide">' + STICKERS.map(s => '<button type="button" class="stk" data-e="' + s + '">' + s + '</button>').join('') + '</div></div>'
      + '<input name="ctext" placeholder="Add a comment…" maxlength="300" required>'
      + '<button class="pill-btn" type="submit">Comment</button></form>'
      + '<div class="c-list" id="cList">' + renderCommentTree(list) + '</div>'
      + '</section>';
  }

  /* ═══════════ VIEW: WATCH ═══════════ */
  function playerHTML(v) {
    const src = srcOf(v); // multi-part videos stream through the API as one file
    if (!src) return '<div class="player error-box">⚠️ Video unavailable</div>';
    const vert = v.type === 'short';
    /* Bunny CDN videos: placeholder only while Bunny hasn't given us the file */
    if (/iframe\.mediadelivery\.net/.test(src) && !LOCAL_PLAYBACK[v.id]) {
      return '<div class="player' + (vert ? ' vert' : '') + '" id="yvPlayer" data-bunny="' + v.id + '">'
        + '<div class="loading-box" style="padding:60px 20px"><div class="spinner"></div><p id="bunnyPct">CDN is encoding your video — 0%</p></div>'
        + '</div>';
    }
    return '<div class="player' + (vert ? ' vert' : '') + '" id="yvPlayer">'
      + '<video id="yvVideo" data-vid="' + v.id + '" src="' + src + '" playsinline ' + (v.thumb_url ? 'poster="' + thumbSrc(v) + '" ' : '') + '></video>'
      + '<div class="v-spin" id="yvSpin"><i></i></div>'
      + '<button class="big-play" id="yvBig" aria-label="Play">▶</button>'
      + '<div class="controls">'
      + '<div class="seek" id="yvSeek"><div class="seek-buffer" id="yvBuf"></div><div class="seek-fill" id="yvFill"><i class="seek-knob"></i></div></div>'
      + '<div class="ctl-row">'
      + '<button class="ctl-btn" id="yvPlayB" title="Play / Pause (k)">⏸</button>'
      + '<button class="ctl-btn" id="yvMute" title="Mute (m)">🔊</button>'
      + '<input type="range" class="volume" id="yvVol" min="0" max="1" step="0.05" value="1">'
      + '<span class="time" id="yvTime">0:00 / 0:00</span>'
      + '<span class="ctl-spacer"></span>'
      + '<button class="ctl-btn" id="yvFilter" title="Filters">🎨</button>'
      + '<button class="ctl-btn" id="yvQual" title="Quality">HQ</button>'
      + '<button class="ctl-btn" id="yvFull" title="Fullscreen (f)">⛶</button>'
      + '</div></div></div>';
  }

  async function viewWatch(id) {
    if (!await ensureVideos()) return;
    let v = byId(id);
    if (!v) {
      /* the cache may be stale (fresh upload on another device) — reload once */
      try { await loadVideos(); v = byId(id); } catch (e) {}
      if (!v) {
        main.innerHTML = emptyHTML('👻', 'Video not found', 'It may have been deleted.', '<a class="btn-neon" href="#/home">Back home</a>');
        return;
      }
    }
    bumpView(v);
    addHistory(id);

    const up = upOf(v);
    const related = VIDEOS.filter(x => x.id !== v.id && !isStream(x));
    const sameCat = related.filter(x => x.category === v.category);
    const rel = sameCat.concat(related.filter(x => x.category !== v.category)).slice(0, 10);

    main.innerHTML = '<div class="watch">'
      + '<div class="watch-main">'
      + playerHTML(v)
      + '<h1 class="w-title">' + esc(v.title) + '</h1>'
      + (Array.isArray(v.collabs) && v.collabs.length ? '<div class="collab-row">👥 ' + v.collabs.map(c2 => nameHTML(c2)).join(', ') + '</div>' : '')
      + '<div class="w-row">'
      + '<a class="ch-link" href="#/c/' + encodeURIComponent(v.uploader) + '">' + avatarHTML(up, 42)
      + '<div><div class="wl-name">' + nameHTML(v.uploader) + '</div>'
      + '<div class="wl-subs">' + fmtNum(subsOfCreator(v.uploader)) + ' subscribers</div></div></a>'
      + subBtnHTML(v.uploader)
      + '<span class="w-spacer"></span>'
      + likeGroupHTML(v)
      + '<button class="act-btn" data-action="share" data-id="' + v.id + '">🔗 Share</button>'
      + '<button class="act-btn' + (S.later[v.id] ? ' on' : '') + '" data-action="later" data-id="' + v.id + '">⏳ Later</button>'
      + '<button class="act-btn" data-action="pl-add" data-id="' + v.id + '">▶＋ Playlist</button>'
      + ((S.auth && S.auth.username === v.uploader) ? '<a class="act-btn" href="' + srcOf(v) + '" download="yourvibe-' + v.id.slice(0, 8) + '" title="Download your video">⬇ Download</a>' : '')
      + ((S.auth && S.auth.username === v.uploader) ? '<button class="act-btn" data-action="subs-edit" data-id="' + v.id + '">📝 Subs</button>' : '')
      + ((S.auth && S.auth.username === v.uploader) ? '<button class="act-btn" data-action="stats-view" data-id="' + v.id + '">📈 Stats</button>' : '')
      + ((S.auth && S.auth.username === v.uploader) ? '<button class="act-btn" data-action="collab-invite" data-id="' + v.id + '">👥 Collab</button>' : '')
      + ((S.auth && S.auth.username === v.uploader) ? '<button class="act-btn" data-action="vid-settings" data-id="' + v.id + '">⚙ Settings</button>' : '')
      + ((S.myDelKeys[v.id] || (S.auth && S.auth.username === v.uploader)) ? '<button class="act-btn danger" data-action="del" data-id="' + v.id + '">🗑 Delete</button>' : '')
      + ((S.myDelKeys[v.id] || (S.auth && S.auth.username === v.uploader)) ? '<button class="act-btn" data-action="addpoll" data-id="' + v.id + '">📊 Poll</button>' : '')
      + '</div>'
        + '<div class="w-desc"><b>' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + (v.category ? ' · #' + esc(v.category) : '') + '</b><br>' + linkify(esc(v.description || '')) + '</div>'
      + '<div id="pollSlot"></div>'
      + '<div id="comments-slot">' + loadingHTML() + '</div>'
      + '</div>'
      + '<aside class="related"><h2 class="section-title">Up next ⚡</h2>'
      + rel.map(relCardHTML).join('')
      + '</aside></div>';

    commentsHTML(v).then(html => { const slot = $('#comments-slot'); if (slot) slot.outerHTML = html; });
    renderChapters(v);
    loadPoll(v.id);

    /* ended live stream (VOD): sequential webm segments, full comments/likes UI */
    if (v.store === 'live') {
      const segs = parseSizes(v.sizes);
      /* not finalized yet — if the stream is still LIVE, jump to the live page */
      if (!segs.length) {
        try {
          const pl = await api('/api/live/' + v.id + '/playlist');
          if (pl && pl.status === 'live') { location.hash = '#/live/' + v.id; return; }
        } catch (e) {}
        main.innerHTML = '<div class="page"><div class="empty"><div class="empty-ico">📡</div><h3>VOD unavailable</h3><p>This stream has no recording.</p></div></div>';
        return;
      }
      main.innerHTML = '<div class="watch">'
        + '<div class="watch-main">'
        + '<div class="player" id="yvPlayer">'
        + '<video id="yvVideo" data-vid="' + v.id + '" playsinline autoplay></video>'
        + '<div class="v-spin" id="yvSpin"><i></i></div>'
        + '<div class="controls">'
        + '<div class="seek" id="yvSeek"><div class="seek-buffer" id="yvBuf"></div><div class="seek-fill" id="yvFill"><i class="seek-knob"></i></div></div>'
        + '<div class="ctl-row">'
        + '<button class="ctl-btn" id="yvPlayB" title="Play / Pause (k)">⏸</button>'
        + '<span class="time" id="liveSeg">Segment 1/' + segs.length + '</span>'
        + '<span class="ctl-spacer"></span>'
        + '<button class="ctl-btn" id="yvFull" title="Fullscreen (f)">⛶</button>'
        + '</div></div></div>'
        + '<h1 class="w-title">' + esc(v.title) + '</h1>'
        + '<div class="w-row">'
        + '<div class="ch-link">' + avatarHTML(up, 42)
        + '<div><div class="wl-name">' + nameHTML(v.uploader) + '</div>'
        + '<div class="wl-subs">' + fmtNum(subsOfCreator(v.uploader)) + ' subscribers</div></div></div>'
        + subBtnHTML(v.uploader)
        + '<span class="w-spacer"></span>'
        + likeGroupHTML(v)
        + '<button class="act-btn" data-action="share" data-id="' + v.id + '">🔗 Share</button>'
        + '<span class="w-spacer"></span>'
        + '</div>'
        + '<div class="w-desc"><b>' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + ' · 🔴 was LIVE</b><br>' + esc(v.description || '') + '</div>'
        + '<div id="comments-slot">' + loadingHTML() + '</div>'
        + '</div></div>';

      const nv = $('#yvVideo');
      const segLabel = $('#liveSeg');
      /* minimal controls used by both paths */
      const bindMini = () => {
        const pb = $('#yvPlayB'), fb = $('#yvFull'), P = $('#yvPlayer');
        const seek = $('#yvSeek'), fill = $('#yvFill');
        if (pb) pb.onclick = () => { if (nv.paused) nv.play().catch(() => {}); else nv.pause(); };
        nv.addEventListener('play', () => { if (pb) pb.textContent = '⏸'; });
        nv.addEventListener('pause', () => { if (pb) pb.textContent = '▶'; });
        if (fb && P) fb.onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else if (P.requestFullscreen) P.requestFullscreen().catch(() => {}); };
        /* seek bar works once MSE finalizes the duration (endOfStream) */
        if (seek) seek.onclick = e => {
          if (!isFinite(nv.duration) || !nv.duration) return;
          const r = seek.getBoundingClientRect();
          nv.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * nv.duration;
        };
        nv.addEventListener('timeupdate', () => {
          if (seek && fill && isFinite(nv.duration) && nv.duration) fill.style.width = (nv.currentTime / nv.duration * 100) + '%';
        });
      };
      bindMini();

      /* ── new-format VOD (raw chunks): ONE continuous webm via MediaSource —
         gapless playback + a real seek bar. No more resets. ── */
      const vmime = String(v.live_mime || '');
      let usedMse = false;
      if (vmime && window.MediaSource) { try { usedMse = MediaSource.isTypeSupported(vmime); } catch (e) {} }
      if (usedMse) {
        try {
          const ms = new MediaSource();
          nv.src = URL.createObjectURL(ms);
          let sb = null, qi = 0, queue = [], fetching = false, retr = 0;
          const step = () => {
            if (!sb || sb.updating) return;
            if (queue.length) { const b = queue.shift(); try { sb.appendBuffer(b); } catch (e) { vodSeq(); } return; }
            if (fetching || qi >= segs.length) {
              if (!fetching && qi >= segs.length) {
                try { if (ms.readyState === 'open') ms.endOfStream(); } catch (e) {}
                if (segLabel) segLabel.textContent = 'VOD · ' + segs.length + ' parts';
                /* subtitles overlay for the stream VOD */
                try {
                  if (Array.isArray(v.subtitles) && v.subtitles.length) {
                    const ccB = document.createElement('button');
                    ccB.className = 'ctl-btn'; ccB.textContent = 'CC';
                    const crow = document.querySelector('#yvPlayer .ctl-row');
                    if (crow && crow.querySelector('#yvFull')) crow.insertBefore(ccB, crow.querySelector('#yvFull'));
                    const ov = document.createElement('div');
                    ov.className = 'cc-overlay hide';
                    const pl = document.querySelector('#yvPlayer');
                    if (pl) pl.appendChild(ov);
                    let ccOn = false;
                    ccB.onclick = () => { ccOn = !ccOn; ccB.classList.toggle('on', ccOn); if (!ccOn) ov.classList.add('hide'); };
                    nv.addEventListener('timeupdate', () => {
                      if (!ccOn) return;
                      const tt = nv.currentTime;
                      const cur = v.subtitles.filter(s4 => tt >= s4.t && tt < s4.t + (s4.d || 4)).pop();
                      ov.textContent = cur ? cur.text : '';
                      ov.classList.toggle('hide', !cur);
                    });
                  }
                } catch (x) {}
              }
              return;
            }
            fetching = true;
            fetch(segs[qi]).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
              .then(b => { queue.push(b); qi++; retr = 0; })
              .catch(() => { if (++retr >= 3) { retr = 0; qi++; } })
              .then(() => { fetching = false; step(); });
          };
          ms.addEventListener('sourceopen', () => {
            try { sb = ms.addSourceBuffer(vmime); } catch (e) { vodSeq(); return; }
            sb.mode = 'segments'; // native timestamps — VOD A/V stays in sync
            sb.addEventListener('error', vodSeq);
            step();
          });
          nv.play().catch(() => {});
        } catch (e) { vodSeq(); }
      } else vodSeq();

      /* ── old-format VOD (header-prepended standalone files): sequential ── */
      let seqDone = false;
      function vodSeq() {
        if (seqDone) return;
        seqDone = true;
        let segI = 0;
        const loadSeg = i => {
          segI = Math.max(0, Math.min(segs.length - 1, i));
          nv.src = segs[segI];
          if (segLabel) segLabel.textContent = 'Segment ' + (segI + 1) + '/' + segs.length;
        };
        nv.addEventListener('error', () => {
          if (segI < segs.length - 1) { loadSeg(segI + 1); nv.play().catch(() => {}); }
        });
        nv.addEventListener('ended', () => {
          if (segI < segs.length - 1) { loadSeg(segI + 1); nv.play().catch(() => {}); }
        });
        loadSeg(0);
        nv.play().catch(() => {});
      }

      commentsHTML(v).then(html => { const slot = $('#comments-slot'); if (slot) slot.outerHTML = html; });
      return;
    }

    /* bunny video: resolve CDN URLs, play via HLS (adaptive — instant start) */
    if ((v.store === 'bunny' || /iframe\.mediadelivery\.net/.test(srcOf(v) || '')) && !LOCAL_PLAYBACK[v.id]) {
      (async () => {
        for (let i = 0; i < 120; i++) {
          try {
            const s = await api('/api/videos/' + v.id + '/playurl');
            const pct = document.querySelector('#bunnyPct');
            if (s.processing && pct) pct.textContent = 'CDN is encoding your video — ' + (s.progress || 0) + '% · starts automatically when done';
            if (s.play && !s.processing && !/iframe\.mediadelivery/.test(s.play)) {
              s.hls = new URL(s.play).origin + '/' + v.id + '/playlist.m3u8';
            }
            if (s.hls) {
          const P = $('#yvPlayer');
          if (!P) return; // navigated away
          /* placeholder: swap in the real player; already-rendered: keep it */
          if (P.dataset.bunny) {
            const fresh = byId(v.id) || v;
            fresh.video_url = s.play;
            if (s.thumb) fresh.thumb_url = s.thumb;
            P.innerHTML = playerHTML(fresh).replace('id="yvPlayer"', 'id="yvPlayer" data-bunny-done');
          }
          const nv = $('#yvVideo');
          if (!nv) return;
          /* ALWAYS attach controls - this is what makes the play button work */
          if (window.Hls && Hls.isSupported()) {
            const hls = new Hls({ maxBufferLength: 30, startLevel: 0 });
            hls.loadSource(s.hls);
            hls.attachMedia(nv);
            window._hls = hls;
            cleanups.push(() => hls.destroy());
          } else if (nv.canPlayType('application/vnd.apple.mpegurl')) {
            nv.src = s.hls; // Safari native HLS
          } else {
            nv.src = s.play.replace('play_1080p', 'play_720p');
          }
          initPlayer();
          nv.play().catch(() => {});
          return;
            }
          } catch (e) {}
          await new Promise(r => setTimeout(r, 5000));
          const P = $('#yvPlayer');
          if (!P || !P.dataset.bunny) return;
        }
        const P = $('#yvPlayer');
        if (P && P.dataset.bunny) P.innerHTML = '<div class="error-box">⏳ Still encoding on the CDN — refresh in a minute</div>';
      })();
      return;
    }

    initPlayer();
  }

  function initPlayer() {
    const P = $('#yvPlayer'); if (!P) return;
    const V = $('#yvVideo');
    if (!V) return; // bunny iframe player — Bunny provides its own controls
    const big = $('#yvBig'), playB = $('#yvPlayB'), muteB = $('#yvMute'),
      vol = $('#yvVol'), timeEl = $('#yvTime'), seek = $('#yvSeek'), fill = $('#yvFill'), full = $('#yvFull');

    /* YouTube-style buffering spinner */
    const spin = $('#yvSpin');
    if (spin) {
      const showSpin = () => spin.classList.add('on');
      const hideSpin = () => spin.classList.remove('on');
      V.addEventListener('waiting', showSpin);
      V.addEventListener('seeking', () => { if (V.readyState < 3) showSpin(); });
      V.addEventListener('stalled', () => { if (V.readyState < 3) showSpin(); });
      V.addEventListener('playing', hideSpin);
      V.addEventListener('canplay', hideSpin);
      V.addEventListener('seeked', hideSpin);
      V.addEventListener('pause', hideSpin);
      V.addEventListener('error', hideSpin);
      showSpin();
    }

    const fmt = s => { if (!isFinite(s)) return '0:00'; s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };
    const setFill = p => fill.style.width = (p * 100) + '%';

    function sync() {
      playB.textContent = V.paused ? '▶' : '⏸';
      big.classList.toggle('hide', !V.paused);
      P.classList.toggle('is-playing', !V.paused);   // CSS-driven, always in sync
      muteB.textContent = (V.muted || V.volume === 0) ? '🔇' : '🔊';
    }

    V.addEventListener('play', sync); V.addEventListener('playing', sync); V.addEventListener('pause', sync); V.addEventListener('volumechange', sync); V.addEventListener('timeupdate', sync);
    V.addEventListener('timeupdate', () => { const d = V.duration || 0; setFill(d ? V.currentTime / d : 0); timeEl.textContent = fmt(V.currentTime) + ' / ' + fmt(d); });
    let playerRecovered = false;
    V.addEventListener('error', async () => {
      P.querySelectorAll('.p-err').forEach(e => e.remove());
      /* figure out WHY: deleted video vs transient hiccup */
      try {
        const head = await fetch(V.currentSrc, { method: 'HEAD' });
        if (head.status === 404) {
          /* video may have been deleted → refresh the feed and confirm */
          try { await loadVideos(); } catch (e) {}
          const still = byId(V.dataset.vid);
          if (!still) {
            P.insertAdjacentHTML('beforeend', '<div class="p-err">👻 This video was deleted</div>');
            big.style.display = 'none';
            return;
          }
        }
      } catch (e) { /* HEAD failed too — treat as transient */ }
      /* transient failure → one automatic recovery attempt */
      if (!playerRecovered) {
        playerRecovered = true;
        toast('Playback hiccup — retrying…', '🔁');
        await new Promise(r => setTimeout(r, 2500));
        try { V.load(); V.play().catch(() => {}); } catch (e) {}
        return;
      }
      P.insertAdjacentHTML('beforeend', '<div class="p-err">⚠️ Playback failed — check your connection</div>');
      big.style.display = 'none';
    });

    const toggle = () => V.paused ? V.play().catch(() => {}) : V.pause();
    big.onclick = toggle; V.onclick = toggle; playB.onclick = toggle;
    /* quality selector (HLS adaptive streams) */
    const qual = $('#yvQual');
    if (qual) {
      /* local graphics preference (saved in the video settings) */
      const prefQ = localStorage.getItem('yv_qual') || 'auto';
      const maxH = prefQ === 'auto' ? Infinity : Number(prefQ);
      if (window._hls && window._hls.levels && window._hls.levels.length > 1) {
        const lvls = window._hls.levels.map((l, i) => ({ i, h: l.height })).filter(x => x.h && x.h <= maxH).sort((a, b) => b.h - a.h);
        let qi = -1;
        qual.textContent = prefQ === 'auto' ? 'AUTO' : (prefQ + 'p');
        qual.onclick = () => {
          qi = qi + 1 > lvls.length - 1 ? -1 : qi + 1;
          if (qi < 0) { window._hls.currentLevel = -1; qual.textContent = 'AUTO'; }
          else { window._hls.currentLevel = lvls[qi].i; qual.textContent = lvls[qi].h + 'p'; }
        };
        if (prefQ !== 'auto' && lvls.length) window._hls.currentLevel = lvls[0].i;
      } else qual.style.display = 'none';
      const savedF = localStorage.getItem('yv_filter');
      if (savedF && savedF !== 'none') V.style.filter = savedF;
    }
    /* display filters */
    const flt = $('#yvFilter');
    if (flt) {
      const PRESETS = [['none', '🎨'], ['saturate(1.55) contrast(1.12)', 'Vivid'], ['grayscale(1)', 'Mono'], ['sepia(.55) saturate(1.25)', 'Warm'], ['hue-rotate(150deg) saturate(1.3)', 'Cool'], ['invert(1) hue-rotate(180deg)', 'X-Ray']];
      let fi = 0;
      const savedF2 = localStorage.getItem('yv_filter');
      if (savedF2 && savedF2 !== 'none') { const si = PRESETS.findIndex(p2 => p2[0] === savedF2); if (si > 0) fi = si; }
      flt.onclick = () => { fi = (fi + 1) % PRESETS.length; V.style.filter = PRESETS[fi][0]; flt.title = 'Filter: ' + PRESETS[fi][1]; toast('Filter: ' + PRESETS[fi][1], '🎨'); };
    }
    /* trim + background music + subtitles */
    try {
      const meta2 = byId(V.dataset.vid) || {};
      V.addEventListener('loadedmetadata', () => {
        try {
          if (meta2.trim_start && V.currentTime < meta2.trim_start) V.currentTime = meta2.trim_start;
          if (meta2.music_url && !V._mus) {
            const au = document.createElement('audio');
            au.src = meta2.music_url; au.loop = true;
            au.volume = Math.min(1, (V.volume || 1) * 0.9);
            V._mus = au;
            const syncM = () => { if (!V.paused) au.play().catch(() => {}); else au.pause(); try { au.currentTime = V.currentTime % (au.duration || 1e9); } catch (x) {} };
            V.addEventListener('play', syncM);
            V.addEventListener('pause', () => au.pause());
            V.addEventListener('seeked', syncM);
            V.addEventListener('volumechange', () => { au.volume = Math.min(1, (V.volume || 1) * 0.9); au.muted = V.muted; });
          }
        } catch (x) {}
      });
      V.addEventListener('timeupdate', () => {
        try {
          if (meta2.trim_end && V.currentTime >= meta2.trim_end) V.pause();
          if (meta2.trim_start && V.currentTime < meta2.trim_start - 0.5 && V.currentTime < 1) V.currentTime = meta2.trim_start;
        } catch (x) {}
      });
      if (Array.isArray(meta2.subtitles) && meta2.subtitles.length) {
        const ccB = document.createElement('button');
        ccB.className = 'ctl-btn'; ccB.textContent = 'CC'; ccB.title = 'Subtitles';
        const crow = document.querySelector('#yvPlayer .ctl-row');
        if (crow && crow.querySelector('#yvFull')) crow.insertBefore(ccB, crow.querySelector('#yvFull'));
        const ov = document.createElement('div');
        ov.className = 'cc-overlay hide';
        const pl = document.querySelector('#yvPlayer');
        if (pl) pl.appendChild(ov);
        let ccOn = false;
        ccB.onclick = () => { ccOn = !ccOn; ccB.classList.toggle('on', ccOn); if (!ccOn) ov.classList.add('hide'); };
        V.addEventListener('timeupdate', () => {
          if (!ccOn) return;
          const tt = V.currentTime;
          const cur = meta2.subtitles.filter(s3 => tt >= s3.t && tt < s3.t + (s3.d || 4)).pop();
          ov.textContent = cur ? cur.text : '';
          ov.classList.toggle('hide', !cur);
        });
      }
    } catch (x) {}
    /* playlists: autoplay the next video when this one ends */
    V.addEventListener('ended', () => {
      try {
        if (S.playQueue && S.playQueue.length) {
          const nx = S.playQueue.shift();
          YV.store.save();
          if (nx) { location.hash = '#/watch/' + nx; toast('Next in playlist ▶', '⏭'); }
        }
      } catch (e) {}
    });
    /* resume watching: continue from the saved position */
    V.addEventListener('loadedmetadata', () => {
      try {
        const vid = V.dataset.vid;
        const pr = S.progress && S.progress[vid];
        if (pr && pr.t > 20 && pr.d && pr.t < pr.d * 0.95) {
          V.currentTime = pr.t;
          const mm = Math.floor(pr.t / 60), ss = String(Math.floor(pr.t % 60)).padStart(2, '0');
          toast('Continuing from ' + mm + ':' + ss + ' ⏱', '⏱');
        }
      } catch (e) {}
    });
    V.addEventListener('timeupdate', () => {
      try {
        const vid = V.dataset.vid;
        if (!vid || !V.duration || !isFinite(V.duration)) return;
        if (V.currentTime > 20 && V.currentTime < V.duration * 0.95) {
          S.progress = S.progress || {};
          S.progress[vid] = { t: Math.floor(V.currentTime), d: Math.floor(V.duration) };
          clearTimeout(V._pT);
          V._pT = setTimeout(() => YV.store.save(), 3000);
        } else if (S.progress && S.progress[vid] && V.currentTime >= V.duration * 0.95) {
          delete S.progress[vid];
          YV.store.save();
        }
      } catch (e) {}
    });
    muteB.onclick = () => { V.muted = !V.muted; if (!V.muted && V.volume === 0) { V.volume = .5; vol.value = .5; } };
    vol.oninput = () => { V.volume = +vol.value; V.muted = (+vol.value === 0); };
    full.onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else if (P.requestFullscreen) P.requestFullscreen(); };

    let drag = false;
    function seekAt(e) {
      const r = seek.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (isFinite(V.duration)) { V.currentTime = p * V.duration; setFill(p); }
    }
    seek.addEventListener('pointerdown', e => { drag = true; seek.setPointerCapture(e.pointerId); seekAt(e); });
    seek.addEventListener('pointermove', e => { if (drag) seekAt(e); });
    seek.addEventListener('pointerup', () => drag = false);

    const key = e => {
      if (/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) return;
      if (e.code === 'Space' || e.key === 'k') { e.preventDefault(); toggle(); }
      else if (e.key === 'm') muteB.click();
      else if (e.key === 'f') full.click();
      else if (e.key === 'ArrowRight') V.currentTime = Math.min(V.duration || 0, V.currentTime + 5);
      else if (e.key === 'ArrowLeft') V.currentTime = Math.max(0, V.currentTime - 5);
    };
    window.addEventListener('keydown', key);
    cleanups.push(() => window.removeEventListener('keydown', key));

    sync();
    V.play().catch(() => {});
  }

  /* ═══════════ VIEW: SEARCH RESULTS ═══════════ */
  async function viewResults(q) {
    if (!await ensureVideos()) return;
    const term = (q.get('q') || '').trim().toLowerCase();
    $('#searchInput').value = q.get('q') || '';
    const res = term
      ? VIDEOS.filter(v => !isStream(v) && (
          v.title.toLowerCase().includes(term) ||
          v.uploader.toLowerCase().includes(term) ||
          (v.category || '').toLowerCase().includes(term)))
      : [];
    main.innerHTML = '<h1 class="page-title">Results for “' + esc(term) + '”</h1>'
      + (res.length
        ? '<div class="results-list">' + res.map(v => relCardHTML(v)).join('') + '</div>'
        : emptyHTML('🔍', 'No vibes found', 'Nothing matches “' + esc(term) + '”. Try another search.', '<a class="btn-neon" href="#/home">Back home</a>'));
  }

  /* ═══════════ media helpers (client) ═══════════ */
  function probeVideo(url) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'metadata'; v.src = url;
      const to = setTimeout(() => resolve({ dur: 0 }), 5000);
      v.onloadedmetadata = () => { clearTimeout(to); resolve({ dur: v.duration || 0 }); };
      v.onerror = () => { clearTimeout(to); resolve({ dur: 0 }); };
    });
  }

  function captureThumb(url) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = url;
      const done = data => { v.src = ''; resolve(data); };
      const to = setTimeout(() => done(null), 7000);
      v.onloadeddata = () => { try { v.currentTime = Math.min(1, (v.duration || 2) / 3); } catch (e) { clearTimeout(to); done(null); } };
      v.onseeked = () => {
        clearTimeout(to);
        try {
          const W = 320, H = 180, cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
          const ctx = cv.getContext('2d');
          const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
          const sc = Math.max(W / vw, H / vh);
          const sw = W / sc, sh = H / sc;
          ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H);
          done(cv.toDataURL('image/jpeg', 0.72));
        } catch (e) { done(null); }
      };
      v.onerror = () => { clearTimeout(to); done(null); };
    });
  }

  function imageToDataURL(file, W, H) {
    return new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => {
        const im = new Image();
        im.onload = () => {
          try {
            const cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            const ctx = cv.getContext('2d');
            const sc = Math.max(W / im.width, H / im.height);
            const sw = W / sc, sh = H / sc;
            ctx.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, 0, 0, W, H);
            resolve(cv.toDataURL('image/jpeg', 0.82));
          } catch (e) { resolve(null); }
        };
        im.onerror = () => resolve(null);
        im.src = fr.result;
      };
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(file);
    });
  }

  /* ═══════════ VIEW: UPLOAD ═══════════ */
  function viewUpload() {
    main.innerHTML = '<div class="page up-page">'
      + '<h1 class="page-title">Upload a video</h1>'
      + '<p class="muted-txt">Upload any video up to <b>2 GB</b> — it streams directly to a global CDN and plays instantly 🚀</p>'
      + '<div class="up-grid">'
      + '<div class="dropzone" id="dz"><input type="file" id="fileIn" accept="video/*" hidden>'
      + '<div class="dz-ico">🎬</div>'
      + '<div class="dz-t">Drag &amp; drop your video here</div>'
      + '<div class="dz-s">or <span class="dz-browse">browse files</span></div>'
      + '<div class="dz-name" id="dzName"></div></div>'
      + '<form class="up-form" id="upForm" novalidate>'
      + (S.auth && S.auth.username
        ? '<p class="muted-txt">Publishing as <b>@' + esc(S.auth.username) + '</b> 🔒</p>'
        : '<p class="muted-txt">Uploading as guest <b>' + esc(S.myChannel.name) + '</b> — <a class="lnk" href="#/login">sign in</a> to post under an account.</p>')
      + '<div class="field"><label>Title</label><input id="upTitle" maxlength="90" placeholder="Give it a neon title…" required></div>'
      + '<div class="field"><label>Description</label><textarea id="upDesc" rows="4" placeholder="Tell the vibe…"></textarea></div>'
      + '<div class="field-row">'
      + '<div class="field"><label>Category</label><select id="upCat">' + YV.CATS.map(c => '<option>' + c + '</option>').join('') + '</select></div>'
      + '<div class="field"><label>Type</label><div class="radio-row">'
      + '<label class="rd"><input type="radio" name="upType" value="video" checked> 🎥 Video</label>'
      + '<label class="rd"><input type="radio" name="upType" value="short"> ⚡ Short</label>'
      + '</div></div></div>'
      + '<div class="field"><label>Thumbnail</label><div class="file-row">'
      + '<button type="button" class="pill-btn ghost" id="thBtn">🖼 Choose thumbnail</button>'
      + '<input type="file" id="thIn" accept="image/*" hidden>'
      + '<span class="muted-txt" id="thMsg">optional — auto-captured from the video if empty</span>'
      + '</div><div class="thumb-preview hide" id="thPrev"></div></div>'
      + '<div class="field"><label>✂ Trim (optional, seconds)</label><div class="field-row">'
      + '<input type="number" id="upTrimA" min="0" max="7200" placeholder="start">'
      + '<input type="number" id="upTrimB" min="0" max="7200" placeholder="end">'
      + '</div><p class="muted-txt" id="trimHint">viewers watch only this range — leave empty for the full video</p></div>'
      + '<div class="field"><label>🎵 Background music (optional)</label><div class="file-row">'
      + '<button type="button" class="pill-btn ghost" id="musBtn">🎵 Choose audio</button>'
      + '<input type="file" id="musIn" accept="audio/*" hidden>'
      + '<span class="muted-txt" id="musMsg">loops under the video</span></div></div>'
      + '<div class="up-preview hide" id="upPrev"><video id="prevVid" controls muted playsinline></video><div class="up-meta" id="upMeta"></div></div>'
      + '<div class="progress-wrap hide" id="upProg"><div class="progress-label" id="upProgLbl">Uploading…</div><div class="progress-bar"><div class="progress-fill" id="upProgFill"></div></div></div>'
      + '<div class="form-err" id="upErr"></div>'
      + '<button class="btn-neon publish" id="publish" type="submit">🚀 Publish</button>'
      + '</form></div></div>';

    const dz = $('#dz'), fileIn = $('#fileIn'), dzName = $('#dzName'),
      prevWrap = $('#upPrev'), prevVid = $('#prevVid'), upMeta = $('#upMeta'),
      upTitle = $('#upTitle'), upErr = $('#upErr'), publish = $('#publish'),
      thIn = $('#thIn'), thBtn = $('#thBtn'), thMsg = $('#thMsg'), thPrev = $('#thPrev');

    let file = null, objUrl = null, dur = 0, thumbData = null, thumbFile = null;
    let musFile = null;
    const musBtn = document.getElementById('musBtn'), musIn = document.getElementById('musIn'), musMsg = document.getElementById('musMsg');

    const err = m => { upErr.textContent = m || ''; };

    dz.addEventListener('click', e => { if (e.target === fileIn) return; fileIn.click(); });
    ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handle(f); });
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) handle(fileIn.files[0]); });

    function handle(f) {
      if (!f.type.startsWith('video/')) { err('⚠️ Please choose a video file (MP4, WebM…).'); return; }
      if (f.size > YV.MAX_MB * 1024 * 1024) { err('⚠️ That file is ' + fmtSize(f.size) + ' — max is ' + YV.MAX_MB + ' MB.'); return; }
      err(''); file = f;
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(f);
      const segCount = Math.max(1, Math.ceil(f.size / (YV.PART_MB * 1024 * 1024)));
      dzName.textContent = '📦 ' + f.name + ' (' + fmtSize(f.size) + ')';
      dz.classList.add('has');
      prevWrap.classList.remove('hide');
      prevVid.src = objUrl;
      if (!upTitle.value) upTitle.value = prettyName(f.name);
      upMeta.textContent = 'Reading video…';
      probeVideo(objUrl).then(m => {
        dur = m.dur;
        if (!thumbFile) return captureThumb(objUrl); // auto thumbnail only if none picked
        return null;
      }).then(th => {
        if (th && !thumbFile) {
          thumbData = th;
          thPrev.classList.remove('hide');
          thPrev.innerHTML = '<img src="' + th + '" alt="thumbnail preview">';
          thMsg.textContent = 'auto-captured from your video — or pick your own above';
        }
        upMeta.textContent = (dur ? '⏱ Duration ' + fmtDur(dur) : '') + ' · ready to publish ✨';
        const trimH = document.getElementById('trimHint');
        if (trimH && dur) trimH.textContent = '⏱ duration ' + fmtDur(dur) + ' — enter start/end in seconds (empty = full video)';
        publish.disabled = false;
      });
    }

    /* custom thumbnail */
    thBtn.addEventListener('click', () => thIn.click());
    thIn.addEventListener('change', async () => {
      const f = thIn.files[0]; if (!f) return;
      if (!f.type.startsWith('image/')) { thMsg.textContent = '⚠️ pick an image file'; return; }
      thMsg.textContent = 'processing…';
      const data = await imageToDataURL(f, 640, 360);
      if (!data) { thMsg.textContent = '⚠️ could not read image'; return; }
      thumbData = data;
      thumbFile = new File([await (await fetch(data)).blob()], 'thumb.jpg', { type: 'image/jpeg' });
      thPrev.classList.remove('hide');
      thPrev.innerHTML = '<img src="' + data + '" alt="thumbnail preview">';
      thMsg.textContent = '✅ custom thumbnail set';
    });
    try {
      const bgSel = document.getElementById('bgSel'), bgImgIn = document.getElementById('bgImg'), bgHint = document.getElementById('bgHint');
      window._bgImg = null;
      if (bgSel) bgSel.addEventListener('change', () => {
        if (bgSel.value === 'i') bgImgIn.click();
        else { window._bgImg = null; bgHint.textContent = 'backdrop: ' + (bgSel.value || 'none'); }
      });
      if (bgImgIn) bgImgIn.addEventListener('change', () => {
        const f = bgImgIn.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => { const im = new Image(); im.onload = () => { window._bgImg = im; bgHint.textContent = '🖼 backdrop image ready'; }; im.src = rd.result; };
        rd.readAsDataURL(f);
        bgSel.value = 'i';
      });
    } catch (e) {}
    musIn.addEventListener('change', () => {
      const f = musIn.files[0];
      if (!f) { musFile = null; musMsg.textContent = 'loops under the video'; return; }
      musFile = f;
      musMsg.textContent = '✅ ' + f.name.slice(0, 28) + ' — will loop under the video';
    });

    /* XHR wrapper with real upload progress */
    function xhrSend(method, url, body, headers, onProgress) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open(method, API_BASE + url);
        x.timeout = 240000; // never let a hung request stall an upload worker
        for (const k in headers) x.setRequestHeader(k, headers[k]);
        x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded); };
        x.onload = () => {
          if (x.status >= 200 && x.status < 300) {
            try { resolve(JSON.parse(x.responseText)); } catch (e2) { resolve(null); }
          } else {
            let m = ''; try { m = JSON.parse(x.responseText).error || ''; } catch (e2) {}
            reject(new Error(m || ('HTTP ' + x.status)));
          }
        };
        x.onerror = () => reject(new Error('network error'));
        x.ontimeout = () => reject(new Error('request timed out — retrying'));
        x.send(body);
      });
    }

    $('#upForm').addEventListener('submit', async e => {
      e.preventDefault();
      if (!file) { err('⚠️ Pick a video first.'); return; }
      const title = upTitle.value.trim() || 'Untitled vibe';
      publish.disabled = true; publish.textContent = '⏳ Uploading…';
      err('');
      const progWrap = $('#upProg'), progLbl = $('#upProgLbl'), progFill = $('#upProgFill');
      progWrap.classList.remove('hide');
      const setProg = (txt, frac) => {
        progLbl.textContent = txt;
        progFill.style.width = Math.min(100, Math.max(0, Math.round(frac * 100))) + '%';
      };

      UPLOADING = true;
      try {
        /* ═══ BUNNY STREAM UPLOAD (direct to CDN) ═══ */
        try {
          const bunnyCfg = await api('/api/bunny');
          if (bunnyCfg && bunnyCfg.libraryId) {
            setProg('📡 Creating video on CDN…', 0);
            const create = await fetch('https://video.bunnycdn.com/library/' + bunnyCfg.libraryId + '/videos', {
              method: 'POST',
              headers: { AccessKey: bunnyCfg.apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: title })
            });
            if (create.ok) {
              const vj = await create.json();
              setProg('📡 Uploading to CDN — 0%', 0);
              const t0 = Date.now();
              await new Promise((resolve, reject) => {
                const x = new XMLHttpRequest();
                x.open('PUT', 'https://video.bunnycdn.com/library/' + bunnyCfg.libraryId + '/videos/' + vj.guid);
                x.setRequestHeader('AccessKey', bunnyCfg.apiKey);
                x.setRequestHeader('Content-Type', 'application/octet-stream');
                x.timeout = 600000;
                x.upload.onprogress = e => {
                  if (e.lengthComputable) {
                    const pct = Math.floor((e.loaded / e.total) * 100);
                    const speed = (e.loaded / 1048576 / ((Date.now() - t0) / 1000)).toFixed(1);
                    setProg('📡 Uploading — ' + pct + '% (' + speed + ' MB/s)', e.loaded / e.total);
                  }
                };
                x.onload = () => { if (x.status < 300) resolve(); else reject(new Error('CDN upload ' + x.status)); };
                x.onerror = () => reject(new Error('network error'));
                x.ontimeout = () => reject(new Error('timed out'));
                x.send(file);
              });
              setProg('⚡ Publishing…', 1);
              const res = await api('/api/videos/bunny', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  guid: vj.guid,
                  trimStart: Math.max(0, parseInt((document.getElementById('upTrimA') || {}).value, 10) || 0),
                  trimEnd: Math.max(0, parseInt((document.getElementById('upTrimB') || {}).value, 10) || 0),
                  title,
                  description: $('#upDesc').value.trim(),
                  category: $('#upCat').value,
                  type: $('input[name="upType"]:checked').value,
                  duration: dur ? fmtDur(dur) : '',
                  uploader: myName(),
                  thumb: thumbData || null,
                })
              });
              if (res.del_key) S.myDelKeys[res.id] = res.del_key;
              YV.store.save();
              await loadVideos();
              if (musFile) {
                try {
                  const mfd = new FormData();
                  mfd.append('music', musFile);
                  await xhrSend('POST', '/api/videos/' + res.id + '/music', mfd, {}, null);
                } catch (mErr) {}
              }
              toast('Published! Video is processing on CDN — playable in ~1 min 🎉', '🚀');
              location.hash = '#/watch/' + res.id;
              UPLOADING = false;
              return;
            }
          }
        } catch (bunnyErr) {
          console.warn('Bunny upload failed, falling back to segments:', bunnyErr.message);
          setProg('📡 Using backup upload method…', 0);
        }

        /* ═══ FALLBACK: legacy segment upload ═══ */
        /* RESUMABLE publishing: remember finished segments for this exact file
           → if anything fails, pressing Publish again continues where it stopped */
        const sig = 'yv_up_' + (file.name || 'v') + '_' + file.size + '_' + (file.lastModified || 0);
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(sig) || 'null'); } catch (e) {}
        if (!saved || saved.size !== file.size) saved = null;
        const uid = (saved && saved.uid) || (crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now() + Math.random().toString(36).slice(2));
        const doneSet = new Set(saved ? (saved.done || []) : []);
        const saveUp = () => { try { localStorage.setItem(sig, JSON.stringify({ uid, size: file.size, done: [...doneSet] })); } catch (e) {} };

        const CHUNK = YV.PART_MB * 1024 * 1024;
        const segCount = Math.max(1, Math.min(YV.MAX_PARTS, Math.ceil(file.size / CHUNK)));
        const total = file.size;

        if (doneSet.size) setProg('↩️ Resuming — ' + doneSet.size + '/' + segCount + ' segments already uploaded', doneSet.size / segCount);

        /* upload segments in PARALLEL (4 streams) with aggregated progress + auto-retry */
        const progLoaded = {};
        const segSizes = [];
        for (let i = 0; i < segCount; i++) segSizes.push(Math.min(CHUNK, total - i * CHUNK));
        let sendIdx = 0;
        let sentDone = 0;
        [...doneSet].forEach(i => { sentDone += Math.min(CHUNK, total - i * CHUNK); });
        const pctOf = () => {
          let b = sentDone;
          for (const k in progLoaded) b += progLoaded[k];
          return Math.min(1, b / total);
        };
        /* self-healing segment upload: 8 attempts with growing pauses,
           then auto-cooldown rounds — hiccups are recovered invisibly */
        const RETRY_DELAYS = [2000, 3000, 5000, 8000, 13000, 21000, 34000, 34000];
        const sendSegP = async (i, blob, round, attempt) => {
          const fd = new FormData();
          fd.append('video', blob, (file.name || 'video') + '.part' + i);
          try {
            await xhrSend('POST', '/api/videos/' + uid + '/segment?index=' + i + '&size=' + blob.size, fd, {}, loaded => {
              progLoaded[i] = loaded;
              setProg('📡 Uploading — ' + Math.floor(pctOf() * 100) + '%', pctOf());
            });
            delete progLoaded[i];
            sentDone += blob.size;
            doneSet.add(i);
            saveUp();
            setProg('📡 Uploading — ' + Math.floor(pctOf() * 100) + '%', pctOf());
          } catch (e) {
            const msg = String(e.message || '');
            if (msg.includes('segment exists')) {
              /* already uploaded in a previous attempt — count as done */
              delete progLoaded[i];
              sentDone += blob.size;
              doneSet.add(i);
              saveUp();
              return;
            }
            if (attempt <= RETRY_DELAYS.length) {
              if (attempt >= 3) setProg('⚠️ Weak connection — auto-recovering (' + attempt + '/8)…', pctOf());
              await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1] || 30000));
              return sendSegP(i, blob, round, attempt + 1);
            }
            if (round < 3) {
              setProg('⏳ Connection trouble — auto-continuing in 30s…', pctOf());
              await new Promise(r => setTimeout(r, 30000));
              return sendSegP(i, blob, round + 1, 1);
            }
            throw e;
          }
        };
        const worker = async () => {
          while (sendIdx < segCount) {
            const i = sendIdx++;
            if (doneSet.has(i)) continue; // already uploaded in a previous attempt
            const blob = file.slice(i * CHUNK, Math.min((i + 1) * CHUNK, total));
            await sendSegP(i, blob, 1, 1);
          }
        };
        /* 4 parallel lanes: saturates the uplink while staying under
           GitHub's concurrent-upload abuse detection */
        await Promise.all([worker(), worker(), worker(), worker()]);

        setProg('⚡ Finalizing…', 1);
        const res = await api('/api/videos/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: uid,
            trimStart: Math.max(0, parseInt((document.getElementById('upTrimA') || {}).value, 10) || 0),
            trimEnd: Math.max(0, parseInt((document.getElementById('upTrimB') || {}).value, 10) || 0),
            title,
            description: $('#upDesc').value.trim(),
            category: $('#upCat').value,
            type: $('input[name="upType"]:checked').value,
            duration: dur ? fmtDur(dur) : '',
            uploader: myName(),
            parts: segCount,
            sizes: segSizes, // client knows exact sizes -> instant finalize
            thumb: thumbData || null,
          }),
        });
        try { localStorage.removeItem(sig); } catch (e) {}
        if (res.del_key) S.myDelKeys[res.id] = res.del_key;
        YV.store.save();
        await loadVideos();
        if (musFile) {
          try {
            const mfd = new FormData();
            mfd.append('music', musFile);
            await xhrSend('POST', '/api/videos/' + res.id + '/music', mfd, {}, null);
          } catch (mErr) {}
        }
        toast('Published! Everyone can see it now', '🎉');
        location.hash = '#/watch/' + res.id;
      } catch (ex) {
        err('⚠️ ' + (ex.message || 'Upload failed') + ' — progress is SAVED: press Publish again to resume');
        setProg('⏸ Paused — progress saved. Press Publish to resume', null);
        publish.disabled = false; publish.textContent = '🚀 Publish';
      } finally {
        UPLOADING = false;
      }
    });
  }

  /* ═══════════ VIEW: SETTINGS ═══════════ */
  function viewSettings() {
    const c = S.myChannel;
    const myNameNow = myName();
    const myRank = (COLORS[myNameNow] || S.myColor || '').toLowerCase() || '';
    const subsNow = subsOfCreator(myNameNow);
    main.innerHTML = '<div class="page set-page">'
      + '<h1 class="page-title">Customize your channel</h1>'
      + '<div class="set-grid">'
      + '<div class="set-col">'
      + '<div class="about-card"><h3>👤 Account</h3>'
      + (S.auth && S.auth.username
        ? '<p class="muted-txt">Signed in as <b>@' + esc(S.auth.username) + '</b> — your uploads are bound to this account.</p>'
        + '<button class="pill-btn danger" data-action="logout">Log out</button>'
        : '<p class="muted-txt">You\'re a guest. <a class="lnk" href="#/login">Sign in or create an account</a> to lock your name.</p>')
      + '</div>'
      + '<div class="preview-card">'
      + '<div class="banner prev' + (c.banner ? ' has-img' : '') + '"' + (c.banner ? ' style="background-image:url(' + c.banner + ')"' : ' style="--c1:' + c.colors[0] + ';--c2:' + c.colors[1] + '"') + ' id="prevBanner"></div>'
      + '<div class="prev-head">' + '<span id="prevAva">' + avatarHTML(meCh(), 72) + '</span>'
      + '<div><h3 id="prevName">' + esc(c.name) + '</h3><div class="muted-txt">your creator name</div></div></div>'
      + '</div>'
      + '<div class="about-card"><h3>⚠️ Danger zone</h3><p class="muted-txt">Wipes your local likes, subscriptions, history and channel look. (Videos on the server stay.)</p>'
      + '<button class="pill-btn danger" data-action="reset-all">Reset ALL local data</button></div>'
      + '</div>'
      + '<form class="up-form" id="setForm">'
      + '<div class="field"><label>Channel name</label>' + (S.auth && S.auth.username
        ? '<input value="@' + esc(S.auth.username) + '" disabled><p class="muted-txt">locked to your account</p>'
        : '<input id="stName" maxlength="40" value="' + esc(c.name) + '" required>') + '</div>'
      + '<div class="field"><label>Bio</label><textarea id="stBio" rows="4" placeholder="Tell the world about your vibe…">' + esc(c.bio || '') + '</textarea></div>'
      + '<div class="field"><label>Social links</label><div class="links-row">'
      + '<input id="stYt" placeholder="YouTube URL" value="' + esc((c.links && c.links.yt) || '') + '">'
      + '<input id="stTg" placeholder="Telegram URL" value="' + esc((c.links && c.links.tg) || '') + '">'
      + '<input id="stIg" placeholder="Instagram URL" value="' + esc((c.links && c.links.ig) || '') + '">'
      + '</div><p class="muted-txt">shown on your channel as buttons ▶ ✈ 📷</p></div>'
      + '<div class="field"><label>Profile picture</label><div class="file-row">'
      + '<button type="button" class="pill-btn ghost" id="avaBtn">🖼 Choose avatar</button>'
      + '<input type="file" id="avaIn" accept="image/*" hidden><span class="muted-txt" id="avaMsg"></span></div></div>'
      + '<div class="field"><label>Channel color</label><select id="stColor">'
      + '<option value=""' + (myRank ? '' : ' selected') + '>Default (no rank)</option>'
      + '<option value="bronze"' + (myRank === 'bronze' ? ' selected' : (subsNow >= 10000 ? '' : ' disabled')) + '>🥉 Bronze — 10K followers</option>'
      + '<option value="silver"' + (myRank === 'silver' ? ' selected' : (subsNow >= 100000 ? '' : ' disabled')) + '>🥈 Silver — 100K followers</option>'
      + '<option value="gold"' + (myRank === 'gold' ? ' selected' : (subsNow >= 1000000 ? '' : ' disabled')) + '>🥇 Gold — 1M followers</option>'
      + '<option value="diamond"' + (myRank === 'diamond' ? ' selected' : (subsNow >= 10000000 ? '' : ' disabled')) + '>💎 Diamond — 10M followers</option>'
      + '<option value="emerald"' + (myRank === 'emerald' ? ' selected' : (subsNow >= 50000000 ? '' : ' disabled')) + '>💚 Emerald — 50M followers</option>'
      + '<option value="ruby"' + (myRank === 'ruby' ? ' selected' : (subsNow >= 100000000 ? '' : ' disabled')) + '>🔴 Ruby — 100M followers</option>'
      + '</select><p class="muted-txt">unlocks with followers — colors your name + avatar ring everywhere</p></div>'
      + '<div class="field"><label>Banner</label><div class="file-row">'
      + '<button type="button" class="pill-btn ghost" id="banBtn">🌅 Choose banner</button>'
      + '<input type="file" id="banIn" accept="image/*" hidden><span class="muted-txt" id="banMsg"></span></div></div>'
      + '<div class="form-err" id="stErr"></div>'
      + '<button class="btn-neon" type="submit">💾 Save channel</button>'
      + '</form></div></div>';

    let avaData = c.avatar, banData = c.banner;

    /* channel color applies instantly when picked */
    const stColorEl = $('#stColor');
    if (stColorEl) stColorEl.addEventListener('change', () => {
      const val = stColorEl.value;
      S.myColor = val || null;
      if (S.auth && S.auth.token) {
        saveProfileToAccount({ color: val || null });
      } else {
        YV.store.save();
      }
      if (val) {
        COLORS[myName()] = val;
        toast('Channel color: ' + (RANKS[val] ? RANKS[val].label : val) + ' 🎨', '🎨');
      } else {
        delete COLORS[myName()];
        toast('Channel color removed', '🎨');
      }
      navigate(); // re-render with the new color everywhere
    });

    $('#avaBtn').onclick = () => $('#avaIn').click();
    $('#banBtn').onclick = () => $('#banIn').click();
    $('#avaIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      $('#avaMsg').textContent = 'processing…';
      avaData = await imageToDataURL(f, 160, 160);
      $('#avaMsg').textContent = avaData ? '✅ ready' : '⚠️ could not read image (try a JPG/PNG)';
      if (avaData) {
        $('#prevAva').innerHTML = '<span class="av av-img" style="width:72px;height:72px"><img src="' + avaData + '"></span>';
        if (S.auth && S.auth.token) { const sel = $('#stColor'); saveProfileToAccount({ avatar: avaData, banner: banData, bio: $('#stBio').value.trim(), color: sel ? sel.value : undefined }); } // instant account save
      }
    };
    $('#banIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      $('#banMsg').textContent = 'processing…';
      banData = /gif$/i.test(f.type)
        ? await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(f); })
        : await imageToDataURL(f, 960, 220);
      $('#banMsg').textContent = banData ? '✅ ready' : '⚠️ could not read image (try a JPG/PNG)';
      if (banData) {
        const b = $('#prevBanner'); b.classList.add('has-img'); b.style.backgroundImage = 'url(' + banData + ')';
        if (S.auth && S.auth.token) saveProfileToAccount({ avatar: avaData, banner: banData }); // instant account save
      }
    };
    $('#stName') && ($('#stName').oninput = e => $('#prevName').textContent = e.target.value || '…');

    $('#setForm').onsubmit = e => {
      e.preventDefault();
      if (!S.auth) {
        const name = $('#stName').value.trim();
        if (!name) { $('#stErr').textContent = '⚠️ Channel name is required.'; return; }
        S.myChannel.name = name;
      }
      S.myChannel.bio = $('#stBio').value.trim();
      S.myChannel.links = { yt: ($('#stYt') && $('#stYt').value || '').trim(), tg: ($('#stTg') && $('#stTg').value || '').trim(), ig: ($('#stIg') && $('#stIg').value || '').trim() };
      S.myChannel.avatar = avaData;
      S.myChannel.banner = banData;
      YV.store.save();
      renderMe();
      /* logged in → save avatar/banner to the account (works on every device) */
      if (S.auth && S.auth.token) {
        api('/api/auth/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ avatar: avaData, banner: banData, bio: $('#stBio').value.trim(), color: $('#stColor') ? $('#stColor').value : undefined, links: S.myChannel.links })
        }).then(() => { AVATARS[S.auth.username.toLowerCase()] = avaData; navigate(); }).catch(() => {});
      }
      toast('Channel updated', '✨');
      location.hash = '#/channel';
    };
    /* restore social links from the account */
    if (S.auth && S.auth.token) {
      api('/api/auth/me').then(me => {
        if (me && me.links) {
          S.myChannel.links = me.links;
          const yt = $('#stYt'), tg = $('#stTg'), ig = $('#stIg');
          if (yt) yt.value = me.links.yt || '';
          if (tg) tg.value = me.links.tg || '';
          if (ig) ig.value = me.links.ig || '';
        }
      }).catch(() => {});
    }
  }

  /* ═══════════ state toggles + UI sync ═══════════ */
  async function toggleLike(id) {
    const v = byId(id); if (!v) return;
    const delta = S.likes[id] ? -1 : 1;
    if (delta > 0) { S.likes[id] = 1; delete S.dislikes[id]; toast('Liked ❤', '❤️'); }
    else delete S.likes[id];
    YV.store.save();
    try {
      const r = await api('/api/videos/' + id + '/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta }) });
      v.likes = Number(r.likes) || 0;
    } catch (e) { v.likes = Math.max(0, (Number(v.likes) || 0) + delta); }
    updateLikeUI(id);
  }

  function toggleDislike(id) {
    if (S.dislikes[id]) delete S.dislikes[id];
    else { S.dislikes[id] = 1; delete S.likes[id]; }
    YV.store.save();
    updateLikeUI(id);
  }

  function updateLikeUI(id) {
    const v = byId(id); if (!v) return;
    $$('[data-action="like"][data-id="' + id + '"]').forEach(b => {
      b.classList.toggle('on', isLiked(id));
      const c = b.querySelector('.cnt'); if (c) c.textContent = fmtNum(likesOf(v));
    });
    $$('[data-action="dislike"][data-id="' + id + '"]').forEach(b => b.classList.toggle('on', !!S.dislikes[id]));
  }

  function toggleSub(name) {
    if (!name || name === S.myChannel.name) return;
    if (S.subs[name]) { delete S.subs[name]; toast('Unsubscribed', '👋'); }
    else { S.subs[name] = 1; toast('Subscribed! Their uploads appear in Subscriptions', '🔔'); }
    YV.store.save();
    updateSubUI(name);
  }

  function updateSubUI(name) {
    const on = isSub(name);
    $$('[data-action="sub"][data-ch="' + name + '"]').forEach(b => {
      b.classList.toggle('subbed', on);
      b.innerHTML = on ? '🔔 Subscribed' : 'Subscribe';
    });
  }

  function toggleLater(id) {
    if (S.later[id]) { delete S.later[id]; toast('Removed from Watch later', '⏳'); }
    else { S.later[id] = 1; toast('Saved to Watch later', '⏳'); }
    YV.store.save();
    $$('[data-action="later"][data-id="' + id + '"]').forEach(b => {
      b.classList.toggle('on', !!S.later[id]);
      if (b.classList.contains('later-btn')) b.textContent = S.later[id] ? '✓' : '＋';
      else b.textContent = S.later[id] ? '⏳ Saved' : '⏳ Later';
    });
  }

  function doShare(id) {
    const url = location.origin + location.pathname + '#/watch/' + id;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard', '🔗'), () => toast('Share: ' + url, '🔗'));
    } else toast('Share: ' + url, '🔗');
  }

  async function doDelete(id) {
    if (!confirm('Delete this video from the server for everyone?')) return;
    try {
      await api('/api/videos/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ del_key: S.myDelKeys[id] || '' }) });
      delete S.myDelKeys[id];
      delete S.likes[id]; delete S.dislikes[id]; delete S.later[id];
      S.history = S.history.filter(x => x !== id);
      YV.store.save();
      await loadVideos();
      toast('Video deleted', '🗑');
      if (('#/watch/' + id) === location.hash) location.hash = '#/channel';
      else navigate();
    } catch (e) {
      toast('Delete failed: ' + (e.message || 'error'), '⚠️');
    }
  }

  /* ═══════════ notifications (bell) ═══════════ */
  function renderNotifs() {
    const btn = $('#notifBtn');
    if (!btn) return;
    let seen = 0;
    try { seen = Number(localStorage.getItem('yv_notif_seen') || 0); } catch (e) {}
    const unread = NOTIFS.filter(n => n.id > seen).length;
    const cnt = $('#notifCount');
    if (cnt) { cnt.textContent = unread || ''; cnt.style.display = unread ? 'grid' : 'none'; }
  }

  function openNotifPanel() {
    const panel = $('#notifPanel');
    if (!panel) return;
    panel.classList.toggle('hide');
    if (panel.classList.contains('hide')) return;
    const list = $('#notifList');
    if (!NOTIFS.length) {
      list.innerHTML = '<p class="muted-txt" style="padding:16px;text-align:center">No notifications yet 🔔</p>';
    } else {
      list.innerHTML = NOTIFS.map(n =>
        '<div class="notif-item"><div class="notif-sender">▶ YourVibe <span class="vrf-badge" title="Verified">✓</span></div>'
        + '<div class="notif-text">' + esc(n.text) + '</div>'
        + '<div class="notif-time">' + timeAgo(n.created_at ? Date.parse(n.created_at) : 0) + '</div></div>'
      ).join('');
    }
    const top = NOTIFS.length ? NOTIFS[0].id : 0;
    try { localStorage.setItem('yv_notif_seen', String(top)); } catch (e) {}
    renderNotifs();
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('#notifBtn');
    const panel = document.querySelector('#notifPanel');
    const hbtn = e.target.closest('#helpBtn');
    const hpanel = document.querySelector('#helpPanel');
    if (btn) { openNotifPanel(); return; }
    if (hbtn) { openHelpPanel(); return; }
    const dbtn = e.target.closest('#dmBtn');
    if (dbtn) {
      if (!(S.auth && S.auth.token)) { toast('Log in to use messages 🔒', '🔒'); return; }
      openDmPanel();
      return;
    }
    if (panel && !panel.classList.contains('hide') && !e.target.closest('#notifPanel')) panel.classList.add('hide');
    if (hpanel && !hpanel.classList.contains('hide') && !e.target.closest('#helpPanel')) hpanel.classList.add('hide');
  });

  /* ═══════════ help chat (user ↔ YourVibe admin) ═══════════ */
  let helpSeen = 0;
  let lastAdminId = 0;
  try { helpSeen = Number(localStorage.getItem('yv_help_seen') || 0); } catch (e) {}
  function supportName() { return myName() || ('guest-' + voterTag()); }
  function helpMsgHTML(m) {
    const when = m.created_at ? timeAgo(Date.parse(m.created_at)) : '';
    if (m.ai) {
      return '<div class="help-msg admin ai"><div class="help-who">🤖 YourVibe <span class="ai-badge">AI</span></div><div class="help-txt">' + esc(m.text) + '</div><div class="help-time">' + when + '</div></div>';
    }
    if (m.from_admin) {
      return '<div class="help-msg admin"><div class="help-who">▶ YourVibe <span class="vrf-badge" title="Verified">✓</span></div><div class="help-txt">' + esc(m.text) + '</div><div class="help-time">' + when + '</div></div>';
    }
    return '<div class="help-msg me"><div class="help-who">' + esc(m.username) + '</div><div class="help-txt">' + esc(m.text) + '</div><div class="help-time">' + when + '</div></div>';
  }
  async function pollHelp() {
    try {
      const list = await api('/api/support?user=' + encodeURIComponent(supportName()));
      list.forEach(m => { if (m.from_admin && m.id > lastAdminId) lastAdminId = m.id; });
      const el = $('#helpList');
      if (el && el.dataset.open === '1') {
        el.innerHTML = list.length ? list.slice().reverse().map(helpMsgHTML).join('') : '<p class="muted-txt" style="padding:16px;text-align:center">Describe your problem — the admin will answer here 💌</p>';
        el.scrollTop = el.scrollHeight;
      }
      const unread = list.filter(m => m.from_admin && m.id > helpSeen).length;
      const cnt = $('#helpCount');
      if (cnt) { cnt.textContent = unread || ''; cnt.style.display = unread ? 'grid' : 'none'; }
    } catch (e) {}
  }
  function openHelpPanel() {
    const panel = $('#helpPanel');
    if (!panel) return;
    panel.classList.toggle('hide');
    const el = $('#helpList');
    const np = $('#notifPanel');
    if (panel.classList.contains('hide')) { if (el) el.dataset.open = '0'; return; }
    if (np) np.classList.add('hide');
    if (el) el.dataset.open = '1';
    helpSeen = lastAdminId;
    try { localStorage.setItem('yv_help_seen', String(helpSeen)); } catch (e) {}
    pollHelp();
    const inp = $('#helpText');
    if (inp) setTimeout(() => inp.focus(), 100);
  }
  const helpForm = $('#helpForm');
  if (helpForm) helpForm.onsubmit = async e => {
    e.preventDefault();
    const inp = $('#helpText');
    const text = (inp.value || '').trim();
    if (!text) return;
    inp.value = '';
    try {
      await api('/api/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: supportName(), text }) });
      pollHelp();
      setTimeout(pollHelp, 3000); setTimeout(pollHelp, 6000); setTimeout(pollHelp, 10000);
    } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
  };
  setInterval(pollHelp, 8000);
  setTimeout(pollHelp, 1200);

  /* ═══════════ announcements (admin → everyone) ═══════════ */
  let ANN = null;

  async function loadAnnouncement() {
    try { ANN = await api('/api/announcement'); } catch (e) { ANN = null; }
    renderAnnouncement();
  }

  function renderAnnouncement() {
    const bar = $('#announceBar');
    if (!bar) return;
    let dismissed = null;
    try { dismissed = localStorage.getItem('yv_ann_dismissed'); } catch (e) {}
    if (ANN && ANN.id && String(ANN.id) !== dismissed) {
      bar.innerHTML = '<div class="announce-inner"><span class="ann-ico">📣</span>'
        + '<span class="ann-text">' + esc(ANN.text) + '</span>'
        + '<button class="ann-x" id="annDismiss" title="Dismiss">✕</button></div>';
      document.body.classList.add('has-ann');
      const x = $('#annDismiss');
      if (x) x.onclick = () => {
        try { localStorage.setItem('yv_ann_dismissed', String(ANN.id)); } catch (e) {}
        bar.innerHTML = '';
        document.body.classList.remove('has-ann');
      };
    } else {
      bar.innerHTML = '';
      document.body.classList.remove('has-ann');
    }
  }

  /* move guest uploads from this browser into the logged-in account
     (also merges same-name creators: "Vadim Playground" ≈ vadim_playground) */
  async function claimMyVideos(silent) {
    if (!S.auth || !S.auth.token) return 0;
    const ids = Object.keys(S.myDelKeys || {});
    try {
      const r = await api('/api/auth/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claims: ids.map(id => ({ id, del_key: S.myDelKeys[id] })) }),
      });
      if (r.moved > 0) {
        videosLoaded = false;
        toast('Moved ' + r.moved + ' video' + (r.moved === 1 ? '' : 's') + ' to @' + S.auth.username, '📦');
        if (!silent) { await loadVideos(); navigate(); }
      }
      return r.moved || 0;
    } catch (e) { return 0; }
  }

  /* pull account avatar/banner so your icon follows you to every device */
  async function syncAccountProfile() {
    if (!S.auth || !S.auth.token) return;
    try {
      const me = await api('/api/auth/me');
      if (!me || !me.username) throw new Error('dead session');
      if (me.avatar_url) { S.acctAvatar = me.avatar_url; AVATARS[S.auth.username.toLowerCase()] = me.avatar_url; }
      if (me.banner_url) S.acctBanner = me.banner_url;
      if (me.bio) S.myChannel.bio = me.bio;
      renderMe();
    } catch (e) {
      /* session died (token invalidated server-side) → self-heal: clear + prompt */
      S.auth = null;
      YV.store.save();
      renderMe();
      toast('Session expired — please log in again', '🔑');
    }
  }

  /* save avatar/banner to the account immediately when picked */
  async function saveProfileToAccount(patch) {
    if (!S.auth || !S.auth.token) return;
    try {
      const r = await api('/api/auth/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (r.avatar_url) { S.acctAvatar = r.avatar_url; AVATARS[S.auth.username.toLowerCase()] = r.avatar_url; }
      if (r.banner_url) { S.acctBanner = r.banner_url; }
      if (r.bio !== undefined) S.myChannel.bio = r.bio || S.myChannel.bio;
      if (r.color !== undefined) { S.myColor = r.color || null; if (S.auth && S.auth.username) { if (r.color) COLORS[S.auth.username] = r.color; else delete COLORS[S.auth.username]; } }
      YV.store.save();
      renderMe();
    } catch (e) {}
  }

  /* ═══════════ polls ═══════════ */
  function voterTag() {
    if (S.auth && S.auth.username) return S.auth.username;
    let v = null;
    try {
      v = localStorage.getItem('yv_voter');
      if (!v) { v = 'guest-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('yv_voter', v); }
    } catch (e) { v = 'guest-' + Date.now(); }
    return v;
  }

  function renderPoll(slot, vid, p) {
    const voted = p.myVote !== null && p.myVote !== undefined;
    const opts = p.options.map((o, i) => {
      const pct = p.total ? Math.round((p.counts[i] / p.total) * 100) : 0;
      if (voted) {
        const mine = p.myVote === i;
        return '<button class="poll-opt done' + (mine ? ' mine' : '') + '">'
          + '<i class="po-bar" style="width:' + pct + '%"></i>'
          + '<span class="po-t">' + esc(o) + (mine ? ' ✓' : '') + '</span>'
          + '<span class="po-pct">' + pct + '%</span></button>';
      }
      return '<button class="poll-opt" data-pollopt="' + i + '">'
        + '<i class="po-bar" style="width:0%"></i>'
        + '<span class="po-t">' + esc(o) + '</span></button>';
    }).join('');
    slot.innerHTML = '<div class="poll-card"><h3>📊 ' + esc(p.question) + '</h3>'
      + opts + '<div class="poll-total">' + fmtNum(p.total) + ' vote' + (p.total === 1 ? '' : 's') + '</div></div>';
    slot.querySelectorAll('[data-pollopt]').forEach(btn => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const r = await api('/api/polls/' + p.id + '/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ opt: Number(btn.dataset.pollopt), voter: voterTag() })
          });
          renderPoll(slot, vid, r);
          toast('Vote counted', '📊');
        } catch (e) { btn.disabled = false; toast(e.message || 'vote failed', '⚠️'); }
      };
    });
  }

  async function loadPoll(vid) {
    const slot = $('#pollSlot');
    if (!slot) return;
    let p = null;
    try { p = await api('/api/videos/' + vid + '/poll'); } catch (e) {}
    if (p && p.id) renderPoll(slot, vid, p);
    else slot.innerHTML = '';
  }

  /* poll builder modal (used by owners + admin) */
  function openPollModal(videoId) {
    const old = $('#pollModal'); if (old) old.remove();
    const d = document.createElement('div');
    d.className = 'admin-overlay';
    d.id = 'pollModal';
    d.innerHTML = '<div class="admin-box">'
      + '<div class="admin-head"><span>📊 Create a poll</span><button class="admin-close" id="pmClose">✕</button></div>'
      + '<div class="admin-body">'
      + '<div class="field"><label>Question</label><input id="pmQ" maxlength="200" placeholder="What do you think about…"></div>'
      + '<div class="field"><label>Options</label><div id="pmOpts">'
      + '<input class="pm-opt" maxlength="80" placeholder="Option 1"><input class="pm-opt" maxlength="80" placeholder="Option 2">'
      + '</div><button type="button" class="pill-btn ghost" id="pmAdd" style="margin-top:8px">＋ Add option</button></div>'
      + '<div class="form-err" id="pmErr"></div>'
      + '<button class="btn-neon" id="pmCreate" style="justify-content:center">📊 Create poll</button>'
      + '</div></div>';
    document.body.appendChild(d);
    const optsWrap = $('#pmOpts');
    const close = () => d.remove();
    $('#pmClose').onclick = close;
    d.addEventListener('click', e => { if (e.target === d) close(); });
    $('#pmAdd').onclick = () => {
      if (optsWrap.querySelectorAll('.pm-opt').length >= 6) return;
      const inp = document.createElement('input');
      inp.className = 'pm-opt'; inp.maxLength = 80;
      inp.placeholder = 'Option ' + (optsWrap.querySelectorAll('.pm-opt').length + 1);
      inp.style.marginTop = '8px';
      optsWrap.appendChild(inp);
    };
    $('#pmCreate').onclick = async () => {
      const question = $('#pmQ').value.trim();
      const options = [...optsWrap.querySelectorAll('.pm-opt')].map(i => i.value.trim()).filter(Boolean);
      $('#pmErr').textContent = '';
      if (!question || options.length < 2) { $('#pmErr').textContent = '⚠️ Need a question and at least 2 options.'; return; }
      const btn = $('#pmCreate');
      btn.disabled = true; btn.textContent = '⏳ Creating…';
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (!(S.myDelKeys[videoId]) && !(S.auth && S.auth.username)) headers['X-Admin-Key'] = ADMIN_KEY;
        await api('/api/videos/' + videoId + '/poll', { method: 'POST', headers, body: JSON.stringify({ question, options }) });
        toast('Poll created', '📊');
        close();
        loadPoll(videoId);
      } catch (e) {
        $('#pmErr').textContent = '⚠️ ' + (e.message || 'failed');
        btn.disabled = false; btn.textContent = '📊 Create poll';
      }
    };
    setTimeout(() => { const q = $('#pmQ'); if (q) q.focus(); }, 60);
  }

  async function createPollFlow(vid) {
    openPollModal(vid);
  }

  function renderMe() {
    const el = $('#meAvatar');
    if (S.auth && S.auth.username) {
      el.innerHTML = avatarHTML({ name: S.auth.username, colors: palFor(S.auth.username) }, 36);
      el.title = '@' + S.auth.username;
      el.setAttribute('href', '#/channel');
    } else {
      el.innerHTML = '<span class="signin-btn">Sign in</span>';
      el.title = 'Sign in / Sign up';
      el.setAttribute('href', '#/login');
    }
  }

  /* ═══════════ VIEW: LOGIN / SIGNUP ═══════════ */
  function viewLogin() {
    if (S.auth && S.auth.username) {
      main.innerHTML = '<div class="page"><div class="auth-card">'
        + '<h1 class="page-title">You\'re signed in</h1>'
        + '<p class="muted-txt pad">Logged in as <b>@' + esc(S.auth.username) + '</b></p>'
        + '<button class="pill-btn danger" data-action="logout">Log out</button>'
        + '</div></div>';
      return;
    }
    main.innerHTML = '<div class="page"><div class="auth-card">'
      + '<h1 class="page-title">Join YourVibe</h1>'
      + '<p class="muted-txt">Accounts keep your name safe — videos you publish are bound to it, and you can delete them from any device.</p>'
      + '<div class="ch-tabs" style="margin-left:0;margin-right:0">'
      + '<button class="tab-btn on" id="tabLogin" data-action="authtab" data-tab="login">Log in</button>'
      + '<button class="tab-btn" id="tabSignup" data-action="authtab" data-tab="signup">Sign up</button>'
      + '</div>'
      + '<form class="up-form" id="authForm">'
      + '<div class="field"><label>Username</label><input id="auUser" maxlength="20" placeholder="neon_fox" autocomplete="username"></div>'
      + '<div class="field"><label>Password</label><input id="auPass" type="password" maxlength="72" placeholder="••••••" autocomplete="current-password"></div>'
      + '<div class="form-err" id="auErr"></div>'
      + '<button class="btn-neon" id="auSubmit" type="submit">Log in</button>'
      + '</form></div></div>';

    let mode = 'login';
    const setMode = m => {
      mode = m;
      $('#tabLogin').classList.toggle('on', mode === 'login');
      $('#tabSignup').classList.toggle('on', mode === 'signup');
      $('#auSubmit').textContent = mode === 'login' ? 'Log in' : 'Create account ✨';
      $('#auErr').textContent = '';
    };
    $('#tabLogin').onclick = () => setMode('login');
    $('#tabSignup').onclick = () => setMode('signup');

    $('#authForm').onsubmit = async e => {
      e.preventDefault();
      const username = $('#auUser').value.trim().toLowerCase();
      const password = $('#auPass').value;
      $('#auErr').textContent = '';
      $('#auSubmit').disabled = true;
      try {
        const r = await api('/api/auth/' + (mode === 'login' ? 'login' : 'signup'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        S.auth = { token: r.token, username: r.username };
        YV.store.save();
        renderMe();
        toast(mode === 'login' ? 'Welcome back, @' + r.username + '!' : 'Account created — welcome, @' + r.username + '!', '✨');
        await syncAccountProfile();
        await claimMyVideos();
        location.hash = '#/upload';
      } catch (ex) {
        $('#auErr').textContent = '⚠️ ' + (ex.message || 'failed');
        $('#auSubmit').disabled = false;
      }
    };
  }

  /* ═══════════ ADMIN PANEL (press F4) ═══════════ */
  const ADMIN_PIN = '1337';
  const ADMIN_KEY = 'neon-admin';

  function adminUnlocked() {
    try { return sessionStorage.getItem('yv_admin') === '1'; } catch (e) { return false; }
  }

  function buildAdminPanel() {
    if ($('#adminPanel')) return;
    const d = document.createElement('div');
    d.className = 'admin-overlay hide';
    d.id = 'adminPanel';
    d.innerHTML =
      '<div class="admin-box">'
      + '<div class="admin-head"><span>⚡ ADMIN PANEL <em class="admin-ver">v' + (window.YV_V || '?') + '</em></span><button class="admin-close" id="adminClose">✕</button></div>'
      + '<div class="admin-pin" id="adminPinRow">'
      + '<input type="password" id="adminPin" placeholder="PIN" maxlength="10">'
      + '<button class="pill-btn" id="adminUnlock">Unlock</button>'
      + '</div>'
      + '<div class="admin-body hide" id="adminBody">'
      + '<div class="field"><label>Video</label><select id="adminVideoSel"></select></div>'
      + '<div class="admin-grid">'
      + '<div class="admin-row"><input type="number" id="adminN_views" value="1000" min="0" max="1000000"><button class="pill-btn" data-admin="views">👁 + Views</button></div>'
      + '<div class="admin-row"><input type="number" id="adminN_likes" value="500" min="0" max="1000000"><button class="pill-btn" data-admin="likes">❤️ + Likes</button></div>'
      + '<div class="admin-row"><input type="number" id="adminN_subs" value="1000" min="0" max="10000000"><button class="pill-btn" data-admin="subs">🔔 + Subscribers</button></div>'
      + '<div class="admin-row"><input type="number" id="adminN_comments" value="100" min="1" max="500"><button class="pill-btn" data-admin="comments">💬 + Random comments</button></div>'
      + '<div class="admin-row"><input type="number" id="adminN_commentsru" value="100" min="1" max="500"><button class="pill-btn" data-admin="commentsru">🇷🇺 + Комменты (RU)</button></div>'
      + '<div class="admin-row"><input type="text" id="adminTransferTo" maxlength="50" placeholder="account / creator name"><button class="pill-btn" data-admin="transfer">📦 Transfer video to name</button></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">deletes the selected video or stream — files cleaned too</span><button class="pill-btn danger" data-admin="del-video">🗑 Delete video / stream</button></div>'
      + '<div class="admin-row"><input type="text" id="adminAnnText" maxlength="300" placeholder="📣 Announcement text (everyone sees it)"><button class="pill-btn" data-admin="announce">📣 Post</button></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">announcement shows as a banner on the site</span><button class="pill-btn danger" data-admin="announce-clear">🗑 Remove announcement</button></div>'
      + '<div class="admin-row"><input type="text" id="adminVerifyName" maxlength="50" placeholder="✔ creator name to verify"><button class="pill-btn" data-admin="verify">✔ Verify</button><button class="pill-btn danger" data-admin="unverify">✕ Unverify</button></div>'
      + '<div class="admin-row"><input type="text" id="adminColorName" maxlength="50" placeholder="creator name"><select id="adminColorSel"><option value="">no rank</option><option value="bronze">🥉 Bronze</option><option value="silver">🥈 Silver</option><option value="gold">🥇 Gold</option><option value="diamond">💎 Diamond</option><option value="ruby">🔴 Ruby</option><option value="emerald">💎 Emerald (50M)</option></select><button class="pill-btn" data-admin="setcolor">🎨 Set color</button></div>'
      + '<div class="admin-row"><input type="text" id="adminNotifText" maxlength="300" placeholder="🔔 Notification text (from YourVibe ✓)"><button class="pill-btn" data-admin="notify">🔔 Send</button></div>'
      + '<div class="admin-row"><input type="text" id="adminNotifTo" maxlength="50" placeholder="to account (empty = everyone)"><span class="muted-txt" style="align-self:center;font-size:13px">leave empty = send to all</span></div>'
      + '<div class="admin-row"><input type="number" id="adminChatRate" min="1" max="60" placeholder="sec between comments"><select id="adminChatLang"><option value="ru">🇷🇺 RU</option><option value="en">🇬🇧 EN</option><option value="mix">🌐 EN+RU</option></select><button class="pill-btn" data-admin="chat-on">💬 Chat ON</button><button class="pill-btn danger" data-admin="chat-off">💬 OFF</button></div>'
      + '<div class="admin-row"><input type="number" id="adminViewersN" value="500" min="1" max="100000"><button class="pill-btn" data-admin="live-viewers-plus">👁 + Зрители</button><button class="pill-btn danger" data-admin="live-viewers-minus">👁 − Зрители</button></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">± viewers on the CURRENT live stream</span></div>'
      + '<div class="admin-row"><select id="adminReactE"><option>😂</option><option>❤️</option><option>🔥</option><option>👏</option><option>😮</option><option>💯</option><option>🎉</option><option>👍</option></select><button class="pill-btn" data-admin="react-launch">🎈 Emoji rain</button></div>'
      + '<div class="admin-row"><input type="text" id="adminQuizQ" maxlength="150" placeholder="Quiz question"><input type="text" id="adminQuizO" maxlength="200" placeholder="opt1, opt2, opt3"><button class="pill-btn" data-admin="quiz-launch">❓ Quiz</button><button class="pill-btn danger" data-admin="quiz-stop">⏹ Stop quiz</button></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">clears every notification</span><button class="pill-btn danger" data-admin="notif-clear">🗑 Clear notifications</button></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">delete notifications one by one</span><button class="pill-btn" data-admin="notif-list">🔔 Notifications list</button></div>'
      + '<div class="admin-row" style="flex-direction:column;align-items:stretch"><div id="adminNotifList" class="adm-sup-list"><span class="muted-txt">Click “Notifications list” to load…</span></div></div>'
      + '<div class="admin-row span2"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">user problems arrive here as tickets — click one to open</span><button class="pill-btn" data-admin="support-open">📨 Load tickets</button></div>'
      + '<div class="admin-row span2"><input type="text" id="adminAiTopic" maxlength="120" placeholder="topic for AI (optional — e.g. live features)"><button class="pill-btn" data-admin="ai-ideas">🤖 AI ideas</button></div>'
      + '<div class="admin-row span2" style="flex-direction:column;align-items:stretch"><div id="adminAiOut" class="adm-sup-list"><span class="muted-txt">Click “🤖 AI ideas” — the AI will suggest what to build next</span></div></div>'
      + '<div class="span2" id="adminSupportRow">'
      + '<div id="adminTickets" class="adm-tickets"><span class="muted-txt">Click “Load tickets”…</span></div>'
      + '<div id="adminThreadView" class="hide">'
      + '<div class="adm-thread-head"><button class="pill-btn ghost" id="admThreadBack">←</button><b id="admThreadUser" style="flex:1;font-size:14px"></b><button class="pill-btn danger" data-admin="support-close">✅ Close problem</button></div>'
      + '<div id="admThreadMsgs" class="adm-sup-list"></div>'
      + '<div style="display:flex;gap:8px;margin-top:8px"><input type="hidden" id="adminSupportTo"><input type="text" id="adminSupportText" maxlength="500" placeholder="your reply — arrives in their 💬 panel"><button class="pill-btn" data-admin="support-reply">↩ Reply</button></div>'
      + '</div></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">create a poll for the selected video</span><button class="pill-btn" data-admin="poll">📊 Create poll</button></div>'
      + '</div>'
      + '<p class="muted-txt">Applies on the server — everyone sees it. Comments come from randomly generated accounts.</p>'
      + '</div></div>';
    document.body.appendChild(d);

    $('#adminClose').onclick = () => d.classList.add('hide');
    d.addEventListener('click', async e => {
      if (e.target === d) d.classList.add('hide');
      const tk = e.target.closest('[data-ticket]');
      if (tk) { openAdmThread(tk.dataset.ticket); return; }
      const nd = e.target.closest('[data-notif-del]');
      if (nd) {
        const id = Number(nd.dataset.notifDel);
        if (!id) return;
        try {
          await fetch(API_BASE + '/api/admin/notification/one', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY }, body: JSON.stringify({ id }) });
          toast('Notification deleted 🗑', '🔔');
          adminAction('notif-list');
        } catch (e2) { toast('Failed to delete', '⚠️'); }
        return;
      }
      const bk = e.target.closest('#admThreadBack');
      if (bk) {
        const tv = $('#adminThreadView'), cards = $('#adminTickets');
        if (tv) tv.classList.add('hide');
        if (cards) cards.classList.remove('hide');
      }
    });
    $('#adminUnlock').onclick = () => {
      if ($('#adminPin').value === ADMIN_PIN) {
        try { sessionStorage.setItem('yv_admin', '1'); } catch (e) {}
        $('#adminPinRow').classList.add('hide');
        $('#adminBody').classList.remove('hide');
        fillAdminVideos();
      } else toast('Wrong PIN 🚫', '🔒');
    };
    $('#adminPin').addEventListener('keydown', e => { if (e.key === 'Enter') $('#adminUnlock').click(); });
    d.addEventListener('click', e => {
      const b = e.target.closest('[data-admin]');
      if (b) adminAction(b.dataset.admin);
    });
  }

  function fillAdminVideos() {
    const sel = $('#adminVideoSel');
    if (!sel) return;
    sel.innerHTML = VIDEOS.length
      ? VIDEOS.map(v => '<option value="' + v.id + '">' + esc(v.title.slice(0, 45)) + ' — ' + esc(v.uploader) + '</option>').join('')
      : '<option value="">No videos yet</option>';
  }

  function toggleAdminPanel() {
    buildAdminPanel();
    const d = $('#adminPanel');
    d.classList.toggle('hide');
    if (!d.classList.contains('hide')) {
      const unlocked = adminUnlocked();
      $('#adminPinRow').classList.toggle('hide', unlocked);
      $('#adminBody').classList.toggle('hide', !unlocked);
      if (unlocked) fillAdminVideos();
      else { const p = $('#adminPin'); p.value = ''; p.focus(); }
    }
  }

  let SUPPORT_ALL = [];
  function admTicketsHTML(all) {
    const byUser = {};
    all.forEach(m => { if (!m.from_admin) (byUser[m.username] = byUser[m.username] || []).push(m); });
    const users = Object.keys(byUser);
    if (!users.length) return '<span class="muted-txt">No open problems 🎉 — users write via the 💬 button in the header.</span>';
    return users.map(u => {
      const msgs = byUser[u];
      const last = msgs[msgs.length - 1];
      const preview = (last.text || '').slice(0, 44);
      return '<button class="adm-ticket" data-ticket="' + esc(u) + '">🎟 <b>' + esc(u) + '</b> — ' + esc(preview)
        + '<span class="muted-txt" style="margin-left:auto;white-space:nowrap">' + msgs.length + ' msg · ' + (last.created_at ? timeAgo(Date.parse(last.created_at)) : '') + '</span></button>';
    }).join('');
  }
  function admThreadHTML(list) {
    if (!list.length) return '<span class="muted-txt">Thread is empty.</span>';
    return list.slice().reverse().map(m =>
      '<div class="adm-sup">' + (m.from_admin
        ? '<b style="color:#39ff88">↩ admin</b>: '
        : m.ai
        ? '<b style="color:#7c9cff">🤖 AI</b>: '
        : '<b>' + esc(m.username) + '</b>: ')
      + esc(m.text) + ' <span class="muted-txt">· ' + (m.created_at ? timeAgo(Date.parse(m.created_at)) : '') + '</span></div>'
    ).join('');
  }
  function openAdmThread(u) {
    const tv = $('#adminThreadView'), cards = $('#adminTickets');
    if (!tv || !cards) return;
    const list = SUPPORT_ALL.filter(m => m.username === u);
    const head = $('#admThreadUser'); if (head) head.textContent = u;
    const msgs = $('#admThreadMsgs'); if (msgs) { msgs.innerHTML = admThreadHTML(list); msgs.scrollTop = msgs.scrollHeight; }
    const to = $('#adminSupportTo'); if (to) to.value = u;
    const tx = $('#adminSupportText'); if (tx) { tx.value = ''; setTimeout(() => tx.focus(), 100); }
    cards.classList.add('hide');
    tv.classList.remove('hide');
  }
  async function adminAction(kind) {
    if (kind === 'support-open') {
      try {
        const r = await fetch(API_BASE + '/api/support/all', { headers: { 'X-Admin-Key': ADMIN_KEY } });
        SUPPORT_ALL = await r.json();
        const el = $('#adminTickets');
        if (el) el.innerHTML = admTicketsHTML(SUPPORT_ALL);
      } catch (e) { toast('Failed to load tickets', '⚠️'); }
      return;
    }
    if (kind === 'support-reply') {
      const to = ($('#adminSupportTo') && $('#adminSupportTo').value || '').trim();
      const text = ($('#adminSupportText') && $('#adminSupportText').value || '').trim();
      if (!to || !text) { toast('Write a reply first', '⚠️'); return; }
      try {
        await api('/api/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: to, text, fromAdmin: true }) });
        const tx = $('#adminSupportText'); if (tx) tx.value = '';
        toast('Reply sent to ' + to + ' 💌', '↩');
        const r2 = await fetch(API_BASE + '/api/support/all', { headers: { 'X-Admin-Key': ADMIN_KEY } });
        SUPPORT_ALL = await r2.json();
        openAdmThread(to);
        const cards = $('#adminTickets');
        if (cards) cards.innerHTML = admTicketsHTML(SUPPORT_ALL);
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'support-close') {
      const to = ($('#adminSupportTo') && $('#adminSupportTo').value || '').trim();
      if (!to) { toast('No ticket is open', '⚠️'); return; }
      try {
        await fetch(API_BASE + '/api/support?user=' + encodeURIComponent(to), { method: 'DELETE', headers: { 'X-Admin-Key': ADMIN_KEY } });
        toast('Problem closed — chat cleared for both sides ✅', '✅');
        const tv = $('#adminThreadView'), cards = $('#adminTickets');
        if (tv) tv.classList.add('hide');
        const r2 = await fetch(API_BASE + '/api/support/all', { headers: { 'X-Admin-Key': ADMIN_KEY } });
        SUPPORT_ALL = await r2.json();
        if (cards) { cards.innerHTML = admTicketsHTML(SUPPORT_ALL); cards.classList.remove('hide'); }
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'del-video') {
      const sel = $('#adminVideoSel');
      const id = sel && sel.value;
      if (!id) { toast('Select a video first', '⚠️'); return; }
      const label = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent || '').slice(0, 60);
      if (!confirm('Delete «' + label + '» permanently?\nComments, likes and its files will be removed too.')) return;
      try {
        const r = await fetch(API_BASE + '/api/videos/' + id, { method: 'DELETE', headers: { 'X-Admin-Key': ADMIN_KEY } });
        if (r.status === 204 || r.ok) {
          toast('Deleted: ' + label + ' 🗑', '✅');
          try { await loadVideos(); } catch (e) {}
          fillAdminVideos();
        } else toast('Delete failed (' + r.status + ')', '⚠️');
      } catch (e) { toast('Delete failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'notif-list') {
      try {
        const r = await fetch(API_BASE + '/api/admin/notifications', { headers: { 'X-Admin-Key': ADMIN_KEY } });
        const list = await r.json();
        const el = $('#adminNotifList');
        if (el) {
          el.innerHTML = list.length ? list.map(n =>
            '<div class="adm-notif"><span style="flex:1">' + esc(n.text) + (n.target ? ' <span class="muted-txt">→ ' + esc(n.target) + '</span>' : '') + '</span>'
            + '<button class="pill-btn danger" data-notif-del="' + n.id + '" style="padding:1px 9px;font-size:11px">✕</button></div>'
          ).join('') : '<span class="muted-txt">No notifications 🎉</span>';
        }
      } catch (e) { toast('Failed to load notifications', '⚠️'); }
      return;
    }
    if (kind === 'chat-on' || kind === 'chat-off') {
      const rate = parseInt($('#adminChatRate') && $('#adminChatRate').value, 10) || 4;
      const lang = ($('#adminChatLang') && $('#adminChatLang').value) || 'ru';
      const enabled = kind === 'chat-on';
      try {
        const r = await api('/api/admin/live/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ enabled, rateSec: enabled ? rate : 4, lang })
        });
        toast(enabled ? 'Fake live chat ON — ' + ({ ru: '🇷🇺 RU', en: '🇬🇧 EN', mix: '🌐 EN+RU' }[lang] || lang) + ' — 1 comment / ' + r.rateSec + 's 💬' : 'Fake live chat OFF', '💬');
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'quiz-launch') {
      const q = ($('#adminQuizQ') && $('#adminQuizQ').value || '').trim();
      const options = ($('#adminQuizO') && $('#adminQuizO').value || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!q || options.length < 2) { toast('Question + 2 options needed', '⚠️'); return; }
      try {
        const r = await fetch(API_BASE + '/api/admin/live/quiz', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY }, body: JSON.stringify({ q, options }) });
        if (r.status === 404) { toast('No live stream running 📡', '⚠️'); return; }
        toast('Quiz launched on the live stream ❓', '❓');
      } catch (e2) { toast('Failed', '⚠️'); }
      return;
    }
    if (kind === 'quiz-stop') {
      try { await fetch(API_BASE + '/api/admin/live/quiz', { method: 'DELETE', headers: { 'X-Admin-Key': ADMIN_KEY } }); toast('Quiz stopped ⏹', '❓'); } catch (e2) {}
      return;
    }
    if (kind === 'ai-ideas') {
      const topic = ($('#adminAiTopic') && $('#adminAiTopic').value || '').trim();
      const out = $('#adminAiOut');
      if (out) out.innerHTML = '<span class="muted-txt">🤖 Thinking…</span>';
      try {
        const r = await fetch(API_BASE + '/api/admin/ai/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY }, body: JSON.stringify({ topic }) });
        const j = await r.json();
        if (out) out.innerHTML = j.text ? '<div class="ai-ideas">' + esc(j.text).replace(/\n/g, '<br>') + '</div>' : '<span class="muted-txt">AI returned nothing</span>';
      } catch (e2) {
        const msg = e2.message || 'failed';
        if (out) out.innerHTML = '<span class="muted-txt">🤖 AI error: ' + esc(msg) + '</span>';
        toast('AI error — check the API key/balance', '⚠️');
      }
      return;
    }
    if (kind === 'react-launch') {
      const e2 = ($('#adminReactE') && $('#adminReactE').value) || '😂';
      try {
        const r = await fetch(API_BASE + '/api/admin/live/react', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY }, body: JSON.stringify({ emoji: e2 }) });
        if (r.status === 404) { toast('No live stream running 📡', '⚠️'); return; }
        toast('🎈 ' + e2 + ' rain launched on the live stream', '🎈');
      } catch (e3) { toast('Failed', '⚠️'); }
      return;
    }
    if (kind === 'live-viewers-plus' || kind === 'live-viewers-minus') {
      const n = Math.abs(parseInt($('#adminViewersN') && $('#adminViewersN').value, 10) || 0);
      if (!n) { toast('Set a viewers number first', '⚠️'); return; }
      const delta = kind === 'live-viewers-plus' ? n : -n;
      try {
        const r = await fetch(API_BASE + '/api/admin/live/viewers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ delta })
        });
        if (r.status === 404) { toast('No live stream running right now 📡', '⚠️'); return; }
        const j = await r.json();
        toast((delta > 0 ? '+' : '−') + n + ' viewers → «' + String(j.title || '').slice(0, 28) + '» (boost ' + (j.boost > 0 ? '+' : '') + j.boost + ') 👁', '👁');
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'setcolor') {
      const name = ($('#adminColorName') && $('#adminColorName').value || '').trim();
      const color = ($('#adminColorSel') && $('#adminColorSel').value || '').trim();
      if (!name) { toast('Enter the creator name', '⚠️'); return; }
      try {
        await api('/api/admin/creator/color', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ name, color })
        });
        await loadVideos();
        toast('Color set for ' + name + ' 🎨', '✅');
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'verify' || kind === 'unverify') {
      const name = ($('#adminVerifyName') && $('#adminVerifyName').value || '').trim();
      if (!name) { toast('Enter the creator name', '⚠️'); return; }
      try {
        await api('/api/admin/creator/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ name, verified: kind === 'verify' })
        });
        await loadVideos();
        toast(name + (kind === 'verify' ? ' is now verified ✔' : ' unverified'), '✔');
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'notify') {
      const text = ($('#adminNotifText') && $('#adminNotifText').value || '').trim();
      const to = ($('#adminNotifTo') && $('#adminNotifTo').value || '').trim();
      if (!text) { toast('Enter notification text', '⚠️'); return; }
      try {
        await api('/api/admin/notification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ text, to: to || null })
        });
        await loadVideos();
        toast('Notification sent 🔔', '✅');
        $('#adminNotifText').value = '';
        $('#adminNotifTo').value = '';
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'notif-clear') {
      try {
        await api('/api/admin/notification', { method: 'DELETE', headers: { 'X-Admin-Key': ADMIN_KEY } });
        await loadVideos();
        toast('Notifications cleared', '🗑');
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'announce') {
      const text = ($('#adminAnnText') && $('#adminAnnText').value || '').trim();
      if (!text) { toast('Enter announcement text', '⚠️'); return; }
      try {
        await api('/api/admin/announcement', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ text })
        });
        await loadAnnouncement();
        toast('Announcement posted 📣', '✅');
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }
    if (kind === 'announce-clear') {
      try {
        await api('/api/admin/announcement', { method: 'DELETE', headers: { 'X-Admin-Key': ADMIN_KEY } });
        await loadAnnouncement();
        toast('Announcement removed', '🗑');
      } catch (e) { toast('Failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }

    if (kind === 'poll') {
      if (!id) { toast('No video selected', '⚠️'); return; }
      $('#adminPanel').classList.add('hide');
      openPollModal(id);
      return;
    }

    const id = $('#adminVideoSel') && $('#adminVideoSel').value;
    if (!id) { toast('No video selected', '⚠️'); return; }

    if (kind === 'transfer') {
      const to = ($('#adminTransferTo') && $('#adminTransferTo').value || '').trim();
      if (!to) { toast('Enter the account name to transfer to', '⚠️'); return; }
      if (!confirm('Transfer this video to "' + to + '"?')) return;
      try {
        await api('/api/admin/video/' + id + '/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ to })
        });
        await loadVideos();
        toast('Video transferred to ' + to + ' ✅', '📦');
        navigate();
      } catch (e) { toast('Transfer failed: ' + (e.message || 'error'), '⚠️'); }
      return;
    }

    const input = $('#adminN_' + kind);
    let n = parseInt(input && input.value, 10);
    if (!Number.isFinite(n) || n < 0) { toast('Enter a number', '⚠️'); return; }
    const endpoint = kind === 'commentsru' ? 'comments' : kind;
    if (kind === 'comments' || kind === 'commentsru') n = Math.min(500, Math.max(1, n));
    else n = Math.min(10000000, Math.max(0, n));

    const label = { views: 'views', likes: 'likes', subs: 'subscribers', comments: 'comments', commentsru: 'русских комментов' }[kind];
    toast('Adding ' + n + ' ' + label + '…', '⏳');
    try {
      await api('/api/admin/video/' + id + '/' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify(kind === 'commentsru' ? { n, lang: 'ru' } : { n })
      });
      await loadVideos();
      toast('Done — ' + n + ' ' + label + ' added ✅', '⚡');
      navigate();
    } catch (e) {
      toast('Failed: ' + (e.message || 'error'), '⚠️');
    }
  }

  window.addEventListener('keydown', e => {
    if (e.key === 'F4') { e.preventDefault(); toggleAdminPanel(); }
  });

  /* ═══════════ global events ═══════════ */
  document.addEventListener('click', async e => {
    const sv = e.target.closest('.short video');
    if (sv) { sv.paused ? sv.play().catch(() => {}) : sv.pause(); return; }

    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action, id = t.dataset.id;

    if (a === 'retry') { videosLoaded = false; navigate(); }
    else if (a === 'logout') {
      api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      S.auth = null;
      YV.store.save();
      renderMe();
      toast('Logged out', '👋');
      location.hash = '#/home';
    }
    else if (a === 'like') { const lr = t.getBoundingClientRect(); spawnHearts(lr.x + lr.width / 2, lr.y + 6); toggleLike(id); }
    else if (a === 'short-comments') { e.preventDefault(); openShortComments(id); }
    else if (a === 'pl-add') { e.preventDefault(); plAddFlow(id); }
    else if (a === 'subs-edit') { e.preventDefault(); subsEditor(id); }
    else if (a === 'stats-view') { e.preventDefault(); statsModal(id); }
    else if (a === 'collab-invite') {
      e.preventDefault();
      const who = prompt('Invite co-creator (exact username):');
      if (!who) return;
      try {
        await api('/api/videos/' + id + '/collab-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creator: who.trim() }) });
        toast('Invite sent 👥 — they accept in Library', '✅');
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
    }
    else if (a === 'vid-settings') { e.preventDefault(); videoSettingsFlow(id); }
    else if (a === 'dm-open') {
      e.preventDefault();
      if (!(S.auth && S.auth.token)) { toast('Log in to use messages 🔒', '🔒'); return; }
      await openDmPanel();
      if (t.dataset.ch) await openDmThread(t.dataset.ch);
    }
    else if (a === 'dislike') toggleDislike(id);
    else if (a === 'sub') toggleSub(t.dataset.ch);
    else if (a === 'share') doShare(id);
    else if (a === 'del') doDelete(id);
    else if (a === 'addpoll') createPollFlow(id);
    else if (a === 'later') { e.preventDefault(); toggleLater(id); }
    else if (a === 'mute-shorts') {
      shortsMuted = !shortsMuted;
      $$('.shorts-feed video').forEach(v => v.muted = shortsMuted);
      $$('.mute-btn .ric').forEach(r => r.textContent = shortsMuted ? '🔇' : '🔊');
      toast(shortsMuted ? 'Sound off' : 'Sound on', shortsMuted ? '🔇' : '🔊');
    }
    else if (a === 'clear-history') {
      if (!confirm('Clear all watch history?')) return;
      S.history = []; YV.store.save(); toast('History cleared', '🧹'); navigate();
    }
    else if (a === 'reset-all') {
      if (!confirm('Reset ALL local YourVibe data? (server videos stay)')) return;
      try { localStorage.removeItem(YV.store.LS_KEY); } catch (e2) {}
      location.reload();
    }
    else if (a === 'tab') {
      const scope = t.closest('[data-scope]');
      $$('.tab-btn', scope).forEach(b => b.classList.toggle('on', b === t));
      $$('.tab-panel', scope).forEach(p => p.classList.toggle('hide', p.dataset.panel !== t.dataset.tab));
    }
  });

  document.addEventListener('submit', async e => {
    const f = e.target;
    if (f.id === 'searchForm') {
      e.preventDefault();
      const q = $('#searchInput').value.trim();
      if (q) location.hash = '#/results?q=' + encodeURIComponent(q);
    }
    else if (f.dataset.form === 'comment') {
      e.preventDefault();
      const input = f.querySelector('input[name="ctext"]');
      const text = input.value.trim();
      if (!text) return;
      const vid = f.dataset.id;
      input.value = '';
      try {
        const c = await api('/api/videos/' + vid + '/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author: myName(), text })
        });
        const list = $('#cList');
        if (list) {
          const empty = list.querySelector('.muted-txt'); if (empty) empty.remove();
          list.insertAdjacentHTML('afterbegin', cItemHTML(c));
        }
        const head = $('#cHead');
        if (head && list) head.textContent = fmtNum(list.querySelectorAll('.c-item').length) + ' Comments';
        toast('Comment posted', '💬');
      } catch (ex) {
        toast('Comment failed — server unreachable', '⚠️');
        input.value = text;
      }
    }
  });

  /* ═══════════ LIVE STREAMING (v2 — broadcast follows you on any page) ═══════════ */
  let livePeer = null;        // PeerJS host peer
  let liveCalls = new Set();  // active viewer connections
  let liveRecorder = null;
  let liveStreamId = null;
  let liveChunksSent = 0;
  let liveTimer = null;
  let liveEnding = false;
  let liveMime = '';
  let liveRawStream = null;
  let mixRef = null;
  let micSilentSecs = 0;

  function pickMime() {
    const cands = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
    for (const m of cands) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; }
    return '';
  }

  /* measure a captured audio track: does it produce ANY signal? */
  async function micAlive(ms) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      await ctx.resume().catch(() => {});
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(ms).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let peak = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 1200) {
        an.getByteTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - 128) / 128; if (d > peak) peak = d; }
        await new Promise(r => setTimeout(r, 90));
      }
      try { ctx.close().catch(() => {}); } catch (e) {}
      return peak; // caller decides the threshold
    } catch (e) { return null; } // cannot measure → accept the device
  }

  /* "Allow" is not enough — the OS default input can be disconnected or busy.
     Probe the default device first, then every enumerated audio input;
     keep the first one that produces real signal; fall back to the first that opened. */
  async function getWorkingMic() {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const attempts = [null].concat(inputs.map(d => ({ deviceId: { exact: d.deviceId } })));
    let fallback = null;
    for (const c of attempts) {
      let ms = null;
      try {
        ms = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ echoCancellation: true, noiseSuppression: true }, c || {}) });
      } catch (e) { continue; } // busy/absent → next device
      const track = ms.getAudioTracks()[0];
      if (!track) continue;
      if (!fallback) fallback = ms;
      const peak = await micAlive(ms);
      if (peak === null || peak >= 0.0015) return ms; // alive (or unmeasurable)
      try { track.stop(); } catch (e) {} // dead device → try the next one
    }
    return fallback; // nothing measured alive — use whatever opened
  }

  /* floating control bar — lives on document.body, survives any navigation */
  function buildLiveBar(title) {
    removeLiveBar();
    const bar = document.createElement('div');
    bar.id = 'liveBar';
    bar.innerHTML = '<span class="lb-badge"><span class="live-dot"></span>LIVE</span>'
      + '<span class="lb-title">' + esc(title) + '</span>'
      + '<span class="lb-stat" id="lbTime">0:00</span>'
      + '<span class="lb-stat" id="lbSegs">0 segs</span>'
      + '<span class="lb-stat" id="lbMic">🎙 —</span>'
      + '<span class="lb-stat" id="lbViewers">👁 …</span>'
      + '<button class="lb-btn" id="lbGuest" title="Copy co-host invite link">👥</button>'
      + '<button class="lb-btn" id="lbQuiz" title="Launch a quiz for viewers">❓</button>'
      + '<button class="lb-end" id="lbEnd">⏹ End stream</button>';
    document.body.appendChild(bar);
    return bar;
  }
  function removeLiveBar() { const b = document.getElementById('liveBar'); if (b) b.remove(); }

  /* mix ALL audio tracks (mic + screen) into ONE track via WebAudio with gain —
     guarantees the mic is audible even when a silent tab-audio track exists
     (Chrome's MediaRecorder alone can favor the first, silent track) */
  async function buildMixedStream(stream) {
    const vTracks = stream.getVideoTracks();
    const aTracks = stream.getAudioTracks();
    if (!aTracks.length) return stream;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      await ctx.resume().catch(() => {});
      const dest = ctx.createMediaStreamDestination();
      let analyser = null;
      aTracks.forEach(t => {
        try {
          const src = ctx.createMediaStreamSource(new MediaStream([t]));
          const g = ctx.createGain();
          g.gain.value = 1.6;
          src.connect(g);
          g.connect(dest);
          if (!analyser) { analyser = ctx.createAnalyser(); analyser.fftSize = 512; g.connect(analyser); }
        } catch (e) {}
      });
      mixRef = { ctx, dest, analyser };
      const out = new MediaStream([...vTracks, ...dest.stream.getAudioTracks()]);
      return out;
    } catch (e) { return stream; }
  }

  async function startBroadcast(stream, title, thumb, mime) {
    const r = await api('/api/live/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, thumb, mime }) });
    liveStreamId = r.id; liveChunksSent = 0; liveEnding = false;
    UPLOADING = true; // block auto-update reloads while broadcasting

    buildLiveBar(title);
    const btn = $('#lbEnd');
    btn.onclick = () => endBroadcast();
    const gbtn = $('#lbGuest');
    if (gbtn) gbtn.onclick = async () => {
      try {
        const gl = await api('/api/live/' + liveStreamId + '/guest-link');
        try { await navigator.clipboard.writeText(gl.url); toast('Co-host link copied — send it to your guest 👥', '📋'); }
        catch (e) { prompt('Co-host link — send it to your guest:', gl.url); }
      } catch (e) { toast(e.message || 'failed', '⚠️'); }
    };
    const qbtn = $('#lbQuiz');
    if (qbtn) qbtn.onclick = async () => {
      const q = prompt('Quiz question for viewers:');
      if (!q) return;
      const opts = prompt('Options, comma-separated:', 'Yes,No').split(',').map(x => x.trim()).filter(Boolean);
      if (opts.length < 2) { toast('2+ options needed', '⚠️'); return; }
      try {
        await api('/api/live/' + liveStreamId + '/quiz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, options: opts }) });
        toast('Quiz launched ❓ — viewers see it in chat', '❓');
      } catch (e) { toast(e.message || 'failed', '⚠️'); }
    };

    let secs = 0;
    liveTimer = setInterval(async () => {
      secs++;
      const tm = $('#lbTime'), sg = $('#lbSegs'), vw = $('#lbViewers');
      if (tm) tm.textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
      try {
        const pl = await api('/api/live/' + liveStreamId + '/playlist');
        if (sg) sg.textContent = (pl.segs || []).length + ' segs';
        if (vw) vw.textContent = '👁 ' + (pl.viewers || 0).toLocaleString('en-US') + ' watching';
      } catch (e) {}
      /* mic level meter + silence alarm */
      const micEl = $('#lbMic');
      if (micEl) {
        if (mixRef && mixRef.analyser) {
          const buf = new Uint8Array(mixRef.analyser.fftSize);
          mixRef.analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
          const rms = Math.sqrt(sum / buf.length);
          const lvl = Math.min(6, Math.ceil(rms * 16));
          micEl.textContent = '🎙 ' + (lvl ? '▮'.repeat(lvl) : '—');
          micEl.style.color = lvl ? '' : '#ff5a78';
          if (rms < 0.01) {
            micSilentSecs++;
            if (micSilentSecs === 8) toast('Микрофон молчит! Проверь устройство ввода в системе 🎙⚠️', '🔇');
          } else micSilentSecs = 0;
        } else micEl.textContent = '🎙 off';
      }
    }, 1000);

    /* recorder: 3s segments → CDN via the API (retries, timeouts).
       audio = WebAudio mix of mic + screen audio (gain 1.6) — mic never lost */
    const recStream = await buildMixedStream(stream);
    liveRecorder = new MediaRecorder(recStream, { mimeType: mime, videoBitsPerSecond: 2500000 });
    liveRecorder.ondataavailable = async e => {
      if (!e.data || !e.data.size || !liveStreamId) return;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const ctrl = new AbortController();
        const killer = setTimeout(() => ctrl.abort(), 20000);
        try {
          const rr = await fetch(API_BASE + '/api/live/' + liveStreamId + '/seg', {
            method: 'POST',
            headers: { 'X-Auth': (S.auth && S.auth.token) || '', 'Content-Type': 'application/octet-stream' },
            body: e.data, signal: ctrl.signal
          });
          clearTimeout(killer);
          if (rr.status === 200) { liveChunksSent++; break; }
          if (rr.status === 410) { clearTimeout(killer); break; }
        } catch (e2) { clearTimeout(killer); }
        if (attempt < 3) await new Promise(rr => setTimeout(rr, 1500));
      }
      const sg = document.getElementById('lbSegs');
      if (sg) sg.textContent = liveChunksSent + ' segs';
    };
    /* auto-subtitles: Web Speech capture during the broadcast */
    let subsRows = [];
    try {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const subCb = document.querySelector('#liveSubs');
      if (SR && subCb && subCb.checked) {
        const rec2 = new SR();
        rec2.lang = (document.querySelector('#liveSubLang') || {}).value || 'ru-RU';
        rec2.continuous = true; rec2.interimResults = false;
        const t0 = Date.now();
        rec2.onresult = e => { for (const rr of e.results) { if (rr.isFinal) { const txt2 = rr[0].transcript.trim(); if (txt2) subsRows.push({ t: Math.round((Date.now() - t0) / 1000), text: txt2.slice(0, 140) }); } } };
        rec2.onend = () => { try { if (!liveEnding && rec2) rec2.start(); } catch (e) {} };
        rec2.start();
        window._subsRec = rec2; window._subsRows = subsRows;
        toast('Auto-subtitles ON (' + rec2.lang + ') 🗣', '📝');
      }
    } catch (e) {}
    /* capture surface dies → end cleanly */
    const vTrack = stream.getVideoTracks()[0];
    if (vTrack) vTrack.addEventListener('ended', () => { if (liveStreamId) endBroadcast(); });
    liveRecorder.start(3000);
  }

  async function endBroadcast() {
    if (liveEnding || !liveStreamId) return;
    liveEnding = true;
    const sid = liveStreamId;
    const btn = document.getElementById('lbEnd');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Ending…'; }
    try { if (liveRecorder && liveRecorder.state !== 'inactive') { liveRecorder.stop(); await new Promise(r => setTimeout(r, 1500)); } } catch (e) {}
    if (liveRawStream) { try { liveRawStream.getTracks().forEach(tr => tr.stop()); } catch (e) {} }
    try {
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), 8000);
      await fetch(API_BASE + '/api/live/' + sid + '/end', { method: 'POST', headers: { 'X-Auth': (S.auth && S.auth.token) || '', 'Content-Type': 'application/json' }, body: JSON.stringify({ subs: window._subsRows || [] }), signal: ctrl.signal });
      clearTimeout(killer);
    } catch (e) { /* server auto-ends after 45s without segments */ }
    toast('Stream ended', '🔴');
    try { if (window._subsRec) { try { window._subsRec.onend = null; window._subsRec.stop(); } catch (e) {} } window._subsRec = null; window._subsRows = []; } catch (e) {}
    try { if (mixRef && mixRef.ctx) mixRef.ctx.close().catch(() => {}); } catch (e) {}
    mixRef = null; micSilentSecs = 0;
    liveRecorder = null; liveStreamId = null; liveRawStream = null; UPLOADING = false;
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    removeLiveBar();
  }

  /* GO LIVE page: choose screen or camera, pick thumbnail, start */
  function viewGoLive() {
    if (!S.auth || !S.auth.token) {
      main.innerHTML = '<div class="page"><div class="auth-card"><h1 class="page-title">Go Live</h1>'
        + '<p class="muted-txt">Log in to start a live stream.</p>'
        + '<a class="btn-neon" href="#/login" style="justify-content:center">Log in</a></div></div>';
      return;
    }
    if (liveStreamId) {
      main.innerHTML = '<div class="page"><div class="empty"><div class="empty-ico">🔴</div><h3>You are LIVE right now</h3>'
        + '<p class="muted-txt">Use the red control bar at the bottom of the screen to end the stream — it stays there on every page.</p></div></div>';
      return;
    }
    const mime = pickMime();
    if (!mime) {
      main.innerHTML = '<div class="page"><div class="empty"><div class="empty-ico">🔴</div><h3>Not supported</h3><p>Your browser can\'t record live video.</p></div></div>';
      return;
    }
    main.innerHTML = '<div class="page live-page">'
      + '<h1 class="page-title">Go Live 🔴</h1>'
      + '<p class="muted-txt">Broadcast your screen or camera — viewers watch with a ~10 second delay. The red control bar follows you on every page.</p>'
      + '<p class="muted-txt" style="color:#f2d98c">💡 Tip: in the share dialog choose <b>Entire Screen</b> — then Roblox and every app get captured too.</p>'
      + '<div class="up-grid">'
      + '<div class="live-preview"><video id="livePrev" muted playsinline autoplay></video><div class="live-off" id="liveOff">Preview off</div></div>'
      + '<form class="up-form" id="liveForm">'
      + '<div class="field"><label>Stream title</label><input id="liveTitle" maxlength="80" placeholder="' + esc(myName()) + ' is live!"></div>'
      + '<div class="field"><label>Source</label><div class="radio-row">'
      + '<label class="rd"><input type="radio" name="liveSrc" value="screen" checked> 🖥️ Screen</label>'
      + '<label class="rd"><input type="radio" name="liveSrc" value="camera"> 📷 Camera</label>'
      + '<label class="rd"><input type="checkbox" id="liveMic" checked> 🎙 Mic sound</label>'
      + '<label class="rd"><input type="checkbox" id="liveSubs"> 🗣 Subtitles</label>'
      + '<select id="liveSubLang" class="mini-select"><option value="ru-RU">RU</option><option value="en-US">EN</option></select>'
      + '</div></div>'
      + '<div class="field"><label>🖼 Virtual backdrop</label><div class="field-row">'
      + '<select id="bgSel" class="mini-select"><option value="">None</option><option value="c:#0a0e2a">Dark navy</option><option value="g">Neon gradient</option><option value="c:#101010">Studio black</option><option value="i">🖼 Image…</option></select>'
      + '<input type="file" id="bgImg" accept="image/*" hidden>'
      + '</div><p class="muted-txt" id="bgHint">your camera gets composited over the backdrop — records into the stream</p></div>'
      + '</div></div>'
      + '<div class="field"><label>Thumbnail</label>'
      + '<div class="file-row"><button type="button" class="pill-btn ghost" id="thumbCapBtn">📷 Capture frame</button>'
      + '<button type="button" class="pill-btn ghost" id="thumbUpBtn">🖼 Upload image</button>'
      + '<input type="file" id="thumbUpIn" accept="image/*" hidden></div>'
      + '<div class="thumb-preview hide" id="thumbPreviewWrap"><img id="thumbPreviewBox" style="width:220px;border-radius:10px" alt=""></div>'
      + '</div>'
      + '<div class="form-err" id="liveErr"></div>'
      + '<button class="btn-neon live-btn" id="liveStart" type="button">🔴 Go Live</button>'
      + '</form></div></div>';

    let liveThumb = null;
    const showThumbPreview = dataUrl => {
      liveThumb = dataUrl;
      const w = document.querySelector('#thumbPreviewWrap');
      const box = document.querySelector('#thumbPreviewBox');
      if (w && box) { w.classList.remove('hide'); box.src = dataUrl; }
    };

    $('#thumbCapBtn').onclick = async () => {
      const pv = $('#livePrev');
      if (!pv || !pv.srcObject) { toast('Start the preview first — pick screen or camera', '📷'); return; }
      try {
        const cv = document.createElement('canvas');
        cv.width = 640; cv.height = 360;
        cv.getContext('2d').drawImage(pv, 0, 0, 640, 360);
        showThumbPreview(cv.toDataURL('image/jpeg', 0.8));
        toast('Thumbnail captured 📷', '✅');
      } catch (e) { toast('Capture failed', '⚠️'); }
    };
    $('#thumbUpBtn').onclick = () => $('#thumbUpIn').click();
    $('#thumbUpIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { showThumbPreview(await imageToDataURL(f, 640, 360)); toast('Thumbnail set 🖼️', '✅'); } catch (err) { toast('Could not read image', '⚠️'); }
    };

    $('#liveStart').onclick = async () => {
      const btn = $('#liveStart');
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = '⏳ Starting…';
      const src = document.querySelector('input[name="liveSrc"]:checked').value;
      $('#liveErr').textContent = '';
      let stream;
      try {
        if (src === 'screen') stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        else stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280 } });
      } catch (e) {
        $('#liveErr').textContent = '⚠️ ' + (e.name === 'NotAllowedError' ? 'permission denied' : e.message);
        btn.disabled = false; btn.textContent = '🔴 Go Live';
        return;
      }
      /* virtual backdrop: composite the camera over a backdrop via canvas */
      const bgMode = (document.querySelector('#bgSel') || {}).value || '';
      if (bgMode) {
        try {
          const vTrack0 = stream.getVideoTracks()[0];
          if (vTrack0) {
            const camV = document.createElement('video');
            camV.srcObject = new MediaStream([vTrack0]);
            camV.muted = true; camV.playsInline = true;
            camV.play().catch(() => {});
            const cv = document.createElement('canvas');
            cv.width = 1280; cv.height = 720;
            const cx = cv.getContext('2d');
            const bgIm = window._bgImg;
            const drawLoop = () => {
              try {
                if (bgIm) {
                  const sc = Math.max(cv.width / bgIm.width, cv.height / bgIm.height);
                  const w = bgIm.width * sc, hh = bgIm.height * sc;
                  cx.drawImage(bgIm, (cv.width - w) / 2, (cv.height - hh) / 2, w, hh);
                } else if (bgMode === 'g') {
                  const gr = cx.createLinearGradient(0, 0, cv.width, cv.height);
                  gr.addColorStop(0, '#ff2bd6'); gr.addColorStop(1, '#00e5ff');
                  cx.fillStyle = gr; cx.fillRect(0, 0, cv.width, cv.height);
                } else {
                  cx.fillStyle = bgMode.replace('c:', '') || '#0a0e2a';
                  cx.fillRect(0, 0, cv.width, cv.height);
                }
                const vw = camV.videoWidth, vh = camV.videoHeight;
                if (vw && vh) {
                  const h = cv.height - 60, w = vw * h / vh;
                  const x = (cv.width - w) / 2, y = 30;
                  cx.save();
                  cx.strokeStyle = 'rgba(0, 229, 255, .8)'; cx.lineWidth = 4;
                  cx.beginPath();
                  if (cx.roundRect) cx.roundRect(x, y, w, h, 18); else cx.rect(x, y, w, h);
                  cx.stroke();
                  cx.clip();
                  cx.drawImage(camV, x, y, w, h);
                  cx.restore();
                }
              } catch (x) {}
              requestAnimationFrame(drawLoop);
            };
            drawLoop();
            const compTrack = cv.captureStream(30).getVideoTracks()[0];
            stream.removeTrack(vTrack0);
            stream.addTrack(compTrack);
            bgHint.textContent = '🖼 backdrop is ON — it records into the stream';
          }
        } catch (e) { bgHint.textContent = '⚠️ backdrop failed: ' + (e.message || e); }
      }

      liveRawStream = stream;

      /* mic: "allow" is not enough — the OS default input may be disconnected.
         probe every audio input, keep one that actually produces signal */
      const wantMic = !(document.querySelector('#liveMic') && !document.querySelector('#liveMic').checked);
      if (wantMic) {
        const mic = await getWorkingMic();
        if (mic) {
          mic.getAudioTracks().forEach(at => stream.addTrack(at));
          toast('Микрофон подключен — уровень виден на баре 🎙', '🎤');
        } else {
          toast('Микрофон не найден или молчит — проверь устройство ввода в системе ⚠️', '🔇');
        }
      }

      const title = ($('#liveTitle').value || '').trim() || (myName() + ' is live');

      /* thumbnail: chosen one wins, otherwise capture a frame from the preview */
      let thumb = liveThumb;
      if (!thumb) {
        const pv2 = $('#livePrev');
        await new Promise(r => setTimeout(r, 1200));
        try {
          const cv = document.createElement('canvas');
          cv.width = 640; cv.height = 360;
          cv.getContext('2d').drawImage(pv2, 0, 0, 640, 360);
          thumb = cv.toDataURL('image/jpeg', 0.8);
        } catch (e) {}
      }
      const pvOff = $('#liveOff'); if (pvOff) pvOff.remove();

      try {
        await startBroadcast(stream, title, thumb, mime);
      } catch (e) {
        $('#liveErr').textContent = '⚠️ ' + (e.message || 'server error');
        stream.getTracks().forEach(tr => tr.stop());
        btn.disabled = false; btn.textContent = '🔴 Go Live';
        return;
      }
      /* broadcasting — back to home; the red control bar follows you everywhere */
      location.hash = '#/home';
    };
  }

  /* VIEWER: sequential segment player (starts at the live edge) + chat */
  async function viewLiveStream(id) {
    const ICE_VIEWER = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    main.innerHTML = '<div class="page live-view-page"><div class="loading-box"><div class="spinner"></div><p>Connecting to the stream…</p></div></div>';
    const showEndedPage = () => {
      main.innerHTML = '<div class="page"><div class="empty"><div class="empty-ico">🔴</div><h3>LIVE ended</h3><p>This stream is over — recordings appear on the channel.</p><a class="btn-neon" href="#/home">Back home</a></div></div>';
    };
    for (let i = 0; i < 120; i++) {
      let pl;
      try { pl = await api('/api/live/' + id + '/playlist'); } catch (e) { pl = { status: 'gone' }; }
      if (pl.status !== 'live') { showEndedPage(); return; }
      if (pl.segs && pl.segs.length >= 2) break;
      await new Promise(r => setTimeout(r, 3000));
    }

    main.innerHTML = '<div class="live-layout" id="liveWrap">'
      + '<div class="player" id="livePlayer">'
      + '<video id="liveVideo" autoplay playsinline></video>'
      + '<div class="live-badge"><span class="live-dot"></span>LIVE</div>'
      + '</div>'
      + '<div class="chat-panel" id="liveChat">'
      + '<div class="chat-head">💬 Live chat <span class="vrf-badge" title="Verified">✓</span></div>'
      + '<div class="chat-list" id="chatList"></div>'
      + '<div class="react-row" id="reactRow">' + ['😂', '❤️', '🔥', '👏', '😮', '💯', '🎉', '👍'].map(x => '<button type="button" class="react-emoji" data-e="' + x + '">' + x + '</button>').join('') + '</div>'
      + '<div class="quiz-card hide" id="quizCard"></div>'
      + '<form class="chat-input" id="chatForm"><input id="chatText" maxlength="150" placeholder="Say something…"><button class="pill-btn">➤</button></form>'
      + '</div>'
      + '</div>'
      + '<h1 class="w-title" id="liveTitleEl"></h1>'
      + '<div class="w-row"><div class="wl-name" id="liveBroadEl"></div><span class="live-viewers" id="liveViewers"></span></div>'
      + '<p class="muted-txt" id="liveStatus">Streaming…</p>';

    const v = $('#liveVideo');
    const statusEl = $('#liveStatus');

    /* live chat (comments of the stream video) */
    let chatSeen = 0;
    function renderChat(list) {
      const cl = $('#chatList');
      if (!cl) return;
      const fresh = list.slice().reverse().filter(c => c.id > chatSeen);
      fresh.forEach(c => cl.insertAdjacentHTML('beforeend', chatMsgHTML(c)));
      if (fresh.length) { cl.scrollTop = cl.scrollHeight; chatSeen = Math.max(chatSeen, ...list.map(c => c.id)); }
    }
    function chatMsgHTML(c) {
      const pal = palFor(c.author);
      return '<div class="chat-msg">' + avatarHTML({ name: c.author, colors: pal }, 26)
        + '<div class="chat-mbody"><span class="chat-mauthor">' + nameHTML(c.author) + '</span>'
        + '<span class="chat-mtext">' + esc(c.text) + '</span></div></div>';
    }
    async function pollChat() {
      try { const list = await api('/api/videos/' + id + '/comments'); renderChat(list); } catch (e) {}
    }
    pollChat();
    const chatPoller = setInterval(() => { if (!document.querySelector('#liveChat')) { clearInterval(chatPoller); return; } pollChat(); }, 4000);
    cleanups.push(() => clearInterval(chatPoller));
    const cf = $('#chatForm');
    if (cf) cf.onsubmit = async e => {
      e.preventDefault();
      const inp = $('#chatText');
      const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      try {
        await api('/api/videos/' + id + '/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: myName(), text }) });
        pollChat();
      } catch (e2) { toast(e2.message || 'failed', '⚠️'); }
    };
    const reactRow = $('#reactRow');
    if (reactRow) reactRow.addEventListener('click', e => {
      const b = e.target.closest('.react-emoji');
      if (!b) return;
      api('/api/live/' + id + '/react', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: b.dataset.e, uid: supportName() }) }).catch(() => {});
      floatEmoji(b.dataset.e);
    });

    /* ── MSE progressive player: the server stores RAW MediaRecorder chunks;
       appending them in order to a MediaSource = ONE continuous gapless webm.
       This kills the "plays a few seconds, resets to start" glitch. ── */
    let plMime = '';
    let lastSegCount = 0;
    let streamOver = false;
    let lastReactId = 0;
    const segUrls = [];
    function floatEmoji(e) {
      const p = $('#livePlayer');
      if (!p) return;
      const s = document.createElement('span');
      s.className = 'live-react';
      s.textContent = e;
      s.style.left = (12 + Math.random() * 76) + '%';
      s.style.setProperty('--dx', (Math.random() * 120 - 60) + 'px');
      s.style.fontSize = (26 + Math.random() * 20) + 'px';
      p.appendChild(s);
      setTimeout(() => s.remove(), 3300);
    }
    let msRef = null, sbRef = null, mIdx = 0, mQueue = [], mFetching = false, mRetr = 0, seeked = false;

    /* stream over → kill playback, freeze the player, show the badge */
    function liveOver() {
      if (streamOver) return;
      streamOver = true;
      try { v.pause(); } catch (e) {}
      try { v.removeAttribute('src'); v.load(); } catch (e) {}
      const p = $('#livePlayer');
      if (p && !p.querySelector('.live-over')) p.insertAdjacentHTML('beforeend', '<div class="live-over">🔴 LIVE ended</div>');
      if (statusEl) statusEl.textContent = 'This stream is over — recordings appear on the channel 📺';
    }

    function stepMse() {
      if (streamOver) return;
      if (!sbRef || sbRef.updating) return;
      if (mQueue.length) { const b = mQueue.shift(); try { sbRef.appendBuffer(b); } catch (e) { if (statusEl) statusEl.textContent = 'Playback error ⚠️'; } return; }
      if (mFetching || mIdx >= segUrls.length) {
        if (!mFetching && mIdx >= segUrls.length && !streamOver) setTimeout(stepMse, 2500); // wait for fresh segments
        return;
      }
      mFetching = true;
      const url = segUrls[mIdx];
      fetch(url).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
        .then(b => { mQueue.push(b); mIdx++; mRetr = 0; })
        .catch(() => { if (++mRetr >= 3) { mRetr = 0; mIdx++; } })
        .then(() => {
          mFetching = false;
          if (mIdx >= 2 && !seeked) { seeked = true; v.play().catch(() => {}); }
          /* stay at the LIVE edge: appends run faster than playback, so when the
             buffered edge gets >20s ahead, jump to ~5s behind NOW — joining mid-stream
             starts at the live edge instead of the stream start */
          if (!streamOver && isFinite(msRef.duration) && msRef.duration - v.currentTime > 20) {
            try { v.currentTime = Math.max(0, msRef.duration - 5); } catch (e) {}
          }
          stepMse();
        });
    }
    function startMse() {
      if (streamOver) return;
      const cands = [plMime, 'video/webm; codecs="vp8,opus"', 'video/webm; codecs="vp9,opus"', 'video/webm'];
      let mime = '';
      for (const m of cands) { if (m && window.MediaSource) { try { if (MediaSource.isTypeSupported(m)) { mime = m; break; } } catch (e) {} } }
      if (!window.MediaSource || !mime) { if (statusEl) statusEl.textContent = 'Live playback unsupported in this browser ⚠️'; return; }
      try { msRef = new MediaSource(); } catch (e) { return; }
      v.src = URL.createObjectURL(msRef);
      msRef.addEventListener('sourceopen', () => {
        try { sbRef = msRef.addSourceBuffer(mime); } catch (e) { if (statusEl) statusEl.textContent = 'Playback error ⚠️'; return; }
        sbRef.mode = 'segments'; // native timestamps — audio stays in sync with video
        sbRef.addEventListener('updateend', stepMse);
        stepMse();
      });
      /* keep memory sane on long streams: drop what is far behind playback */
      setInterval(() => {
        if (!sbRef || sbRef.updating || !v.buffered.length) return;
        if (v.currentTime - v.buffered.start(0) > 120) { try { sbRef.remove(v.buffered.start(0), v.currentTime - 60); } catch (e) {} }
      }, 30000);
    }
    const livePoller = setInterval(async () => {
      if (!document.querySelector('#liveVideo')) { clearInterval(livePoller); return; }
      try {
        const pl = await api('/api/live/' + id + '/playlist');
        if (pl.status !== 'live') { clearInterval(livePoller); liveOver(); return; }
        if (pl.mime) plMime = pl.mime;
        (pl.reacts || []).forEach(r => { if (r.id > lastReactId) { lastReactId = r.id; floatEmoji(r.e); } });
        /* guest co-host PiP */
        const gsegs = pl.guestSegs || [];
        if (gsegs.length) {
          let gp = document.getElementById('guestPip');
          if (!gp) {
            gp = document.createElement('video');
            gp.id = 'guestPip'; gp.className = 'guest-pip'; gp.autoplay = true; gp.muted = true;
            gp.setAttribute('playsinline', ''); gp.loop = true;
            const pl2 = document.querySelector('#livePlayer');
            if (pl2) pl2.appendChild(gp);
          }
          if (gp.dataset.src !== gsegs[gsegs.length - 1]) { gp.dataset.src = gsegs[gsegs.length - 1]; gp.src = gsegs[gsegs.length - 1]; gp.play().catch(() => {}); }
        }
        /* live quiz card */
        const qz = pl.quiz;
        const qc = document.getElementById('quizCard');
        if (qc) {
          if (qz && qz.open) {
            qc.classList.remove('hide');
            qc.innerHTML = '<div class="quiz-q">❓ ' + esc(qz.q) + '</div>' + qz.options.map((o, oi) =>
              '<button class="quiz-opt" data-opt="' + oi + '">' + esc(o) + ' · ' + (qz.votes[oi] || 0) + '</button>').join('');
            qc.querySelectorAll('.quiz-opt').forEach(b => b.onclick = async () => {
              b.disabled = true;
              try { const rr2 = await api('/api/live/' + id + '/quiz-vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opt: Number(b.dataset.opt) }) }); const vv = rr2.votes || []; qc.querySelectorAll('.quiz-opt').forEach((bb, bi) => { bb.textContent = qz.options[bi] + ' · ' + (vv[bi] || 0); }); } catch (e2) {}
            });
          } else qc.classList.add('hide');
        }
        const segs = pl.segs || [];
        if (segs.length > lastSegCount) {
          segUrls.push(...segs.slice(lastSegCount));
          lastSegCount = segs.length;
          if (!msRef && segs.length >= 2) startMse();
        }
        const te = $('#liveTitleEl'); if (te) te.textContent = pl.title || '';
        const be = $('#liveBroadEl'); if (be) be.innerHTML = 'by ' + nameHTML(pl.broadcaster);
        const vw = $('#liveViewers'); if (vw) vw.textContent = '👁 ' + (pl.viewers || 0).toLocaleString('en-US') + ' watching';
        if (statusEl) statusEl.textContent = '🔴 Live — you are watching in real time';
      } catch (e) {}
    }, 3000);
    cleanups.push(() => clearInterval(livePoller));
  }


const routes = [
    [/^\/?$/,                 q => viewHome(q)],
    [/^\/home$/,              q => viewHome(q)],
    [/^\/shorts\/?(.+)?$/,    m => viewShorts(m[1])],
    [/^\/subscriptions$/,     () => viewSubs()],
    [/^\/library$/,           () => viewLibrary()],
    [/^\/upload$/,            () => viewUpload()],
    [/^\/settings$/,          () => viewSettings()],
    [/^\/login$/,             () => viewLogin()],
    [/^\/live$/,              () => viewGoLive()],
    [/^\/live\/([\w-]+)$/,   m => viewLiveStream(m[1])],
    [/^\/channel$/,           () => viewMyChannel()],
    [/^\/c\/(.+)$/,           m => viewChannel(m[1])],
    [/^\/tag\/(.+)$/,         m => viewTag(decodeURIComponent(m[1]))],
    [/^\/guest\/([\w-]+)$/,   m => viewGuest(m[1])],
    [/^\/watch\/([\w-]+)$/,   m => viewWatch(m[1])],
    [/^\/results$/,           q => viewResults(q)],
  ];
  function navName(path) {
    if (/^\/?$|\/home|\/watch|\/results/.test(path)) return 'home';
    if (path.startsWith('/live')) return 'live';
    if (path.startsWith('/shorts')) return 'shorts';
    if (path.startsWith('/subscriptions')) return 'subs';
    if (path.startsWith('/library')) return 'library';
    if (path.startsWith('/channel') || path.startsWith('/c/')) return 'channel';
    if (path.startsWith('/upload')) return 'upload';
    return '';
  }

  function navigate() {
    /* mini-player: a playing video follows you across pages */
    const curVid = document.querySelector('#yvVideo');
    if (/^\/(upload|live|settings)/.test(location.hash.slice(1) || '/')) closeMiniPlayer();
    const tgtWatch = /^\/watch\/([\w-]+)$/.exec((location.hash.slice(1) || '/'));
    if (miniBox && tgtWatch && miniBox.vid === tgtWatch[1]) closeMiniPlayer();
    if (curVid && !curVid.paused && curVid.currentTime > 2 && !(tgtWatch && tgtWatch[1] === curVid.dataset.vid)) {
      const ttlEl = document.querySelector('.w-title');
      showMiniPlayer(curVid, curVid.dataset.vid, ttlEl ? ttlEl.textContent : '');
    }
    runCleanups();
    const h = location.hash.slice(1) || '/';
    const qi = h.indexOf('?');
    const path = qi < 0 ? h : h.slice(0, qi);
    const query = new URLSearchParams(qi < 0 ? '' : h.slice(qi + 1));

    const name = navName(path);
    $$('[data-nav]').forEach(el => el.classList.toggle('on', el.dataset.nav === name));

    for (const [re, fn] of routes) {
      const m = path.match(re);
      if (m) {
        main.scrollTop = 0;
        window.scrollTo(0, 0);
        m[1] !== undefined ? fn(m) : fn(query);
        return;
      }
    }
    location.hash = '#/home';
  }

  /* ═══════════ boot ═══════════ */
  if (!S.myChannel) { S.myChannel = JSON.parse(JSON.stringify(YV.MY_DEFAULT)); YV.store.save(); }
  if (!S.myDelKeys) S.myDelKeys = {};
  renderMe();
  window.addEventListener('hashchange', navigate);

  /* render instantly from cache, then refresh silently in the background */
  const hydrated = hydrateFeedCache();
  navigate();
  if (hydrated) {
    const sig = feedSig();
    loadVideos().then(() => {
      if (feedSig() !== sig) {
        const p = location.hash.slice(1) || '/';
        if (/^\/?$|\/home|\/subscriptions|\/library|\/shorts|\/c\/|\/channel/.test(p)) navigate();
      }
    }).catch(() => {});
  }
  /* if logged in, quietly pull any guest uploads into the account */
  claimMyVideos(true).then(moved => { if (moved > 0) navigate(); });

  /* auto-update: reload the tab when a newer version is deployed
     — but NEVER while an upload is running */
  async function checkVersion() {
    if (UPLOADING || liveStreamId) return;   // never reload while publishing OR broadcasting
    try {
      const r = await fetch('/', { cache: 'no-store' });
      const t = await r.text();
      const m = /YV_V\s*=\s*(\d+)/.exec(t);
      if (m && window.YV_V && Number(m[1]) > Number(window.YV_V)) location.reload();
    } catch (e) { /* offline etc. */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
  setInterval(checkVersion, 60000);
})();
