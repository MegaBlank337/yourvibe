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

  let VERIFIED = new Set();   // creator names with the verified badge
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
    VERIFIED = new Set(b.verified || []);
    NOTIFS = b.notifications || [];
    videosLoaded = true;
    if (b.announcement !== undefined) { ANN = b.announcement; renderAnnouncement(); }
    if (b.me && S.auth && S.auth.token) {
      if (b.me.avatar_url) { S.acctAvatar = b.me.avatar_url; AVATARS[S.auth.username.toLowerCase()] = b.me.avatar_url; }
      if (b.me.banner_url) S.acctBanner = b.me.banner_url;
      if (b.me.bio) S.myChannel.bio = b.me.bio;
      renderMe();
    }
    saveFeedCache();
  }

  async function loadVideos() { return loadBoot(); }

  /* ── instant-load feed cache (stale-while-revalidate) ── */
  const FEED_CACHE = 'yv_feed_v1';

  function saveFeedCache() {
    try { localStorage.setItem(FEED_CACHE, JSON.stringify({ v: VIDEOS, c: CREATORS, a: AVATARS, t: Date.now() })); } catch (e) {}
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
      videosLoaded = true;
      return true;
    } catch (e) { return false; }
  }

  function feedSig() {
    return VIDEOS.length + '|' + VIDEOS.map(x => x.id + ':' + (x.views || 0) + ':' + (x.likes || 0) + ':' + (x.parts || 1) + ':' + (x.video_url || '').length + ':' + (x.thumb_url || '').length).join(',').length
      + '|' + Object.keys(CREATORS).map(k => k + CREATORS[k]).join('').length
      + '|' + Object.keys(AVATARS).length;
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
  /* verified badge next to a creator name */
  function nameHTML(name, cls) {
    const badge = VERIFIED.has(name) ? ' <span class="vrf-badge" title="Verified">✓</span>' : '';
    return '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(name) + badge + '</span>';
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
    const accAvatar = AVATARS[((ch && ch.name) || '').toLowerCase()];
    if (accAvatar) return '<span class="av av-img" style="width:' + size + 'px;height:' + size + 'px"><img src="' + accAvatar + '" alt=""></span>';
    const letter = ((ch && ch.name) || '?').trim().charAt(0).toUpperCase();
    return '<span class="av" style="width:' + size + 'px;height:' + size + 'px;--c1:' + p[0] + ';--c2:' + p[1] + '">' + letter + '</span>';
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
    const img = v.thumb_url ? '<img loading="lazy" src="' + v.thumb_url + '" alt="" onerror="this.style.display=\'none\'">' : '';
    const ghost = v.type === 'short' ? '⚡' : '▶';
    return '<div class="thumb" style="--c1:' + p[0] + ';--c2:' + p[1] + '">'
      + img
      + '<span class="thumb-ghost' + (v.thumb_url ? ' small' : '') + '">' + ghost + '</span>'
      + (v.duration && v.type !== 'short' ? '<span class="dur">' + esc(v.duration) + '</span>' : '')
      + '<button class="later-btn' + (S.later[v.id] ? ' on' : '') + '" data-action="later" data-id="' + v.id + '" title="Watch later">' + (S.later[v.id] ? '✓' : '＋') + '</button>'
      + '</div>';
  }

  function cardHTML(v) {
    const up = upOf(v);
    return '<a class="card" href="#/watch/' + v.id + '">'
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
    return '<a class="compact-card" href="#/watch/' + v.id + '">'
      + '<div class="thumb sm" style="--c1:' + up.colors[0] + ';--c2:' + up.colors[1] + '">'
      + (v.thumb_url ? '<img loading="lazy" src="' + v.thumb_url + '" alt="" onerror="this.style.display=\'none\'">' : '')
      + '<span class="thumb-ghost' + (v.thumb_url ? ' small' : '') + '">' + (v.type === 'short' ? '⚡' : '▶') + '</span>'
      + (v.duration ? '<span class="dur">' + esc(v.duration) + '</span>' : '')
      + '</div>'
      + '<div class="cc-txt"><h4>' + esc(v.title) + '</h4>'
      + '<div class="ch-name">' + esc(v.uploader) + '</div>'
      + '<div class="v-stats">' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + '</div>'
      + '</div></a>';
  }

  function shortCardHTML(s) {
    const up = upOf(s);
    return '<a class="short-card" href="#/shorts/' + s.id + '">'
      + '<div class="thumb vert" style="--c1:' + up.colors[0] + ';--c2:' + up.colors[1] + '">'
      + (s.thumb_url ? '<img loading="lazy" src="' + s.thumb_url + '" alt="" onerror="this.style.display=\'none\'">' : '')
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
  async function viewHome(q) {
    if (!await ensureVideos()) return;
    const cat = q.get('cat') || 'All';
    const videos = VIDEOS.filter(v => v.type !== 'short');
    const shorts = VIDEOS.filter(v => v.type === 'short');
    const trending = videos.slice().sort((a, b) => viewsOf(b) - viewsOf(a)).slice(0, 4);
    const filtered = cat === 'All' ? videos : videos.filter(v => v.category === cat);
    const shortList = cat === 'All' ? shorts : shorts.filter(s => s.category === cat);

    main.innerHTML =
      '<div class="chips">' + ['All'].concat(YV.CATS).map(c =>
        '<a class="chip' + (c === cat ? ' on' : '') + '" href="#/home?cat=' + encodeURIComponent(c) + '">' + c + '</a>').join('') + '</div>'

      + (trending.length ? shelf('🔥 Trending Now', trending.map(cardHTML).join('')) : '')

      + (shortList.length ? shelf('⚡ Shorts', shortList.slice(0, 10).map(shortCardHTML).join('')) : '')

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
      return '<section class="short" data-short="' + s.id + '">'
        + '<video loop muted playsinline preload="metadata"' + (s.thumb_url ? ' poster="' + s.thumb_url + '"' : '') + ' src="' + srcOf(s) + '"></video>'
        + '<div class="v-spin v-spin-s"><i></i></div>'
        + '<div class="short-panel">'
        + '<div class="short-info">' + avatarHTML(up, 34)
        + '<div class="si-txt"><b>' + esc(s.uploader) + '</b></div>' + subBtnHTML(s.uploader, true) + '</div>'
        + '<div class="short-title">' + esc(s.title) + '</div>'
        + '</div>'
        + '<div class="short-rail">'
        + '<button class="rail-btn' + (isLiked(s.id) ? ' on' : '') + '" data-action="like" data-id="' + s.id + '"><span class="ric">❤️</span><span class="cnt">' + fmtNum(likesOf(s)) + '</span></button>'
        + '<a class="rail-btn" href="#/watch/' + s.id + '" title="Comments"><span class="ric">💬</span><span class="cnt">💬</span></a>'
        + '<button class="rail-btn" data-action="share" data-id="' + s.id + '"><span class="ric">🔗</span><span>Share</span></button>'
        + '<button class="rail-btn mute-btn" data-action="mute-shorts"><span class="ric">' + (shortsMuted ? '🔇' : '🔊') + '</span><span>Sound</span></button>'
        + '</div>'
        + '<div class="short-hint">Tap to pause</div>'
        + '</section>';
    }).join('') + '</div>';

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
    const vids = VIDEOS.filter(v => S.subs[v.uploader]);
    main.innerHTML =
      '<h1 class="page-title">Subscriptions</h1>'
      + '<div class="sub-chips">' + names.map(n =>
        '<a class="sub-chip" href="#/c/' + encodeURIComponent(n) + '">' + avatarHTML({ name: n, colors: palFor(n) }, 44) + '<span>' + esc(n) + '</span></a>').join('') + '</div>'
      + (vids.length ? '<div class="cards">' + vids.map(cardHTML).join('') + '</div>'
        : '<p class="muted-txt pad">No uploads from these creators yet.</p>');
  }

  /* ═══════════ VIEW: LIBRARY ═══════════ */
  async function viewLibrary() {
    if (!await ensureVideos()) return;
    const hist = S.history.map(byId).filter(Boolean).slice(0, 12);
    const liked = Object.keys(S.likes).map(byId).filter(Boolean);
    const later = Object.keys(S.later).map(byId).filter(Boolean);
    const mine = VIDEOS.filter(v => v.uploader === myName());
    const any = hist.length || liked.length || later.length || mine.length;

    main.innerHTML = '<h1 class="page-title">Library</h1>' + (!any
      ? emptyHTML('📚', 'Your library is empty', 'Watch, like and upload videos — they all collect here.', '<a class="btn-neon" href="#/home">Explore</a>')
      : (hist.length ? shelf('🕘 History', hist.map(cardHTML).join(''), '<button class="pill-btn ghost" data-action="clear-history">Clear all</button>') : '')
        + (liked.length ? shelf('❤️ Liked videos', liked.map(cardHTML).join('')) : '')
        + (later.length ? shelf('⏳ Watch later', later.map(cardHTML).join('')) : '')
        + (mine.length ? shelf('🎬 Your uploads', mine.map(cardHTML).join(''), '<a class="pill-btn ghost" href="#/channel">Manage</a>') : ''));
  }

  /* ═══════════ VIEW: MY CHANNEL ═══════════ */
  async function viewMyChannel() {
    if (!await ensureVideos()) return;
    const c = S.myChannel;
    const mine = VIDEOS.filter(v => v.uploader === myName());
    const totalViews = mine.reduce((a, v) => a + (v.views || 0), 0);
    const totalLikes = mine.reduce((a, v) => a + likesOf(v), 0);

    main.innerHTML = '<div class="channel-page" data-scope="me">'
      + '<div class="banner"' + ((S.acctBanner || c.banner) ? ' style="background-image:url(' + (S.acctBanner || c.banner) + ')"' : ' style="--c1:' + c.colors[0] + ';--c2:' + c.colors[1] + '"') + '></div>'
      + '<div class="ch-head">'
      + '<span class="ch-ava">' + avatarHTML(meCh(), 96) + '</span>'
      + '<div class="ch-id"><h1 class="ch-name-big">' + esc(myName()) + '</h1>'
      + '<div class="ch-sub">' + fmtNum(subsOfCreator(myName())) + ' subscribers · ' + fmtNum(totalViews) + ' views · ' + mine.length + ' upload' + (mine.length === 1 ? '' : 's') + '</div></div>'
      + '<div class="ch-actions"><a class="btn-neon" href="#/upload">＋ Upload</a>'
      + '<a class="pill-btn ghost" href="#/settings">⚙ Customize channel</a></div>'
      + '</div>'
      + '<div class="ch-tabs">'
      + '<button class="tab-btn on" data-action="tab" data-tab="vids">🎬 Videos</button>'
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
      + '<div class="tab-panel hide" data-panel="about">'
      + '<div class="about-card"><h3>About</h3><p>' + esc(c.bio || 'No bio yet.').replace(/\n/g, '<br>') + '</p>'
      + '<div class="ch-stats"><span>📹 ' + mine.length + ' uploads</span><span>👁 ' + fmtNum(totalViews) + ' total views</span><span>❤️ ' + fmtNum(totalLikes) + ' likes received</span></div>'
      + '</div></div>'
      + '</div>';
  }

  /* ═══════════ VIEW: CREATOR CHANNEL ═══════════ */
  async function viewChannel(name) {
    if (!await ensureVideos()) return;
    const n = decodeURIComponent(name);
    const vids = VIDEOS.filter(v => v.uploader === n);
    const pal = n === S.myChannel.name ? S.myChannel.colors : palFor(n);
    main.innerHTML = '<div class="channel-page" data-scope="c">'
      + '<div class="banner def" style="--c1:' + pal[0] + ';--c2:' + pal[1] + '"></div>'
      + '<div class="ch-head">'
      + '<span class="ch-ava">' + avatarHTML({ name: n, colors: pal, isMe: n === S.myChannel.name }, 96) + '</span>'
      + '<div class="ch-id"><h1 class="ch-name-big">' + esc(n) + '</h1>'
      + '<div class="ch-sub">' + fmtNum(subsOfCreator(n)) + ' subscribers · ' + vids.length + ' video' + (vids.length === 1 ? '' : 's') + '</div></div>'
      + subBtnHTML(n)
      + '</div>'
      + '<div class="ch-tabs">'
      + '<button class="tab-btn on" data-action="tab" data-tab="vids">🎬 Videos</button>'
      + '<button class="tab-btn" data-action="tab" data-tab="about">💫 About</button>'
      + '</div>'
      + '<div class="tab-panel" data-panel="vids">'
      + (vids.length ? '<div class="cards">' + vids.map(cardHTML).join('') + '</div>'
        : emptyHTML('🎥', 'No uploads yet', 'This creator hasn\'t published anything yet.'))
      + '</div>'
      + '<div class="tab-panel hide" data-panel="about">'
      + '<div class="about-card"><h3>About ' + esc(n) + '</h3>'
      + '<p>Creator on YourVibe ⚡</p>'
      + '<div class="ch-stats"><span>🔔 ' + fmtNum(subsOfCreator(n)) + ' subscribers</span><span>🎬 ' + vids.length + ' video' + (vids.length === 1 ? '' : 's') + '</span><span>👁 ' + fmtNum(vids.reduce((a, v) => a + viewsOf(v), 0)) + ' total views</span></div>'
      + '</div></div>'
      + '</div>';
  }

  /* ═══════════ comments (server-side, shared) ═══════════ */
  function cItemHTML(c) {
    const pal = palFor(c.author);
    return '<div class="c-item">' + avatarHTML({ name: c.author, colors: pal }, 34)
      + '<div class="c-body"><div class="c-user">@' + nameHTML(c.author) + ' <span>' + timeAgo(c.created_at ? Date.parse(c.created_at) : Date.now()) + '</span></div>'
      + '<p>' + esc(c.text) + '</p></div></div>';
  }

  async function commentsHTML(v) {
    let list = [];
    try { list = await api('/api/videos/' + v.id + '/comments'); } catch (e) { list = []; }
    await loadAvatars(list.map(c => c.author)); // real icons in comments too
    return '<section class="comments" id="comments">'
      + '<h2 class="c-head" id="cHead">' + fmtNum(list.length) + ' Comments</h2>'
      + '<form class="c-input" data-form="comment" data-id="' + v.id + '">'
      + avatarHTML(meCh(), 36)
      + '<input name="ctext" placeholder="Add a comment…" maxlength="300" required>'
      + '<button class="pill-btn" type="submit">Comment</button></form>'
      + '<div class="c-list" id="cList">' + (list.length ? list.map(cItemHTML).join('')
        : '<p class="muted-txt pad">No comments yet — say something nice ✨</p>') + '</div>'
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
      + '<video id="yvVideo" data-vid="' + v.id + '" src="' + src + '" playsinline ' + (v.thumb_url ? 'poster="' + v.thumb_url + '" ' : '') + '></video>'
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
    const related = VIDEOS.filter(x => x.id !== v.id);
    const sameCat = related.filter(x => x.category === v.category);
    const rel = sameCat.concat(related.filter(x => x.category !== v.category)).slice(0, 10);

    main.innerHTML = '<div class="watch">'
      + '<div class="watch-main">'
      + playerHTML(v)
      + '<h1 class="w-title">' + esc(v.title) + '</h1>'
      + '<div class="w-row">'
      + '<a class="ch-link" href="#/c/' + encodeURIComponent(v.uploader) + '">' + avatarHTML(up, 42)
      + '<div><div class="wl-name">' + nameHTML(v.uploader) + '</div>'
      + '<div class="wl-subs">' + fmtNum(subsOfCreator(v.uploader)) + ' subscribers</div></div></a>'
      + subBtnHTML(v.uploader)
      + '<span class="w-spacer"></span>'
      + likeGroupHTML(v)
      + '<button class="act-btn" data-action="share" data-id="' + v.id + '">🔗 Share</button>'
      + '<button class="act-btn' + (S.later[v.id] ? ' on' : '') + '" data-action="later" data-id="' + v.id + '">⏳ Later</button>'
      + ((S.myDelKeys[v.id] || (S.auth && S.auth.username === v.uploader)) ? '<button class="act-btn danger" data-action="del" data-id="' + v.id + '">🗑 Delete</button>' : '')
      + ((S.myDelKeys[v.id] || (S.auth && S.auth.username === v.uploader)) ? '<button class="act-btn" data-action="addpoll" data-id="' + v.id + '">📊 Poll</button>' : '')
      + '</div>'
        + '<div class="w-desc"><b>' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + (v.category ? ' · #' + esc(v.category) : '') + '</b><br>' + esc(v.description || '') + '</div>'
      + '<div id="pollSlot"></div>'
      + '<div id="comments-slot">' + loadingHTML() + '</div>'
      + '</div>'
      + '<aside class="related"><h2 class="section-title">Up next ⚡</h2>'
      + rel.map(relCardHTML).join('')
      + '</aside></div>';

    commentsHTML(v).then(html => { const slot = $('#comments-slot'); if (slot) slot.outerHTML = html; });
    loadPoll(v.id);

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
      ? VIDEOS.filter(v =>
          v.title.toLowerCase().includes(term) ||
          v.uploader.toLowerCase().includes(term) ||
          (v.category || '').toLowerCase().includes(term))
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
      + '<div class="up-preview hide" id="upPrev"><video id="prevVid" controls muted playsinline></video><div class="up-meta" id="upMeta"></div></div>'
      + '<div class="progress-wrap hide" id="upProg"><div class="progress-label" id="upProgLbl">Uploading…</div><div class="progress-bar"><div class="progress-fill" id="upProgFill"></div></div></div>'
      + '<div class="form-err" id="upErr"></div>'
      + '<button class="btn-neon publish" id="publish" type="submit" disabled>🚀 Publish</button>'
      + '</form></div></div>';

    const dz = $('#dz'), fileIn = $('#fileIn'), dzName = $('#dzName'),
      prevWrap = $('#upPrev'), prevVid = $('#prevVid'), upMeta = $('#upMeta'),
      upTitle = $('#upTitle'), upErr = $('#upErr'), publish = $('#publish'),
      thIn = $('#thIn'), thBtn = $('#thBtn'), thMsg = $('#thMsg'), thPrev = $('#thPrev');

    let file = null, objUrl = null, dur = 0, thumbData = null, thumbFile = null;

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
        upMeta.textContent = (dur ? '⏱ Duration ' + fmtDur(dur) : '')
          + ' · ready to publish ✨';
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
                  guid: vj.guid, title,
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
      + '<div class="field"><label>Profile picture</label><div class="file-row">'
      + '<button type="button" class="pill-btn ghost" id="avaBtn">🖼 Choose avatar</button>'
      + '<input type="file" id="avaIn" accept="image/*" hidden><span class="muted-txt" id="avaMsg"></span></div></div>'
      + '<div class="field"><label>Banner</label><div class="file-row">'
      + '<button type="button" class="pill-btn ghost" id="banBtn">🌅 Choose banner</button>'
      + '<input type="file" id="banIn" accept="image/*" hidden><span class="muted-txt" id="banMsg"></span></div></div>'
      + '<div class="form-err" id="stErr"></div>'
      + '<button class="btn-neon" type="submit">💾 Save channel</button>'
      + '</form></div></div>';

    let avaData = c.avatar, banData = c.banner;

    $('#avaBtn').onclick = () => $('#avaIn').click();
    $('#banBtn').onclick = () => $('#banIn').click();
    $('#avaIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      $('#avaMsg').textContent = 'processing…';
      avaData = await imageToDataURL(f, 160, 160);
      $('#avaMsg').textContent = avaData ? '✅ ready' : '⚠️ could not read image (try a JPG/PNG)';
      if (avaData) {
        $('#prevAva').innerHTML = '<span class="av av-img" style="width:72px;height:72px"><img src="' + avaData + '"></span>';
        if (S.auth && S.auth.token) saveProfileToAccount({ avatar: avaData, banner: banData, bio: $('#stBio').value.trim() }); // instant account save
      }
    };
    $('#banIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      $('#banMsg').textContent = 'processing…';
      banData = await imageToDataURL(f, 960, 220);
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
      S.myChannel.avatar = avaData;
      S.myChannel.banner = banData;
      YV.store.save();
      renderMe();
      /* logged in → save avatar/banner to the account (works on every device) */
      if (S.auth && S.auth.token) {
        api('/api/auth/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ avatar: avaData, banner: banData, bio: $('#stBio').value.trim() })
        }).then(() => { AVATARS[S.auth.username.toLowerCase()] = avaData; navigate(); }).catch(() => {});
      }
      toast('Channel updated', '✨');
      location.hash = '#/channel';
    };
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
    if (btn) { openNotifPanel(); return; }
    if (panel && !panel.classList.contains('hide') && !e.target.closest('#notifPanel')) panel.classList.add('hide');
  });

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
      if (me.avatar_url) { S.acctAvatar = me.avatar_url; AVATARS[S.auth.username.toLowerCase()] = me.avatar_url; }
      if (me.banner_url) S.acctBanner = me.banner_url;
      if (me.bio) S.myChannel.bio = me.bio;
      renderMe();
    } catch (e) {}
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
      + '<div class="admin-row"><input type="text" id="adminAnnText" maxlength="300" placeholder="📣 Announcement text (everyone sees it)"><button class="pill-btn" data-admin="announce">📣 Post</button></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">announcement shows as a banner on the site</span><button class="pill-btn danger" data-admin="announce-clear">🗑 Remove announcement</button></div>'
      + '<div class="admin-row"><input type="text" id="adminVerifyName" maxlength="50" placeholder="✔ creator name to verify"><button class="pill-btn" data-admin="verify">✔ Verify</button><button class="pill-btn danger" data-admin="unverify">✕ Unverify</button></div>'
      + '<div class="admin-row"><input type="text" id="adminNotifText" maxlength="300" placeholder="🔔 Notification text (from YourVibe ✓)"><button class="pill-btn" data-admin="notify">🔔 Send</button></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">clears every notification</span><button class="pill-btn danger" data-admin="notif-clear">🗑 Clear notifications</button></div>'
      + '<div class="admin-row"><span class="muted-txt" style="flex:1;align-self:center;font-size:13px">create a poll for the selected video</span><button class="pill-btn" data-admin="poll">📊 Create poll</button></div>'
      + '</div>'
      + '<p class="muted-txt">Applies on the server — everyone sees it. Comments come from randomly generated accounts.</p>'
      + '</div></div>';
    document.body.appendChild(d);

    $('#adminClose').onclick = () => d.classList.add('hide');
    d.addEventListener('click', e => { if (e.target === d) d.classList.add('hide'); });
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

  async function adminAction(kind) {
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
      if (!text) { toast('Enter notification text', '⚠️'); return; }
      try {
        await api('/api/admin/notification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ text })
        });
        await loadVideos();
        toast('Notification sent 🔔', '✅');
        $('#adminNotifText').value = '';
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
  document.addEventListener('click', e => {
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
    else if (a === 'like') toggleLike(id);
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

  /* ═══════════ router ═══════════ */
  const routes = [
    [/^\/?$/,                 q => viewHome(q)],
    [/^\/home$/,              q => viewHome(q)],
    [/^\/shorts\/?(.+)?$/,    m => viewShorts(m[1])],
    [/^\/subscriptions$/,     () => viewSubs()],
    [/^\/library$/,           () => viewLibrary()],
    [/^\/upload$/,            () => viewUpload()],
    [/^\/settings$/,          () => viewSettings()],
    [/^\/login$/,             () => viewLogin()],
    [/^\/channel$/,           () => viewMyChannel()],
    [/^\/c\/(.+)$/,           m => viewChannel(m[1])],
    [/^\/watch\/([\w-]+)$/,   m => viewWatch(m[1])],
    [/^\/results$/,           q => viewResults(q)],
  ];

  function navName(path) {
    if (/^\/?$|\/home|\/watch|\/results/.test(path)) return 'home';
    if (path.startsWith('/shorts')) return 'shorts';
    if (path.startsWith('/subscriptions')) return 'subs';
    if (path.startsWith('/library')) return 'library';
    if (path.startsWith('/channel') || path.startsWith('/c/')) return 'channel';
    if (path.startsWith('/upload')) return 'upload';
    return '';
  }

  function navigate() {
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
        if (/^\/?$|\/home|\/subscriptions|\/library|\/shorts/.test(p)) navigate();
      }
    }).catch(() => {});
  }
  /* if logged in, quietly pull any guest uploads into the account */
  claimMyVideos(true).then(moved => { if (moved > 0) navigate(); });

  /* auto-update: reload the tab when a newer version is deployed
     — but NEVER while an upload is running */
  async function checkVersion() {
    if (UPLOADING) return;
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
