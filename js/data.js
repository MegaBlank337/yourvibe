/* ═══════════════════════════════════════════════════════
   YourVibe — Seed Data
   Channels, videos, shorts & starter comments.
   Sample media from free public CDNs (no key needed):
     media.w3.org · test-videos.co.uk · cdn.plyr.io
     cdn.jsdelivr.net · MDN examples · learningcontainer
   ═══════════════════════════════════════════════════════ */
window.YV = window.YV || {};

(function () {
  const W3   = 'https://media.w3.org/2010/05/';
  const TV   = 'https://test-videos.co.uk/vids/';
  const PLYR = 'https://cdn.plyr.io/static/demo/';
  const JSD  = 'https://cdn.jsdelivr.net/gh/mediaelement/mediaelement-files@master/';
  const MDN  = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/';
  const LC   = 'https://www.learningcontainer.com/wp-content/uploads/2020/05/';

  YV.CATS = ['Music', 'Gaming', 'Tech', 'Art', 'Cars', 'Fitness', 'Vlogs'];

  /* ── Channels ─────────────────────────────── */
  YV.CHANNELS = [
    { id: 'synthwave',   name: 'SynthWave TV', handle: '@synthwavetv', subs: 1240000, v: true,  tag: 'Retro-futuristic sounds & visual mixes, uploaded weekly.',          colors: ['#ff2bd6', '#7b2ff7'] },
    { id: 'cybergamerz', name: 'CyberGamerz',  handle: '@cybergamerz',  subs: 892000,  v: true,  tag: 'Competitive gameplay, boss fights and ranked meltdowns.',         colors: ['#00e5ff', '#2d6bff'] },
    { id: 'neonpixl',    name: 'NeonPixl',     handle: '@neonpixl',     subs: 2340000, v: true,  tag: 'Digital art, animation remasters and glow aesthetics.',           colors: ['#39ff14', '#00e5ff'] },
    { id: 'vibecoder',   name: 'Vibe Coder',   handle: '@vibecoder',    subs: 451000,  v: false, tag: 'Building weird software at 3AM. Mostly works.',                   colors: ['#ff2bd6', '#ff9d00'] },
    { id: 'retrodrive',  name: 'RetroDrive',   handle: '@retrodrive',   subs: 678000,  v: true,  tag: 'Night drives, coast runs and neon garages.',                       colors: ['#8a2be2', '#ff2bd6'] },
    { id: 'glitchfit',   name: 'GlitchFit',    handle: '@glitchfit',    subs: 305000,  v: false, tag: 'Workouts that hit like a bass drop.',                             colors: ['#00ffa3', '#00e5ff'] },
  ];
  YV.chMap = {};
  YV.CHANNELS.forEach(c => YV.chMap[c.id] = c);

  /* ── Videos (t = hours ago, used for sorting) ── */
  YV.VIDEOS = [
    { id:'v1',  title:'Neon Bunny — Animated Classic Gets a Glow-Up',   ch:'neonpixl',    cat:'Art',     emo:'🐰', views:2845102, t:336, ago:'2 weeks ago', dur:'1:00', likes:184320, src:JSD+'big_buck_bunny.mp4',       desc:'The 2008 classic regraded in neon pinks & cyans. Watch the fur catch the neon light. Full short, no interruptions.' },
    { id:'v2',  title:'Dream Machine — Cinematic Ocean Visual Mix',     ch:'synthwave',   cat:'Music',   emo:'🌊', views:1204553, t:720, ago:'1 month ago', dur:'3:03', likes:88231,  src:PLYR+'View_From_A_Blue_Moon_Trailer-576p.mp4', desc:'A cinematic voyage over glassy waves, tuned to analog synth. Perfect for coding, chilling or drifting.' },
    { id:'v3',  title:'SINTEL — Fantasy Trailer · Neon Grade',          ch:'neonpixl',    cat:'Art',     emo:'🐉', views:982311,  t:72,  ago:'3 days ago',   dur:'0:52', likes:71002,  src:W3+'sintel/trailer.mp4',        desc:'A girl, a dragon and a whole lot of feelings — restyled with a cold neon palette. Grab tissues.' },
    { id:'v4',  title:'Starship Meltdown — Sci-Fi Marathon Highlights', ch:'cybergamerz', cat:'Gaming',  emo:'🚀', views:3120774, t:120, ago:'5 days ago',   dur:'5:00', likes:265410, src:W3+'video/movie_300.mp4',      desc:'Five minutes of pure retro sci-fi chaos. The bridge crew has absolutely no chill. Full highlights cut.' },
    { id:'v5',  title:'Street & Dirt — Daily Drive Diary EP.7',         ch:'retrodrive',  cat:'Cars',    emo:'🏎️', views:456900,  t:240, ago:'10 days ago',  dur:'2:06', likes:30877,  src:LC+'sample-mp4-file.mp4',       desc:'Taking the daily from wet asphalt to gravel and back. Neon garage cam included.' },
    { id:'v6',  title:'I Remastered a Cult Trailer with Neon AI',       ch:'vibecoder',   cat:'Tech',    emo:'🤖', views:208441,  t:96,  ago:'4 days ago',   dur:'0:33', likes:18220,  src:W3+'bunny/trailer.mp4',        desc:'One cult-classic trailer, one very confused AI, thirty-three seconds of questionable glory. It works… mostly.' },
    { id:'v7',  title:'Sunset Coast Run — Drone POV',                   ch:'retrodrive',  cat:'Cars',    emo:'🌅', views:891245,  t:50,  ago:'2 days ago',   dur:'3:03', likes:64200,  src:PLYR+'View_From_A_Blue_Moon_Trailer-576p.mp4', desc:'Golden hour, empty coast road, drone locked on. Headphones on, volume up.' },
    { id:'v8',  title:'Friday Night Vibes — Micro Short Film',          ch:'vibecoder',   cat:'Vlogs',   emo:'🌃', views:655219,  t:200, ago:'1 week ago',   dur:'0:06', likes:51002,  src:MDN+'friday.mp4',               desc:'Six seconds. One feeling. That moment the week finally ends. Shot on a webcam from 2009 for authenticity.' },
    { id:'v9',  title:'Boss Fight of the Week — Full Clip',             ch:'cybergamerz', cat:'Gaming',  emo:'🎮', views:1478002, t:30,  ago:'yesterday',    dur:'1:00', likes:120455, src:JSD+'big_buck_bunny.mp4',      desc:'A fluffy final boss you do NOT want to underestimate. No cuts, pure gameplay.' },
    { id:'v10', title:'Underwater Drone Cam — First Test',              ch:'vibecoder',   cat:'Tech',    emo:'🪼', views:302118,  t:64,  ago:'3 days ago',   dur:'0:10', likes:27731,  src:TV+'jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4', desc:'Built a neon underwater drone in the garage. First ten seconds of footage — it works!!' },
    { id:'v11', title:'10-Second Sprint Challenge 💥',                  ch:'glitchfit',   cat:'Fitness', emo:'🏃', views:540932,  t:150, ago:'6 days ago',   dur:'0:10', likes:41890,  src:TV+'bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4', desc:'Ten seconds. All out. Tag your time below. No excuses.' },
    { id:'v12', title:'Neon Bloom — Ambient Loop',                      ch:'synthwave',   cat:'Music',   emo:'🌼', views:134002,  t:600, ago:'3 weeks ago',  dur:'0:05', likes:9903,   src:MDN+'flower.mp4',              desc:'A single bloom, glowing on loop. Put it on repeat and pretend the deadline does not exist.' },
  ];

  /* ── Shorts ───────────────────────────────── */
  YV.SHORTS = [
    { id:'s1', title:'When the drop hits and the city goes neon 🔥', ch:'retrodrive',  cat:'Cars',    emo:'🐰', views:4102330, t:26, ago:'1 day ago',   dur:'0:10', likes:390221, src:TV+'bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4', desc:'Full send.' },
    { id:'s2', title:'Mobility flow be like 🪼',                     ch:'glitchfit',   cat:'Fitness', emo:'🪼', views:2201445, t:44, ago:'2 days ago',  dur:'0:10', likes:188302, src:TV+'jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',           desc:'Stretch like jelly.' },
    { id:'s3', title:'POV: boss fight intro 💀',                     ch:'cybergamerz', cat:'Gaming',  emo:'🐉', views:8804210, t:12, ago:'6 hours ago', dur:'0:10', likes:720884, src:TV+'sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',               desc:'You will lose.' },
    { id:'s4', title:'10 seconds of pure serotonin 🐰',              ch:'vibecoder',   cat:'Tech',    emo:'⚡', views:1902881, t:68, ago:'3 days ago',  dur:'0:10', likes:150033, src:TV+'bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4', desc:'Reset complete.' },
    { id:'s5', title:'Epic trailer energy at 2am 🌆',                ch:'synthwave',   cat:'Music',   emo:'🎧', views:3303771, t:90, ago:'4 days ago',  dur:'0:10', likes:290455, src:TV+'sintel/mp4/h264/720/Sintel_720_10s_2MB.mp4',               desc:'Volume to 100.' },
    { id:'s6', title:'Floating in neon jelly space 🪼✨',            ch:'neonpixl',    cat:'Art',     emo:'✨', views:5602330, t:40, ago:'2 days ago',  dur:'0:10', likes:480221, src:TV+'jellyfish/mp4/h264/720/Jellyfish_720_10s_2MB.mp4',           desc:'No thoughts, only glow.' },
    { id:'s7', title:'Big bunny energy 🐰💥',                        ch:'cybergamerz', cat:'Gaming',  emo:'💥', views:1250221, t:110, ago:'5 days ago', dur:'0:10', likes:99022,  src:TV+'bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4', desc:'Fluffy but deadly.' },
    { id:'s8', title:'10-second stretch reset ⚡',                    ch:'glitchfit',   cat:'Fitness', emo:'🏃', views:2750902, t:160, ago:'1 week ago', dur:'0:10', likes:230144, src:TV+'sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',               desc:'Desk workers, this one is for you.' },
  ];

  /* ── Starter comments ─────────────────────── */
  YV.COMMENTS = {
    v1: [
      { u:'PixelWitch', t:'The glow-up is INSANE 🔥 that palette is pure neon candy.', h:'2 days ago' },
      { u:'Zed',        t:'Came for the bunny, stayed for the vibes ⚡', h:'1 day ago' },
      { u:'nova.exe',   t:'This belongs in a synthwave museum 🖤', h:'14 hours ago' },
    ],
    v3: [
      { u:'glowbug',    t:'The color grade on the snow scenes… chef kiss 💜', h:'1 day ago' },
      { u:'synthkid',   t:'Sintel deserved better and you gave her neon ✨', h:'20 hours ago' },
    ],
    v4: [
      { u:'RezzFan99',  t:'That bridge crew has zero survival instinct and I love it 💀', h:'3 days ago' },
      { u:'v1be',       t:'The slow-mo at the halfway point is unreal. Rewatched 10x.', h:'2 days ago' },
      { u:'Nova',       t:'Rendering this era of CGI in real time is actual witchcraft 🧙', h:'1 day ago' },
    ],
    v9: [
      { u:'Zed',        t:'Fluffiest final boss of the year 😭', h:'22 hours ago' },
      { u:'glitchlord', t:'Tried this fight. Muted mic. Saved soul. 10/10.', h:'10 hours ago' },
    ],
  };

  YV.DEFAULT_COMMENTS = [
    { u:'glowbug',  t:'The algorithm brought me here and I am NOT mad ⚡', h:'3 days ago' },
    { u:'synthkid', t:'Watching this at 2am hits different 🌃', h:'1 day ago' },
  ];

  /* ── Your channel defaults (editable in Settings) ── */
  YV.MY_DEFAULT = {
    name: 'Vibe Master',
    handle: '@vibemaster',
    bio: 'Welcome to my channel ⚡ New vibes every week.\nSubscribe to catch the glow.',
    avatar: null,
    banner: null,
    colors: ['#ff2bd6', '#00e5ff'],
  };
})();
