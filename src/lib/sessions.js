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

async function saveMessageToSupabase(operatorId, msg, direction) {
  try {
    const jid = msg.key.remoteJid ?? '';
    if (!jid.endsWith('@s.whatsapp.net')) return; // ignore groups

    const phone = '+' + jid.replace('@s.whatsapp.net', '');
    const content =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    if (!content) return;

    const { data: contact } = await supabase
      .from('contacts')
      .select('id, company_id')
      .eq('phone', phone)
      .eq('operator_id', Number(operatorId))
      .single();

    if (!contact) return;

    await supabase.from('messages').insert({
      company_id: contact.company_id,
      contact_id: contact.id,
      sender: direction === 'inbound' ? phone : 'operator',
      content,
      direction,
      message_type: 'text',
      status: 'delivered',
    });
  } catch (err) {
    console.error('Error saving message:', err.message);
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
    printQRInTerminal: true,
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

      console.log(`Operador ${operatorId} desconectado. Codigo: ${code}. LoggedOut: ${loggedOut}`);

      sessions.delete(operatorId);

      if (!loggedOut) {
        console.log(`Reconectando operador ${operatorId} en 5s...`);
        setTimeout(() => createSession(operatorId), 5000);
      } else {
        // Sesion cerrada — borrar archivos
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      await saveMessageToSupabase(operatorId, msg, 'inbound');
    }
  });

  return sessionData;
}

function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  // Mexico: 52 + 10 digits = 12 digits. WhatsApp uses 521XXXXXXXXXX (13 digits)
  if (digits.startsWith('52') && digits.length === 12) {
    digits = '521' + digits.slice(2);
  }
  return digits + '@s.whatsapp.net';
}

async function sendMessage(operatorId, phone, text) {
  const session = sessions.get(operatorId);
  if (!session || session.status !== 'connected') {
    throw new Error('Sesion no conectada');
  }

  const jid = normalizePhone(phone);
  await session.socket.sendMessage(jid, { text });
  await saveMessageToSupabase(operatorId, {
    key: { remoteJid: jid, fromMe: false },
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
