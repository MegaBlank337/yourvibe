/* ═══════════════════════════════════════════════════════
   YourVibe — App
   Vanilla JS single-page app. Hash router + event delegation.
   Routes: #/home  #/shorts[/:id]  #/subscriptions  #/library
           #/channel  #/c/:id  #/watch/:id  #/upload
           #/settings  #/results?q=…
   ═══════════════════════════════════════════════════════ */
(function () {
  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [].slice.call((r || document).querySelectorAll(s));
  const S  = YV.store.state;

  const main   = $('#main');
  const toasts = $('#toasts');
  let cleanups = [];
  let shortsMuted = true;

  function runCleanups() { cleanups.forEach(f => { try { f(); } catch (e) {} }); cleanups = []; }

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
  const meCh = () => ({ id: 'me', isMe: true, name: S.myChannel.name, handle: S.myChannel.handle, colors: S.myChannel.colors, v: false });
  const chOf = v => v.ch === 'me' ? meCh() : YV.chMap[v.ch];
  const myVideos = type => S.myVideos.filter(v => !type || v.type === type);
  const allContent = () => YV.VIDEOS.concat(YV.SHORTS, S.myVideos);
  const byId = id => allContent().find(v => v.id === id);
  const orderByT = arr => arr.slice().sort((a, b) => (b.t || 0) - (a.t || 0));
  const isLiked = id => !!S.likes[id];
  const isSub   = id => !!S.subs[id];
  const likesOf = v => (v.likes || 0) + (isLiked(v.id) ? 1 : 0);
  const viewsOf = v => (v.views || 0) + (S.over[v.id] || 0);
  const agoOf   = v => v.ago || timeAgo(v.createdAt);
  const subsOf  = c => c.subs + (isSub(c.id) ? 1 : 0);

  function srcOf(v) {
    if (v.src) return Promise.resolve(v.src);
    if (v.blobKey) return YV.store.getBlob(v.blobKey).then(b => b ? URL.createObjectURL(b) : null);
    return Promise.resolve(null);
  }

  function bumpViews(id) {
    const mine = S.myVideos.find(v => v.id === id);
    if (mine) mine.views = (mine.views || 0) + 1;
    else S.over[id] = (S.over[id] || 0) + 1;
    YV.store.save();
  }

  function addHistory(id) {
    S.history = [id].concat(S.history.filter(x => x !== id)).slice(0, 60);
    YV.store.save();
  }

  /* ═══════════ avatar & buttons ═══════════ */
  const AV_PALETTES = [['#ff2bd6', '#7b2ff7'], ['#00e5ff', '#2d6bff'], ['#39ff14', '#00e5ff'], ['#ff9d00', '#ff2bd6'], ['#8a2be2', '#00e5ff'], ['#00ffa3', '#39ff14']];
  function hashHue(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

  function avatarHTML(c, size) {
    size = size || 36;
    let ch = c;
    if (c && (c.isMe || c.id === 'me')) {
      if (S.myChannel.avatar) return '<span class="av av-img" style="width:' + size + 'px;height:' + size + 'px"><img src="' + S.myChannel.avatar + '" alt=""></span>';
      ch = { name: S.myChannel.name, colors: S.myChannel.colors };
    }
    const p = (ch && ch.colors) ? ch.colors : AV_PALETTES[hashHue(ch && ch.name || '?') % AV_PALETTES.length];
    const letter = ((ch && ch.name) || '?').trim().charAt(0).toUpperCase();
    return '<span class="av" style="width:' + size + 'px;height:' + size + 'px;--c1:' + p[0] + ';--c2:' + p[1] + '">' + letter + '</span>';
  }

  function subBtnHTML(chId, small) {
    if (chId === 'me') return ''; // no subscribing to your own channel
    const on = isSub(chId);
    return '<button class="sub-btn' + (on ? ' subbed' : '') + (small ? ' sm' : '') + '" data-action="sub" data-ch="' + chId + '">' + (on ? '🔔 Subscribed' : 'Subscribe') + '</button>';
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
    const ch = chOf(v);
    const p = ch.colors || ['#ff2bd6', '#00e5ff'];
    const img = v.thumb ? '<img loading="lazy" src="' + v.thumb + '" alt="" onerror="this.style.display=\'none\'">' : '';
    return '<div class="thumb" style="--c1:' + p[0] + ';--c2:' + p[1] + '">'
      + img
      + '<span class="thumb-ghost' + (v.thumb ? ' small' : '') + '">' + (v.emo || '▶') + '</span>'
      + (v.dur && v.type !== 'short' ? '<span class="dur">' + v.dur + '</span>' : '')
      + '<button class="later-btn' + (S.later[v.id] ? ' on' : '') + '" data-action="later" data-id="' + v.id + '" title="Watch later">' + (S.later[v.id] ? '✓' : '＋') + '</button>'
      + '</div>';
  }

  function cardHTML(v) {
    const ch = chOf(v);
    return '<a class="card" href="#/watch/' + v.id + '">'
      + thumbHTML(v)
      + '<div class="meta">' + avatarHTML(ch, 36)
      + '<div class="meta-txt">'
      + '<h3>' + esc(v.title) + '</h3>'
      + '<div class="ch-name">' + esc(ch.name) + (ch.v ? ' <span class="vrf">✓</span>' : '') + '</div>'
      + '<div class="v-stats">' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + '</div>'
      + '</div></div></a>';
  }

  function relCardHTML(v) {
    const ch = chOf(v);
    return '<a class="compact-card" href="#/watch/' + v.id + '">'
      + '<div class="thumb sm" style="--c1:' + ch.colors[0] + ';--c2:' + ch.colors[1] + '">'
      + (v.thumb ? '<img loading="lazy" src="' + v.thumb + '" alt="" onerror="this.style.display=\'none\'">' : '')
      + '<span class="thumb-ghost' + (v.thumb ? ' small' : '') + '">' + (v.emo || '▶') + '</span>'
      + (v.dur ? '<span class="dur">' + v.dur + '</span>' : '')
      + '</div>'
      + '<div class="cc-txt"><h4>' + esc(v.title) + '</h4>'
      + '<div class="ch-name">' + esc(ch.name) + '</div>'
      + '<div class="v-stats">' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + '</div>'
      + '</div></a>';
  }

  function shortCardHTML(s) {
    return '<a class="short-card" href="#/shorts/' + s.id + '">'
      + '<div class="thumb vert" style="--c1:' + chOf(s).colors[0] + ';--c2:' + chOf(s).colors[1] + '">'
      + (s.thumb ? '<img loading="lazy" src="' + s.thumb + '" alt="" onerror="this.style.display=\'none\'">' : '')
      + '<span class="thumb-ghost' + (s.thumb ? ' small' : '') + '">' + (s.emo || '⚡') + '</span>'
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
  function viewHome(q) {
    const cat = q.get('cat') || 'All';
    const videos = orderByT(YV.VIDEOS.concat(myVideos('video')));
    const shorts = orderByT(YV.SHORTS.concat(myVideos('short')));

    const trending = videos.slice().sort((a, b) => viewsOf(b) - viewsOf(a)).slice(0, 4);
    const filtered = cat === 'All' ? videos : videos.filter(v => v.cat === cat);
    const shortList = cat === 'All' ? shorts : shorts.filter(s => s.cat === cat);

    main.innerHTML =
      '<div class="chips">' + ['All'].concat(YV.CATS).map(c =>
        '<a class="chip' + (c === cat ? ' on' : '') + '" href="#/home?cat=' + encodeURIComponent(c) + '">' + c + '</a>').join('') + '</div>'

      + (trending.length ? shelf('🔥 Trending Now', trending.map(cardHTML).join('')) : '')

      + (shortList.length ? shelf('⚡ Shorts', shortList.slice(0, 10).map(shortCardHTML).join('')) : '')

      + '<section class="recs"><div class="shelf-head"><h2 class="section-title">✨ Recommended</h2></div>'
      + (filtered.length
        ? '<div class="cards">' + filtered.map(cardHTML).join('') + '</div>'
        : emptyHTML('🕳️', 'Nothing in “' + esc(cat) + '” yet', 'Try another category — or upload the first ' + esc(cat) + ' video yourself.', '<a class="btn-neon" href="#/upload">＋ Upload</a>'))
      + '</section>';
  }

  /* ═══════════ VIEW: SHORTS ═══════════ */
  function viewShorts(startId) {
    const shorts = orderByT(YV.SHORTS.concat(myVideos('short')));
    if (!shorts.length) { main.innerHTML = emptyHTML('⚡', 'No Shorts yet', 'Upload a vertical banger to start the feed.'); return; }

    Promise.all(shorts.map(srcOf)).then(srcs => {
      main.innerHTML = '<div class="shorts-feed">' + shorts.map((s, i) => {
        const ch = chOf(s);
        const src = srcs[i];
        if (!src) return '';
        return '<section class="short" data-short="' + s.id + '">'
          + '<video loop muted playsinline preload="metadata"' + (s.thumb ? ' poster="' + s.thumb + '"' : '') + ' src="' + src + '"></video>'
          + '<div class="short-panel">'
          + '<div class="short-info">' + avatarHTML(ch, 34)
          + '<div class="si-txt"><b>' + esc(ch.name) + '</b></div>' + subBtnHTML(s.ch, true) + '</div>'
          + '<div class="short-title">' + esc(s.title) + '</div>'
          + '</div>'
          + '<div class="short-rail">'
          + '<button class="rail-btn' + (isLiked(s.id) ? ' on' : '') + '" data-action="like" data-id="' + s.id + '"><span class="ric">❤️</span><span class="cnt">' + fmtNum(likesOf(s)) + '</span></button>'
          + '<a class="rail-btn" href="#/watch/' + s.id + '" title="Comments"><span class="ric">💬</span><span class="cnt">' + fmtNum(commentsCountFor(s)) + '</span></a>'
          + '<button class="rail-btn" data-action="share" data-id="' + s.id + '"><span class="ric">🔗</span><span>Share</span></button>'
          + '<button class="rail-btn mute-btn" data-action="mute-shorts"><span class="ric">' + (shortsMuted ? '🔇' : '🔊') + '</span><span>Sound</span></button>'
          + '</div>'
          + '<div class="short-hint">Tap to pause</div>'
          + '</section>';
      }).join('') + '</div>';

      const io = new IntersectionObserver(es => es.forEach(en => {
        const vid = en.target;
        if (en.isIntersecting) {
          if (!vid.dataset.seen) { vid.dataset.seen = '1'; bumpViews(vid.parentElement.dataset.short); }
          vid.muted = shortsMuted;
          vid.play().catch(() => {});
        } else vid.pause();
      }), { threshold: 0.6 });
      $$('.shorts-feed video').forEach(v => io.observe(v));
      cleanups.push(() => io.disconnect());

      if (startId) {
        const el = $('.shorts-feed [data-short="' + startId + '"]');
        if (el) el.scrollIntoView({ block: 'start' });
      }
    });
  }

  /* ═══════════ VIEW: SUBSCRIPTIONS ═══════════ */
  function viewSubs() {
    const ids = Object.keys(S.subs);
    if (!ids.length) {
      main.innerHTML = emptyHTML('📺', 'No subscriptions yet',
        'Subscribe to channels you love and their newest videos land here.',
        '<a class="btn-neon" href="#/home">Browse channels</a>');
      return;
    }
    const chans = ids.map(id => YV.chMap[id]).filter(Boolean);
    const vids = orderByT(allContent().filter(v => v.ch !== 'me' && S.subs[v.ch] && v.type !== 'short'));
    const shs = orderByT(YV.SHORTS.filter(s => S.subs[s.ch]));
    main.innerHTML =
      '<h1 class="page-title">Subscriptions</h1>'
      + '<div class="sub-chips">' + chans.map(c =>
        '<a class="sub-chip" href="#/c/' + c.id + '">' + avatarHTML(c, 44) + '<span>' + esc(c.name) + '</span></a>').join('') + '</div>'
      + (vids.length ? '<div class="cards">' + vids.map(cardHTML).join('') + '</div>' : '<p class="muted-txt pad">No videos from these channels yet.</p>')
      + (shs.length ? shelf('⚡ Shorts from your subs', shs.map(shortCardHTML).join('')) : '');
  }

  /* ═══════════ VIEW: LIBRARY ═══════════ */
  function viewLibrary() {
    const hist = S.history.map(byId).filter(Boolean).slice(0, 12);
    const liked = Object.keys(S.likes).map(byId).filter(Boolean);
    const later = Object.keys(S.later).map(byId).filter(Boolean);
    const mine = S.myVideos.slice();
    const any = hist.length || liked.length || later.length || mine.length;

    main.innerHTML = '<h1 class="page-title">Library</h1>' + (!any
      ? emptyHTML('📚', 'Your library is empty', 'Watch, like and upload videos — they all collect here.', '<a class="btn-neon" href="#/home">Explore</a>')
      : (hist.length ? shelf('🕘 History', hist.map(cardHTML).join(''), '<button class="pill-btn ghost" data-action="clear-history">Clear all</button>') : '')
        + (liked.length ? shelf('❤️ Liked videos', liked.map(cardHTML).join('')) : '')
        + (later.length ? shelf('⏳ Watch later', later.map(cardHTML).join('')) : '')
        + (mine.length ? shelf('🎬 Your uploads', mine.map(cardHTML).join(''), '<a class="pill-btn ghost" href="#/channel">Manage</a>') : ''));
  }

  /* ═══════════ VIEW: MY CHANNEL ═══════════ */
  function viewMyChannel() {
    const c = S.myChannel;
    const vids = myVideos('video'), shrts = myVideos('short');
    const totalViews = S.myVideos.reduce((a, v) => a + (v.views || 0), 0);
    const totalLikes = S.myVideos.reduce((a, v) => a + likesOf(v), 0);

    main.innerHTML = '<div class="channel-page" data-scope="me">'
      + '<div class="banner"' + (c.banner ? ' style="background-image:url(' + c.banner + ')"' : ' style="--c1:' + c.colors[0] + ';--c2:' + c.colors[1] + '"') + '></div>'
      + '<div class="ch-head">'
      + '<span class="ch-ava">' + avatarHTML(meCh(), 96) + '</span>'
      + '<div class="ch-id"><h1 class="ch-name-big">' + esc(c.name) + '</h1>'
      + '<div class="ch-sub">' + esc(c.handle) + ' · <b>128 subscribers</b> · ' + fmtNum(totalViews) + ' views</div></div>'
      + '<div class="ch-actions"><a class="btn-neon" href="#/upload">＋ Upload</a>'
      + '<a class="pill-btn ghost" href="#/settings">⚙ Customize channel</a></div>'
      + '</div>'
      + '<div class="ch-tabs">'
      + '<button class="tab-btn on" data-action="tab" data-tab="vids">🎬 Videos</button>'
      + '<button class="tab-btn" data-action="tab" data-tab="about">💫 About</button>'
      + '</div>'
      + '<div class="tab-panel" data-panel="vids">'
      + (vids.length ? '<div class="cards">' + vids.map(v => cardHTML(v) ).join('') + '</div>'
        : emptyHTML('🎥', 'No videos yet', 'Your published videos will glow right here.', '<a class="btn-neon" href="#/upload">Upload your first video</a>'))
      + (shrts.length ? shelf('⚡ Your Shorts', shrts.map(shortCardHTML).join('')) : '')
      + (S.myVideos.length ? '<div class="manage-list"><h3 class="section-title">Manage uploads</h3>'
        + S.myVideos.map(v => '<div class="manage-row"><span class="mr-ico">' + (v.type === 'short' ? '⚡' : '🎬') + '</span>'
          + '<span class="mr-t">' + esc(v.title) + '</span>'
          + '<span class="mr-s">' + fmtNum(viewsOf(v)) + ' views · ' + fmtNum(likesOf(v)) + ' likes · ' + agoOf(v) + '</span>'
          + '<button class="pill-btn danger" data-action="del" data-id="' + v.id + '">Delete</button></div>').join('') + '</div>' : '')
      + '</div>'
      + '<div class="tab-panel hide" data-panel="about">'
      + '<div class="about-card"><h3>About</h3><p>' + esc(c.bio || 'No bio yet.').replace(/\n/g, '<br>') + '</p>'
      + '<div class="ch-stats"><span>📹 ' + S.myVideos.length + ' uploads</span><span>👁 ' + fmtNum(totalViews) + ' total views</span><span>❤️ ' + fmtNum(totalLikes) + ' likes received</span></div>'
      + '</div></div>'
      + '</div>';
  }

  /* ═══════════ VIEW: SEED CHANNEL ═══════════ */
  function viewChannel(id) {
    const c = YV.chMap[id];
    if (!c) { location.hash = '#/home'; return; }
    const vids = orderByT(YV.VIDEOS.concat(YV.SHORTS).filter(v => v.ch === id));
    main.innerHTML = '<div class="channel-page" data-scope="c">'
      + '<div class="banner def" style="--c1:' + c.colors[0] + ';--c2:' + c.colors[1] + '"></div>'
      + '<div class="ch-head">'
      + '<span class="ch-ava">' + avatarHTML(c, 96) + '</span>'
      + '<div class="ch-id"><h1 class="ch-name-big">' + esc(c.name) + (c.v ? ' <span class="vrf big">✓</span>' : '') + '</h1>'
      + '<div class="ch-sub">' + esc(c.handle) + ' · <b data-subs="' + c.id + '">' + fmtNum(subsOf(c)) + '</b> subscribers</div></div>'
      + subBtnHTML(c.id)
      + '</div>'
      + '<div class="ch-tabs">'
      + '<button class="tab-btn on" data-action="tab" data-tab="vids">🎬 Videos</button>'
      + '<button class="tab-btn" data-action="tab" data-tab="about">💫 About</button>'
      + '</div>'
      + '<div class="tab-panel" data-panel="vids">'
      + (vids.length ? '<div class="cards">' + vids.map(cardHTML).join('') + '</div>' : emptyHTML('🎥', 'No videos yet', 'This channel is warming up.'))
      + '</div>'
      + '<div class="tab-panel hide" data-panel="about">'
      + '<div class="about-card"><h3>About</h3><p>' + esc(c.tag) + '</p>'
      + '<div class="ch-stats"><span>🏷 ' + (vids[0] ? vids[0].cat : 'Vibes') + '</span><span>🎬 ' + vids.length + ' videos</span></div>'
      + '</div></div>'
      + '</div>';
  }

  /* ═══════════ comments ═══════════ */
  const seedCommentsFor = v => YV.COMMENTS[v.id] || YV.DEFAULT_COMMENTS;
  const userComments = id => S.comments[id] || [];
  const commentsCountFor = v => userComments(v.id).length + seedCommentsFor(v).length;

  function cItemHTML(c) {
    const pal = AV_PALETTES[hashHue(c.u) % AV_PALETTES.length];
    return '<div class="c-item">' + avatarHTML({ name: c.u, colors: pal }, 34)
      + '<div class="c-body"><div class="c-user">@' + esc(c.u) + ' <span>' + esc(c.h || 'just now') + '</span></div>'
      + '<p>' + esc(c.t) + '</p></div></div>';
  }

  function commentsHTML(v) {
    const list = userComments(v.id).concat(seedCommentsFor(v));
    return '<section class="comments" id="comments">'
      + '<h2 class="c-head" id="cHead">' + fmtNum(list.length) + ' Comments</h2>'
      + '<form class="c-input" data-form="comment" data-id="' + v.id + '">'
      + avatarHTML(meCh(), 36)
      + '<input name="ctext" placeholder="Add a comment…" maxlength="300" required>'
      + '<button class="pill-btn" type="submit">Comment</button></form>'
      + '<div class="c-list" id="cList">' + list.map(cItemHTML).join('') + '</div>'
      + '</section>';
  }

  /* ═══════════ VIEW: WATCH ═══════════ */
  function playerHTML(v, src) {
    if (!src) return '<div class="player error-box">⚠️ Video source unavailable</div>';
    const vert = v.type === 'short';
    return '<div class="player' + (vert ? ' vert' : '') + '" id="yvPlayer">'
      + '<video id="yvVideo" src="' + src + '" playsinline ' + (v.thumb ? 'poster="' + v.thumb + '" ' : '') + '></video>'
      + '<button class="big-play" id="yvBig" aria-label="Play">▶</button>'
      + '<div class="controls">'
      + '<div class="seek" id="yvSeek"><div class="seek-fill" id="yvFill"><i class="seek-knob"></i></div></div>'
      + '<div class="ctl-row">'
      + '<button class="ctl-btn" id="yvPlayB" title="Play / Pause (k)">⏸</button>'
      + '<button class="ctl-btn" id="yvMute" title="Mute (m)">🔊</button>'
      + '<input type="range" class="volume" id="yvVol" min="0" max="1" step="0.05" value="1">'
      + '<span class="time" id="yvTime">0:00 / 0:00</span>'
      + '<span class="ctl-spacer"></span>'
      + '<button class="ctl-btn" id="yvFull" title="Fullscreen (f)">⛶</button>'
      + '</div></div></div>';
  }

  function viewWatch(id) {
    const v = byId(id);
    if (!v) { location.hash = '#/home'; return; }
    bumpViews(id);
    addHistory(id);

    srcOf(v).then(src => {
      const ch = chOf(v);
      const related = pickRelated(v);

      main.innerHTML = '<div class="watch">'
        + '<div class="watch-main">'
        + playerHTML(v, src)
        + '<h1 class="w-title">' + esc(v.title) + '</h1>'
        + '<div class="w-row">'
        + '<a class="ch-link" href="#/' + (ch.isMe ? 'channel' : 'c/' + ch.id) + '">' + avatarHTML(ch, 42)
        + '<div><div class="wl-name">' + esc(ch.name) + (ch.v ? ' <span class="vrf">✓</span>' : '') + '</div>'
        + '<div class="wl-subs">' + (ch.isMe ? 'your channel' : fmtNum(subsOf(ch)) + ' subscribers') + '</div></div></a>'
        + subBtnHTML(v.ch)
        + '<span class="w-spacer"></span>'
        + likeGroupHTML(v)
        + '<button class="act-btn" data-action="share" data-id="' + v.id + '">🔗 Share</button>'
        + '<button class="act-btn' + (S.later[v.id] ? ' on' : '') + '" data-action="later" data-id="' + v.id + '">⏳ Later</button>'
        + (v.ch === 'me' ? '<button class="act-btn danger" data-action="del" data-id="' + v.id + '">🗑 Delete</button>' : '')
        + '</div>'
        + '<div class="w-desc"><b>' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + (v.cat ? ' · #' + esc(v.cat) : '') + '</b><br>' + esc(v.desc || '') + '</div>'
        + commentsHTML(v)
        + '</div>'
        + '<aside class="related"><h2 class="section-title">Up next ⚡</h2>'
        + related.map(relCardHTML).join('')
        + '</aside></div>';

      initPlayer();
    });
  }

  function pickRelated(v) {
    const pool = allContent().filter(x => x.id !== v.id);
    const same = pool.filter(x => x.cat === v.cat);
    const rest = pool.filter(x => x.cat !== v.cat);
    return same.concat(rest).slice(0, 10);
  }

  function initPlayer() {
    const P = $('#yvPlayer'); if (!P) return;
    const V = $('#yvVideo'), big = $('#yvBig'), playB = $('#yvPlayB'), muteB = $('#yvMute'),
      vol = $('#yvVol'), timeEl = $('#yvTime'), seek = $('#yvSeek'), fill = $('#yvFill'), full = $('#yvFull');

    const fmt = s => { if (!isFinite(s)) return '0:00'; s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };
    const setFill = p => fill.style.width = (p * 100) + '%';

    function sync() {
      playB.textContent = V.paused ? '▶' : '⏸';
      big.classList.toggle('hide', !V.paused);
      muteB.textContent = (V.muted || V.volume === 0) ? '🔇' : '🔊';
    }

    V.addEventListener('play', sync); V.addEventListener('pause', sync); V.addEventListener('volumechange', sync);
    V.addEventListener('timeupdate', () => { const d = V.duration || 0; setFill(d ? V.currentTime / d : 0); timeEl.textContent = fmt(V.currentTime) + ' / ' + fmt(d); });
    V.addEventListener('error', () => {
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
  function viewResults(q) {
    const term = (q.get('q') || '').trim().toLowerCase();
    $('#searchInput').value = q.get('q') || '';
    const res = term
      ? orderByT(allContent().filter(v =>
          v.title.toLowerCase().includes(term) ||
          chOf(v).name.toLowerCase().includes(term) ||
          (v.cat || '').toLowerCase().includes(term)))
      : [];
    main.innerHTML = '<h1 class="page-title">Results for “' + esc(term) + '”</h1>'
      + (res.length
        ? '<div class="results-list">' + res.map(v => {
            const ch = chOf(v);
            return '<a class="res-row" href="#/watch/' + v.id + '">'
              + '<div class="thumb wide" style="--c1:' + ch.colors[0] + ';--c2:' + ch.colors[1] + '">'
              + (v.thumb ? '<img loading="lazy" src="' + v.thumb + '" alt="" onerror="this.style.display=\'none\'">' : '')
              + '<span class="thumb-ghost' + (v.thumb ? ' small' : '') + '">' + (v.emo || '▶') + '</span>'
              + (v.dur ? '<span class="dur">' + v.dur + '</span>' : '') + '</div>'
              + '<div class="cc-txt"><h3>' + esc(v.title) + '</h3>'
              + '<div class="v-stats">' + fmtNum(viewsOf(v)) + ' views · ' + agoOf(v) + '</div>'
              + '<div class="ch-name">' + esc(ch.name) + '</div>'
              + '<p class="res-desc">' + esc((v.desc || '').slice(0, 120)) + '…</p></div></a>';
          }).join('') + '</div>'
        : emptyHTML('🔍', 'No vibes found', 'Nothing matches “' + esc(term) + '”. Try another search.', '<a class="btn-neon" href="#/home">Back home</a>'));
  }

  /* ═══════════ media helpers (upload flow) ═══════════ */
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
      + '<p class="muted-txt">MP4 / WebM — the file is stored <b>in your own browser</b> (IndexedDB). Nobody else can see it.</p>'
      + '<div class="up-grid">'
      + '<div class="dropzone" id="dz"><input type="file" id="fileIn" accept="video/*" hidden>'
      + '<div class="dz-ico">🎬</div>'
      + '<div class="dz-t">Drag &amp; drop your video here</div>'
      + '<div class="dz-s">or <span class="dz-browse">browse files</span></div>'
      + '<div class="dz-name" id="dzName"></div></div>'
      + '<form class="up-form" id="upForm" novalidate>'
      + '<div class="field"><label>Title</label><input id="upTitle" maxlength="90" placeholder="Give it a neon title…" required></div>'
      + '<div class="field"><label>Description</label><textarea id="upDesc" rows="4" placeholder="Tell the vibe…"></textarea></div>'
      + '<div class="field-row">'
      + '<div class="field"><label>Category</label><select id="upCat">' + YV.CATS.map(c => '<option>' + c + '</option>').join('') + '</select></div>'
      + '<div class="field"><label>Type</label><div class="radio-row">'
      + '<label class="rd"><input type="radio" name="upType" value="video" checked> 🎥 Video</label>'
      + '<label class="rd"><input type="radio" name="upType" value="short"> ⚡ Short</label>'
      + '</div></div></div>'
      + '<div class="up-preview hide" id="upPrev"><video id="prevVid" controls muted playsinline></video><div class="up-meta" id="upMeta"></div></div>'
      + '<div class="form-err" id="upErr"></div>'
      + '<button class="btn-neon publish" id="publish" type="submit" disabled>🚀 Publish</button>'
      + '</form></div></div>';

    const dz = $('#dz'), fileIn = $('#fileIn'), dzName = $('#dzName'),
      prevWrap = $('#upPrev'), prevVid = $('#prevVid'), upMeta = $('#upMeta'),
      upTitle = $('#upTitle'), upErr = $('#upErr'), publish = $('#publish');

    let file = null, objUrl = null, dur = 0, thumbData = null;

    const err = m => { upErr.textContent = m || ''; };

    dz.addEventListener('click', e => { if (e.target === fileIn) return; fileIn.click(); });
    ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handle(f); });
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) handle(fileIn.files[0]); });

    function handle(f) {
      if (!f.type.startsWith('video/')) { err('⚠️ Please choose a video file (MP4, WebM…).'); return; }
      err(''); file = f;
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(f);
      dzName.textContent = '📦 ' + f.name + ' (' + fmtSize(f.size) + ')';
      dz.classList.add('has');
      prevWrap.classList.remove('hide');
      prevVid.src = objUrl;
      if (!upTitle.value) upTitle.value = prettyName(f.name);
      upMeta.textContent = 'Reading video…';
      probeVideo(objUrl).then(m => {
        dur = m.dur;
        return captureThumb(objUrl);
      }).then(th => {
        thumbData = th;
        upMeta.textContent = (dur ? '⏱ Duration ' + fmtDur(dur) : '')
          + (th ? ' · ✅ thumbnail captured automatically' : ' · using neon placeholder thumbnail');
        publish.disabled = false;
      });
    }

    $('#upForm').addEventListener('submit', async e => {
      e.preventDefault();
      if (!file) { err('⚠️ Pick a video first.'); return; }
      const title = upTitle.value.trim() || 'Untitled vibe';
      const type = $('input[name="upType"]:checked').value;
      publish.disabled = true; publish.textContent = '⏳ Publishing…';
      const id = 'u' + Date.now().toString(36);
      try {
        await YV.store.putBlob(id, file);
      } catch (ex) {
        err('⚠️ Storage failed — your browser blocked IndexedDB.');
        publish.disabled = false; publish.textContent = '🚀 Publish';
        return;
      }
      S.myVideos.unshift({
        id, title,
        desc: $('#upDesc').value.trim(),
        cat: $('#upCat').value,
        type,
        dur: fmtDur(dur),
        thumb: thumbData,
        blobKey: id,
        views: 0, likes: 0,
        createdAt: Date.now(),
        ch: 'me',
      });
      YV.store.save();
      toast('Published to YourVibe!', '🎉');
      location.hash = '#/watch/' + id;
    });
  }

  /* ═══════════ VIEW: SETTINGS ═══════════ */
  function viewSettings() {
    const c = S.myChannel;
    main.innerHTML = '<div class="page set-page">'
      + '<h1 class="page-title">Customize your channel</h1>'
      + '<div class="set-grid">'
      + '<div class="set-col">'
      + '<div class="preview-card">'
      + '<div class="banner prev' + (c.banner ? ' has-img' : '') + '"' + (c.banner ? ' style="background-image:url(' + c.banner + ')"' : ' style="--c1:' + c.colors[0] + ';--c2:' + c.colors[1] + '"') + ' id="prevBanner"></div>'
      + '<div class="prev-head">' + '<span id="prevAva">' + avatarHTML(meCh(), 72) + '</span>'
      + '<div><h3 id="prevName">' + esc(c.name) + '</h3><div class="muted-txt" id="prevHandle">' + esc(c.handle) + '</div></div></div>'
      + '</div>'
      + '<div class="about-card"><h3>⚠️ Danger zone</h3><p class="muted-txt">Wipes likes, subscriptions, history, uploads and channel settings.</p>'
      + '<button class="pill-btn danger" data-action="reset-all">Reset ALL YourVibe data</button></div>'
      + '</div>'
      + '<form class="up-form" id="setForm">'
      + '<div class="field"><label>Channel name</label><input id="stName" maxlength="40" value="' + esc(c.name) + '" required></div>'
      + '<div class="field"><label>Handle</label><input id="stHandle" maxlength="30" value="' + esc(c.handle) + '" placeholder="@handle"></div>'
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
      $('#avaMsg').textContent = avaData ? '✅ ready' : '⚠️ could not read image';
      if (avaData) $('#prevAva').innerHTML = '<span class="av av-img" style="width:72px;height:72px"><img src="' + avaData + '"></span>';
    };
    $('#banIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      $('#banMsg').textContent = 'processing…';
      banData = await imageToDataURL(f, 960, 220);
      $('#banMsg').textContent = banData ? '✅ ready' : '⚠️ could not read image';
      if (banData) { const b = $('#prevBanner'); b.classList.add('has-img'); b.style.backgroundImage = 'url(' + banData + ')'; }
    };
    $('#stName').oninput = e => $('#prevName').textContent = e.target.value || '…';
    $('#stHandle').oninput = e => $('#prevHandle').textContent = e.target.value || '@handle';

    $('#setForm').onsubmit = e => {
      e.preventDefault();
      const name = $('#stName').value.trim(), handle = $('#stHandle').value.trim();
      if (!name) { $('#stErr').textContent = '⚠️ Channel name is required.'; return; }
      S.myChannel.name = name;
      S.myChannel.handle = handle.startsWith('@') ? handle : '@' + (handle || 'you');
      S.myChannel.bio = $('#stBio').value.trim();
      S.myChannel.avatar = avaData;
      S.myChannel.banner = banData;
      YV.store.save();
      renderMe();
      toast('Channel updated', '✨');
      location.hash = '#/channel';
    };
  }

  /* ═══════════ state toggles + UI sync ═══════════ */
  function toggleLike(id) {
    if (S.likes[id]) { delete S.likes[id]; }
    else { S.likes[id] = 1; delete S.dislikes[id]; toast('Added to Liked videos', '❤️'); }
    YV.store.save();
    updateLikeUI(id);
  }

  function toggleDislike(id) {
    if (S.dislikes[id]) delete S.dislikes[id]; else { S.dislikes[id] = 1; delete S.likes[id]; }
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

  function toggleSub(chId) {
    if (S.subs[chId]) { delete S.subs[chId]; toast('Unsubscribed', '👋'); }
    else { S.subs[chId] = 1; toast('Subscribed! New uploads will appear in Subscriptions', '🔔'); }
    YV.store.save();
    updateSubUI(chId);
  }

  function updateSubUI(chId) {
    const on = isSub(chId);
    $$('[data-action="sub"][data-ch="' + chId + '"]').forEach(b => {
      b.classList.toggle('subbed', on);
      b.innerHTML = on ? '🔔 Subscribed' : 'Subscribe';
    });
    const c = YV.chMap[chId];
    const cnt = $('[data-subs="' + chId + '"]');
    if (c && cnt) cnt.textContent = fmtNum(subsOf(c));
  }

  function toggleLater(id) {
    if (S.later[id]) { delete S.later[id]; toast('Removed from Watch later', '⏳'); }
    else { S.later[id] = 1; toast('Saved to Watch later', '⏳'); }
    YV.store.save();
    $$('[data-action="later"][data-id="' + id + '"]').forEach(b => {
      b.classList.toggle('on', !!S.later[id]);
      b.textContent = (S.later[id] ? '⏳ Saved' : '⏳ Later');
      if (b.classList.contains('later-btn')) b.textContent = S.later[id] ? '✓' : '＋';
    });
  }

  function doShare(id) {
    const url = (location.origin && location.origin.startsWith('http') ? location.origin + location.pathname : location.href.split('#')[0]) + '#/watch/' + id;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard', '🔗'), () => toast('Share: ' + url, '🔗'));
    } else toast('Share: ' + url, '🔗');
  }

  function doDelete(id) {
    if (!confirm('Delete this video forever?')) return;
    S.myVideos = S.myVideos.filter(v => v.id !== id);
    delete S.likes[id]; delete S.dislikes[id]; delete S.later[id];
    S.history = S.history.filter(x => x !== id);
    YV.store.save();
    YV.store.delBlob(id);
    toast('Video deleted', '🗑');
    if (('#/watch/' + id) === location.hash) location.hash = '#/channel';
    else navigate();
  }

  function renderMe() {
    $('#meAvatar').innerHTML = avatarHTML(meCh(), 36);
  }

  /* ═══════════ global events ═══════════ */
  document.addEventListener('click', e => {
    // shorts: tap video → play/pause
    const sv = e.target.closest('.short video');
    if (sv) { sv.paused ? sv.play().catch(() => {}) : sv.pause(); return; }

    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action, id = t.dataset.id;

    if (a === 'like') toggleLike(id);
    else if (a === 'dislike') toggleDislike(id);
    else if (a === 'sub') toggleSub(t.dataset.ch);
    else if (a === 'share') doShare(id);
    else if (a === 'del') doDelete(id);
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
      if (!confirm('Reset ALL YourVibe data? (likes, subs, uploads, channel — everything)')) return;
      YV.store.wipeAll().then(() => location.reload());
    }
    else if (a === 'tab') {
      const scope = t.closest('[data-scope]');
      $$('.tab-btn', scope).forEach(b => b.classList.toggle('on', b === t));
      $$('.tab-panel', scope).forEach(p => p.classList.toggle('hide', p.dataset.panel !== t.dataset.tab));
    }
  });

  document.addEventListener('submit', e => {
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
      (S.comments[vid] = S.comments[vid] || []).unshift({ u: S.myChannel.name, t: text, h: 'just now' });
      YV.store.save();
      const list = $('#cList'); if (list) list.insertAdjacentHTML('afterbegin', cItemHTML({ u: S.myChannel.name, t: text, h: 'just now' }));
      const head = $('#cHead');
      if (head) head.textContent = fmtNum(userComments(vid).length + seedCommentsFor(byId(vid)).length) + ' Comments';
      input.value = '';
      toast('Comment posted', '💬');
    }
  });

  /* ═══════════ router ═══════════ */
  const routes = [
    [/^\/?$/,                 q => viewHome(q)],
    [/^\/home$/,              q => viewHome(q)],
    [/^\/shorts\/?(.+)?$/,    (m, q) => viewShorts(m[1])],
    [/^\/subscriptions$/,     () => viewSubs()],
    [/^\/library$/,           () => viewLibrary()],
    [/^\/upload$/,            () => viewUpload()],
    [/^\/settings$/,          () => viewSettings()],
    [/^\/channel$/,           () => viewMyChannel()],
    [/^\/c\/([\w-]+)$/,       m => viewChannel(m[1])],
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
        m[1] !== undefined ? fn(m, query) : fn(query);
        return;
      }
    }
    location.hash = '#/home';
  }

  /* ═══════════ boot ═══════════ */
  if (!S.myChannel) { S.myChannel = JSON.parse(JSON.stringify(YV.MY_DEFAULT)); YV.store.save(); }
  renderMe();
  window.addEventListener('hashchange', navigate);
  navigate();
})();
