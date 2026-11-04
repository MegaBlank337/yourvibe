/* ═══════════════════════════════════════════════════════
   YourVibe — optional Node/Express server
   Only needed if you deploy as a Render "Web Service".
   (For Render "Static Site" you don't need this file at all.)
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// serve everything in this folder (index.html, css/, js/)
app.use(express.static(__dirname));

// any other route → send the app (hash router handles the rest)
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log('⚡ YourVibe running on port ' + PORT));
