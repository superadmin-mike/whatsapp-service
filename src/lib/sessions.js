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
      .select('id')
      .eq('phone', contactPhone)
      .single();

    if (existingContact) {
      contact = existingContact;
      console.log(`[upsert] contacto existente id=${contact.id}`);
    } else {
      // Auto-create contact with upsert to avoid race conditions
      const { data: newContact, error: contactErr } = await supabase
        .from('contacts')
        .upsert({
          phone: contactPhone,
          first_name: contactPhone,
          last_name: '',
          operator_id: Number(operatorId),
          company_id: cid || null,
          status: 'new',
          source: 'whatsapp_direct',
        }, { onConflict: 'phone' })
        .select('id')
        .single();
      if (contactErr) console.error('[upsert] error creando contacto:', contactErr.message);
      else console.log(`[upsert] contacto upserted id=${newContact?.id}`);
      contact = newContact;
    }

    if (!contact) {
      console.error('[upsert] contact es null, abortando');
      return null;
    }

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

async function saveMessage(conversationId, operatorId, contactPhone, direction, content, companyId, waMessageId) {
  try {
    // Dedup by whatsapp_message_id to avoid replaying messages on reconnect
    if (waMessageId) {
      const { data: existing } = await supabase
        .from('messages')
        .select('id')
        .eq('whatsapp_message_id', waMessageId)
        .maybeSingle();
      if (existing) {
        console.log(`[msg skip] duplicado waId=${waMessageId}`);
        return;
      }
    }

    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender: contactPhone,
      direction,
      content: content || '',
      message_type: 'text',
      status: 'sent',
      company_id: companyId || null,
      whatsapp_message_id: waMessageId || null,
    });
    if (error) { console.error('saveMessage error:', error.message); return; }
    // Update last message preview on conversation
    await supabase.from('conversations').update({
      last_message_at: new Date().toISOString(),
      last_message: content,
      last_message_direction: direction,
    }).eq('id', conversationId);
    console.log(`[msg saved] ${direction} conv=${conversationId}`);
  } catch (err) {
    console.error('saveMessage error:', err.message);
  }
}

async function handleMessage(operatorId, msg, direction) {
  try {
    const jid = msg.key.remoteJid ?? '';
    const isIndividual = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
    if (!isIndividual) return;

    // Resolve @lid to real phone JID using contact map
    let resolvedJid = jid;
    if (jid.endsWith('@lid')) {
      const session = sessions.get(operatorId);
      resolvedJid = session?.lidMap.get(jid) || null;
      if (!resolvedJid) {
        console.log(`[lid] no resuelto: ${jid}, ignorando mensaje`);
        return;
      }
    }
    const contactPhone = phoneFromJid(resolvedJid);
    const content =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      '';

    // Skip empty messages (reactions, stickers, undecryptable)
    if (!content.trim()) {
      if (direction === 'inbound') {
        console.log(`[msg skip] inbound sin contenido jid=${jid} — solicitando retry`);
        // Ask WhatsApp to resend the message
        try {
          const session = sessions.get(operatorId);
          if (session?.socket && msg.key) {
            await session.socket.sendReceipt(jid, null, [msg.key.id], 'read');
          }
        } catch {}
      }
      return;
    }

    const waMessageId = msg.key?.id || null;

    // Upsert conversation and save message
    const conv = await upsertConversation(operatorId, contactPhone, null);
    if (conv?.conversationId) {
      await saveMessage(conv.conversationId, operatorId, contactPhone, direction, content, conv.companyId, waMessageId);
    }
  } catch (err) {
    console.error('handleMessage error:', err.message);
  }
}

async function createSession(operatorId) {
  if (sessions.has(operatorId)) {
    return sessions.get(operatorId);
  }

  const sessionData = { socket: null, qr: null, qrBase64: null, status: 'connecting', lidMap: new Map() };
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
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 5,
    getMessage: async (key) => {
      // Return empty so Baileys can re-request undecryptable messages
      return { conversation: '' };
    },
  });

  sessionData.socket = sock;

  // Load persisted lid map from DB on session start
  (async () => {
    const { data: rows } = await supabase
      .from('operator_lid_map')
      .select('lid, jid')
      .eq('operator_id', Number(operatorId));
    if (rows) {
      for (const r of rows) sessionData.lidMap.set(r.lid, r.jid);
      console.log(`[lid] cargados ${rows.length} lids de BD para operador ${operatorId}`);
    }
  })();

  // Map @lid JIDs to real phone JIDs for WhatsApp Business
  sock.ev.on('contacts.upsert', async (contacts) => {
    const newEntries = [];
    for (const c of contacts) {
      if (c.lid && c.id) {
        sessionData.lidMap.set(c.lid, c.id);
        console.log(`[lid] ${c.lid} -> ${c.id}`);
        newEntries.push({ operator_id: Number(operatorId), lid: c.lid, jid: c.id });
      }
    }
    // Persist new entries to DB
    if (newEntries.length > 0) {
      await supabase.from('operator_lid_map').upsert(newEntries, { onConflict: 'operator_id,lid' });
    }
  });

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
      const jid = msg.key.remoteJid ?? '';
      if (jid === 'status@broadcast') continue;
      console.log(`[mensaje] jid=${jid} fromMe=${msg.key.fromMe}`);
      const direction = msg.key.fromMe ? 'outbound' : 'inbound';
      await handleMessage(operatorId, msg, direction);
      // Send read receipt for inbound messages
      if (!msg.key.fromMe) {
        try {
          await sock.readMessages([msg.key]);
        } catch {}
      }
    }
  });

  return sessionData;
}

async function sendMessage(operatorId, phone, text) {
  const session = sessions.get(operatorId);
  if (!session || session.status !== 'connected') {
    throw new Error('Sesion no conectada');
  }

  // Resolve real phone to JID — check if it's a LID-based phone
  const digits = phone.replace(/\D/g, '');
  let jid;
  if (digits.length > 13) {
    // LID-based: try to find in lidMap by value, or use @lid directly
    const session = sessions.get(operatorId);
    let foundLid = null;
    if (session?.lidMap) {
      for (const [lid, realJid] of session.lidMap.entries()) {
        if (realJid.startsWith(digits) || realJid === `${digits}@s.whatsapp.net`) {
          foundLid = null; // we have the real JID
          jid = realJid;
          break;
        }
      }
    }
    if (!jid) jid = `${digits}@lid`;
  } else {
    jid = normalizePhone(phone);
  }

  await session.socket.sendMessage(jid, { text });

  // Save outbound message to DB (non-blocking — don't delay the send response)
  handleMessage(operatorId, {
    key: { remoteJid: jid, fromMe: true },
    message: { conversation: text },
  }, 'outbound').catch(err => console.error('handleMessage outbound error:', err.message));
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
