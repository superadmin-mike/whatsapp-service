const { supabase } = require('./supabase');
const fs = require('fs');
const path = require('path');

const BUCKET = 'whatsapp-sessions';

// Only sync these files — Signal session/pre-key files cause Bad MAC on restore
const SYNC_FILES = ['creds.json', 'app-state-sync-key-*.json', 'app-state-sync-version-*.json'];

function shouldSync(fileName) {
  if (fileName === 'creds.json') return true;
  if (fileName.startsWith('app-state-sync-')) return true;
  // Skip session-*, pre-key-*, sender-key-* — these cause Bad MAC when stale
  return false;
}

// Upload a local file to Supabase Storage
async function uploadFile(operatorId, fileName, filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const storagePath = `${operatorId}/${fileName}`;
    await supabase.storage.from(BUCKET).upload(storagePath, content, { upsert: true });
  } catch (err) {
    console.error(`Upload error ${fileName}:`, err.message);
  }
}

// Download session files for an operator from Supabase Storage to local dir
async function downloadSession(operatorId, localDir) {
  try {
    const { data: files } = await supabase.storage.from(BUCKET).list(String(operatorId));
    if (!files || files.length === 0) return false;

    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

    for (const file of files) {
      if (!shouldSync(file.name)) continue; // skip stale Signal files
      const storagePath = `${operatorId}/${file.name}`;
      const { data } = await supabase.storage.from(BUCKET).download(storagePath);
      if (data) {
        const buffer = Buffer.from(await data.arrayBuffer());
        fs.writeFileSync(path.join(localDir, file.name), buffer);
      }
    }
    return true;
  } catch (err) {
    console.error(`Download error for operator ${operatorId}:`, err.message);
    return false;
  }
}

// Sync local session dir to Supabase Storage (only essential files)
async function syncSession(operatorId, localDir) {
  try {
    if (!fs.existsSync(localDir)) return;
    const files = fs.readdirSync(localDir);
    for (const file of files) {
      if (!shouldSync(file)) continue; // skip stale Signal files
      const filePath = path.join(localDir, file);
      try {
        if (fs.statSync(filePath).isFile()) {
          await uploadFile(operatorId, file, filePath);
        }
      } catch {
        // File may have been deleted mid-sync, skip
      }
    }
  } catch (err) {
    console.error(`Sync error for operator ${operatorId}:`, err.message);
  }
}

// Delete session from Supabase Storage
async function deleteStorageSession(operatorId) {
  try {
    const { data: files } = await supabase.storage.from(BUCKET).list(String(operatorId));
    if (!files || files.length === 0) return;
    const paths = files.map(f => `${operatorId}/${f.name}`);
    await supabase.storage.from(BUCKET).remove(paths);
  } catch (err) {
    console.error(`Delete storage error for operator ${operatorId}:`, err.message);
  }
}

module.exports = { uploadFile, downloadSession, syncSession, deleteStorageSession };
