require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { sessionRouter } = require('./routes/session');
const { createSession } = require('./lib/sessions');

const app = express();
const PORT = process.env.PORT || 3001;

// Auto-restore sessions from Supabase Storage on startup
const { supabase: sb } = require('./lib/supabase');
(async () => {
  try {
    const { data: folders } = await sb.storage.from('whatsapp-sessions').list();
    if (folders && folders.length > 0) {
      for (const folder of folders) {
        console.log(`Restaurando sesion del operador ${folder.name}...`);
        createSession(folder.name);
      }
    }
  } catch (err) {
    console.error('Error restaurando sesiones:', err.message);
  }
})();

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Health check (keeps Render awake via UptimeRobot)
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.use('/session', sessionRouter);

app.listen(PORT, () => {
  console.log(`WhatsApp Service running on port ${PORT}`);
});
