require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { sessionRouter } = require('./routes/session');
const { createSession } = require('./lib/sessions');

const app = express();
const PORT = process.env.PORT || 3001;

// Auto-restore existing sessions on startup
const sessionsDir = path.join(__dirname, '../sessions');
if (fs.existsSync(sessionsDir)) {
  const operators = fs.readdirSync(sessionsDir);
  operators.forEach(operatorId => {
    console.log(`Restaurando sesion del operador ${operatorId}...`);
    createSession(operatorId);
  });
}

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
