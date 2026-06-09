const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const path = require('path');
const { supabase } = require('./supabase');

// Map of active sessions: operatorId -> { socket, qr, status }
const sessions = new Map();

function getSessionDir(operatorId) {
  return path.join(__dirname, '../../sessions', String(operatorId));
}

async function saveMessageToSupabase(operatorId, msg, direction) {
  try {
    const phone = direction === 'inbound'
      ? msg.key.remoteJid.replace('@s.whatsapp.net', '')
      : msg.key.remoteJid.replace('@s.whatsapp.net', '');

    const content = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || '';

    if (!content) return;

    // Find contact by phone in Supabase
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, company_id')
      .eq('phone', `+${phone}`)
      .eq('operator_id', Number(operatorId))
      .single();

    if (!contact) return;

    await supabase.from('messages').insert({
      company_id: contact.company_id,
      contact_id: contact.id,
      sender: direction === 'inbound' ? `+${phone}` : 'operator',
      content,
      direction,
      message_type: 'text',
      status: 'delivered',
      operator_id: Number(operatorId),
    });
  } catch (err) {
    console.error('Error saving message:', err.message);
  }
}

async function createSession(operatorId) {
  if (sessions.has(operatorId)) {
    const existing = sessions.get(operatorId);
    if (existing.status === 'connected') return existing;
    // If pending QR, return existing to avoid duplicate
    if (existing.status === 'qr') return existing;
  }

  const sessionData = { socket: null, qr: null, qrBase64: null, status: 'connecting' };
  sessions.set(operatorId, sessionData);

  const { state, saveCreds } = await useMultiFileAuthState(getSessionDir(operatorId));

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
  });

  sessionData.socket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      sessionData.qr = qr;
      sessionData.qrBase64 = await QRCode.toDataURL(qr);
      sessionData.status = 'qr';
      console.log(`QR generated for operator ${operatorId}`);
    }

    if (connection === 'open') {
      sessionData.status = 'connected';
      sessionData.qr = null;
      sessionData.qrBase64 = null;
      console.log(`Operator ${operatorId} connected`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;

      sessionData.status = 'disconnected';
      console.log(`Operator ${operatorId} disconnected. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        sessions.delete(operatorId);
        setTimeout(() => createSession(operatorId), 3000);
      } else {
        // Logged out — delete session files
        sessions.delete(operatorId);
        const fs = require('fs');
        const dir = getSessionDir(operatorId);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue; // outbound already saved on send
      await saveMessageToSupabase(operatorId, msg, 'inbound');
    }
  });

  return sessionData;
}

async function sendMessage(operatorId, phone, text) {
  const session = sessions.get(operatorId);
  if (!session || session.status !== 'connected') {
    throw new Error('Session not connected');
  }

  const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  await session.socket.sendMessage(jid, { text });

  // Save outbound to Supabase
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, company_id')
    .eq('phone', phone)
    .eq('operator_id', Number(operatorId))
    .single();

  if (contact) {
    await supabase.from('messages').insert({
      company_id: contact.company_id,
      contact_id: contact.id,
      sender: 'operator',
      content: text,
      direction: 'outbound',
      message_type: 'text',
      status: 'sent',
      operator_id: Number(operatorId),
    });
  }
}

function getSession(operatorId) {
  return sessions.get(operatorId) ?? null;
}

function deleteSession(operatorId) {
  const session = sessions.get(operatorId);
  if (session?.socket) {
    try { session.socket.logout(); } catch {}
  }
  sessions.delete(operatorId);
  const fs = require('fs');
  const dir = getSessionDir(operatorId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

module.exports = { createSession, sendMessage, getSession, deleteSession };
