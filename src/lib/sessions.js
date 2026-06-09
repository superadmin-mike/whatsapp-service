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
const { downloadSession, syncSession, deleteStorageSession } = require('./storage');

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

async function upsertConversation(operatorId, contactPhone, companyId) {
  try {
    // Find operator's company if not provided
    let cid = companyId;
    if (!cid) {
      const { data: op } = await supabase
        .from('users')
        .select('company_id')
        .eq('id', Number(operatorId))
        .single();
      cid = op?.company_id ?? null;
    }

    // Find or create contact by phone
    let contact = null;
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('id, company_id')
      .eq('phone', contactPhone)
      .single();

    if (existingContact) {
      contact = existingContact;
    } else {
      // Auto-create contact
      const { data: newContact } = await supabase
        .from('contacts')
        .insert({
          phone: contactPhone,
          first_name: contactPhone,
          last_name: '',
          operator_id: Number(operatorId),
          status: 'new',
          source: 'whatsapp_direct',
        })
        .select('id, company_id')
        .single();
      contact = newContact;
    }

    if (!contact) return null;

    // Upsert conversation
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contact.id)
      .eq('operator_id', Number(operatorId))
      .single();

    if (existing) {
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', existing.id);
      return { conversationId: existing.id, contactId: contact.id, companyId: cid };
    } else {
      const { data: created, error: insertErr } = await supabase
        .from('conversations')
        .insert({
          contact_id: contact.id,
          operator_id: Number(operatorId),
          company_id: cid,
          status: 'active',
          started_at: new Date().toISOString(),
          last_message_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (insertErr) console.error('upsertConversation insert error:', insertErr.message, '| operatorId:', operatorId, '| cid:', cid, '| contactId:', contact.id);
      return { conversationId: created?.id, contactId: contact.id, companyId: cid };
    }
  } catch (err) {
    console.error('upsertConversation error:', err.message);
    return null;
  }
}

async function broadcastMessage(operatorId, contactPhone, payload) {
  try {
    const topic = `chat:${operatorId}:${contactPhone.replace(/\D/g, '')}`;
    const url = `${process.env.SUPABASE_URL}/realtime/v1/api/broadcast`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'apikey': process.env.SUPABASE_SERVICE_KEY,
      },
      body: JSON.stringify({
        messages: [{
          topic: `realtime:${topic}`,
          event: 'message',
          payload,
        }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('broadcastMessage HTTP error:', res.status, text);
    }
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
    await upsertConversation(operatorId, contactPhone, null);

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

  // Download session from Supabase Storage if not local
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
    console.log(`Descargando sesion de Storage para operador ${operatorId}...`);
    await downloadSession(operatorId, dir);
  }

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

  sock.ev.on('creds.update', async () => {
    saveCreds();
    await syncSession(operatorId, dir);
  });

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
        await deleteStorageSession(operatorId);
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

async function deleteSession(operatorId) {
  const session = sessions.get(operatorId);
  if (session?.socket) {
    try { session.socket.logout(); } catch {}
  }
  sessions.delete(operatorId);
  const dir = getSessionDir(operatorId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  await deleteStorageSession(operatorId);
}

module.exports = { createSession, sendMessage, getSession, deleteSession };
