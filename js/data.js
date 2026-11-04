/* ═══════════════════════════════════════════════════════
   YourVibe — App constants
   The feed is real now: all videos come from the server
   (uploaded by users). No demo/fake content.
   ═══════════════════════════════════════════════════════ */
window.YV = window.YV || {};

(function () {
  YV.CATS = ['Music', 'Gaming', 'Tech', 'Art', 'Cars', 'Fitness', 'Vlogs', 'Fun', 'Other'];

  /* uploads: ~50MB per segment is recommended; bigger videos are split
     automatically client-side and re-assembled when streaming */
  YV.PART_MB = 45;
  YV.MAX_PARTS = 46;   /* 46 × 45MB ≈ 2GB */
  YV.MAX_MB = 2048;
  YV.MAX_LABEL = '2 GB';

  /* your local creator identity (only your browser needs it) */
  YV.MY_DEFAULT = {
    name: 'Vibe Master',
    bio: 'Welcome to my channel ⚡',
    avatar: null,
    banner: null,
    colors: ['#ff2bd6', '#00e5ff'],
  };
})();
