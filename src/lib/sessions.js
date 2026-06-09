const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { supabase } = require('./supabase');

const sessions = new Map();
const logger = pino({ level: 'silent' });

function getSessionDir(operatorId) {
  return path.join(__dirname, '../../sessions', String(operatorId));
}

function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('52') && digits.length === 12) {
    digits = '521' + digits.slice(2);
  }
  return digits + '@s.whatsapp.net';
}

function phoneFromJid(jid) {
  return '+' + jid.replace('@s.whatsapp.net', '');
}

async function upsertConversation(operatorId, contactPhone, isNew) {
  try {
    // Find contact by phone
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, company_id')
      .eq('phone', contactPhone)
      .single();

    if (!contact) return null;

    // Check if conversation exists
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contact.id)
      .eq('operator_id', Number(operatorId))
      .single();

    if (existing) {
      // Update last_message_at
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', existing.id);
      return { conversationId: existing.id, contactId: contact.id, companyId: contact.company_id };
    } else {
      // Create new conversation
      const { data: created } = await supabase
        .from('conversations')
        .insert({
          contact_id: contact.id,
          operator_id: Number(operatorId),
          company_id: contact.company_id,
          status: 'active',
          started_at: new Date().toISOString(),
          last_message_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      return { conversationId: created?.id, contactId: contact.id, companyId: contact.company_id };
    }
  } catch (err) {
    console.error('upsertConversation error:', err.message);
    return null;
  }
}

async function broadcastMessage(operatorId, contactPhone, payload) {
  try {
    const channel = supabase.channel(`chat:${operatorId}:${contactPhone.replace(/\D/g, '')}`);
    await channel.send({
      type: 'broadcast',
      event: 'message',
      payload,
    });
    // Cleanup channel after send
    supabase.removeChannel(channel);
  } catch (err) {
    console.error('broadcastMessage error:', err.message);
  }
}

async function handleMessage(operatorId, msg, direction) {
  try {
    const jid = msg.key.remoteJid ?? '';
    if (!jid.endsWith('@s.whatsapp.net')) return;

    const contactPhone = phoneFromJid(jid);
    const content =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      '';

    const timestamp = new Date().toISOString();

    // Upsert conversation metadata
    await upsertConversation(operatorId, contactPhone, direction === 'inbound');

    // Broadcast to Realtime
    await broadcastMessage(operatorId, contactPhone, {
      direction,
      content,
      timestamp,
      phone: contactPhone,
      operator_id: Number(operatorId),
    });
  } catch (err) {
    console.error('handleMessage error:', err.message);
  }
}

async function createSession(operatorId) {
  if (sessions.has(operatorId)) {
    return sessions.get(operatorId);
  }

  const sessionData = { socket: null, qr: null, qrBase64: null, status: 'connecting' };
  sessions.set(operatorId, sessionData);

  const dir = getSessionDir(operatorId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: ['CRM Multichannel', 'Chrome', '120.0.0'],
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sessionData.socket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`QR generado para operador ${operatorId}`);
      sessionData.qr = qr;
      sessionData.qrBase64 = await QRCode.toDataURL(qr);
      sessionData.status = 'qr';
    }

    if (connection === 'open') {
      console.log(`Operador ${operatorId} conectado`);
      sessionData.status = 'connected';
      sessionData.qr = null;
      sessionData.qrBase64 = null;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : 0;
      const loggedOut = code === DisconnectReason.loggedOut;

      console.log(`Operador ${operatorId} desconectado. Codigo: ${code}`);
      sessions.delete(operatorId);

      if (!loggedOut) {
        setTimeout(() => createSession(operatorId), 5000);
      } else {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const direction = msg.key.fromMe ? 'outbound' : 'inbound';
      await handleMessage(operatorId, msg, direction);
    }
  });

  return sessionData;
}

async function sendMessage(operatorId, phone, text) {
  const session = sessions.get(operatorId);
  if (!session || session.status !== 'connected') {
    throw new Error('Sesion no conectada');
  }

  const jid = normalizePhone(phone);
  await session.socket.sendMessage(jid, { text });

  // Broadcast outbound via Realtime
  await handleMessage(operatorId, {
    key: { remoteJid: jid, fromMe: true },
    message: { conversation: text },
  }, 'outbound');
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
  const dir = getSessionDir(operatorId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

module.exports = { createSession, sendMessage, getSession, deleteSession };
