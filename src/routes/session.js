const express = require('express');
const router = express.Router();
const { createSession, sendMessage, getSession, deleteSession } = require('../lib/sessions');

// Middleware: validate API key
router.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// GET /session/:operatorId/qr — start session and return QR
router.get('/:operatorId/qr', async (req, res) => {
  try {
    const { operatorId } = req.params;
    const session = await createSession(operatorId);

    if (session.status === 'connected') {
      return res.json({ status: 'connected' });
    }

    // Wait up to 15s for QR to appear
    let attempts = 0;
    while (!session.qrBase64 && attempts < 30) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    if (!session.qrBase64) {
      return res.status(202).json({ status: 'connecting' });
    }

    return res.json({ status: 'qr', qr: session.qrBase64 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /session/:operatorId/status
router.get('/:operatorId/status', (req, res) => {
  const { operatorId } = req.params;
  const session = getSession(operatorId);
  if (!session) return res.json({ status: 'inactive' });
  res.json({ status: session.status });
});

// POST /session/:operatorId/send
router.post('/:operatorId/send', async (req, res) => {
  try {
    const { operatorId } = req.params;
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required' });
    }

    await sendMessage(operatorId, phone, message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /session/:operatorId — logout
router.delete('/:operatorId', (req, res) => {
  const { operatorId } = req.params;
  deleteSession(operatorId);
  res.json({ ok: true });
});

module.exports = { sessionRouter: router };
