// bot-hosting entry point: the panel runs `node index.js` (STARTUP_FILE is system-locked)
// crash guards: a bad request or async error must NEVER take the whole site down
process.on('uncaughtException', e => console.error('[guard] uncaughtException:', (e && e.message) || e));
process.on('unhandledRejection', e => console.error('[guard] unhandledRejection:', (e && (e.message || e)) || e));
require('./server.js');
