require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { sessionRouter } = require('./routes/session');

const app = express();
const PORT = process.env.PORT || 3001;

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
