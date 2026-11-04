/* ═══════════════════════════════════════════════════════
   YourVibe — Storage
   • localStorage  → likes, subs, history, comments, settings
   • IndexedDB     → uploaded video files (binary blobs)
   Falls back to an in-memory map if IndexedDB is blocked.
   ═══════════════════════════════════════════════════════ */
window.YV = window.YV || {};

YV.store = (function () {
  const LS_KEY = 'yourvibe_v1';

  const state = {
    likes: {},      // { videoId: 1 }
    dislikes: {},   // { videoId: 1 }
    subs: {},       // { channelId: 1 }
    later: {},      // { videoId: 1 }  (watch later)
    history: [],    // [videoId, …] newest first
    comments: {},   // { videoId: [{u,t,h}] } user comments
    over: {},       // { videoId: extraViews } view counter overlay
    myChannel: null,// configured in Settings
    myDelKeys: {},  // { videoId: secret delete key } for uploads from this browser
    myVideos: [],   // (legacy, unused)
  };

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      for (const k in state) if (s[k] !== undefined) state[k] = s[k];
    } catch (e) { console.warn('YourVibe: could not read saved state', e); }
  }

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('YourVibe: storage full or blocked', e);
    }
  }

  /* ── IndexedDB for video blobs ── */
  let db = null;
  const memStore = {}; // fallback

  function openDB() {
    if (db) return Promise.resolve(db);
    if (!window.indexedDB) return Promise.resolve(null);
    return new Promise(resolve => {
      const rq = indexedDB.open('yourvibe', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('blobs');
      rq.onsuccess = () => { db = rq.result; resolve(db); };
      rq.onerror   = () => resolve(null);
    });
  }

  function putBlob(key, blob) {
    return openDB().then(d => {
      if (!d) { memStore[key] = blob; return true; }
      return new Promise((resolve, reject) => {
        const tx = d.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').put(blob, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  function getBlob(key) {
    return openDB().then(d => {
      if (!d) return memStore[key] || null;
      return new Promise(resolve => {
        const tx = d.transaction('blobs', 'readonly');
        const rq = tx.objectStore('blobs').get(key);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => resolve(null);
      });
    });
  }

  function delBlob(key) {
    return openDB().then(d => {
      if (!d) { delete memStore[key]; return true; }
      return new Promise(resolve => {
        const tx = d.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(true);
      });
    });
  }

  function wipeBlobs() {
    return openDB().then(d => {
      if (!d) { Object.keys(memStore).forEach(k => delete memStore[k]); return true; }
      return new Promise(resolve => {
        const tx = d.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(true);
      });
    });
  }

  function wipeAll() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    return wipeBlobs();
  }

  load();

  return { state, save, putBlob, getBlob, delBlob, wipeBlobs, wipeAll, LS_KEY };
})();
