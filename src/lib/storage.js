const { supabase } = require('./supabase');
const fs = require('fs');
const path = require('path');

const BUCKET = 'whatsapp-sessions';

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

// Download all files for an operator from Supabase Storage to local dir
async function downloadSession(operatorId, localDir) {
  try {
    const { data: files } = await supabase.storage.from(BUCKET).list(String(operatorId));
    if (!files || files.length === 0) return false;

    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

    for (const file of files) {
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

// Sync local session dir to Supabase Storage
async function syncSession(operatorId, localDir) {
  try {
    if (!fs.existsSync(localDir)) return;
    const files = fs.readdirSync(localDir);
    for (const file of files) {
      const filePath = path.join(localDir, file);
      try {
        if (fs.statSync(filePath).isFile()) {
          await uploadFile(operatorId, file, filePath);
        }
      } catch {
        // File may have been deleted mid-sync (pre-keys rotate fast), skip
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
