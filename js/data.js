/* ═══════════════════════════════════════════════════════
   YourVibe — App constants
   The feed is real now: all videos come from the server
   (uploaded by users). No demo/fake content.
   ═══════════════════════════════════════════════════════ */
window.YV = window.YV || {};

(function () {
  YV.CATS = ['Music', 'Gaming', 'Tech', 'Art', 'Cars', 'Fitness', 'Vlogs', 'Fun', 'Other'];

  /* max upload size the API accepts (MB) — matches Supabase free tier */
  YV.MAX_MB = 50;

  /* your local creator identity (only your browser needs it) */
  YV.MY_DEFAULT = {
    name: 'Vibe Master',
    bio: 'Welcome to my channel ⚡',
    avatar: null,
    banner: null,
    colors: ['#ff2bd6', '#00e5ff'],
  };
})();
