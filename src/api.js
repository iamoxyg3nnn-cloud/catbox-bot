'use strict';

// POST /user/api.php — the public file-hosting API.
//
// Request types observed on the reference service and implemented here:
//   fileupload      multipart: fileToUpload, userhash?      -> plain-text URL
//   urlupload       form: url, userhash?                    -> plain-text URL
//   deletefiles     form: userhash, files                   -> text status
//   createalbum     form: userhash?, title, desc, files     -> plain-text album URL
//   editalbum       form: userhash, short, title, desc, files
//   addtoalbum      form: userhash, short, files
//   removefromalbum form: userhash, short, files
//   deletealbum     form: userhash, short
//
// Successful file/album operations answer with the bare URL as plain text;
// failures answer with a 4xx status and a short plain-text reason.

const fs = require('fs');
const path = require('path');
const { config, publicUrl } = require('./config');
const db = require('./dbAdapter');
const { getStorage } = require('./storage');
const {
  randomName, extOf, extForMime, sanitizeOriginalName, isBlockedUpload, mimeFor,
  hashFile, limitMessage,
} = require('./util');

const MAX_TEMP_STEPS = [4, 8, 20, 40]; // retry ladder for name collisions

function text(res, status, body) {
  res.status(status).type('text/plain; charset=utf-8').send(String(body));
}

// Pick an unused storage name: base name plus extension from the source file.
// Async so it works with both the sync SQLite and async Supabase adapters.
async function allocateName(originalName, mime) {
  const ext = extOf(originalName) || extForMime(mime);
  for (const attempt of MAX_TEMP_STEPS) {
    for (let i = 0; i < attempt; i++) {
      const name = ext ? `${randomName()}.${ext}` : randomName();
      if (!await db.getFile(name)) return name;
    }
  }
  return `${randomName(10)}.${ext || 'bin'}`;
}

// Send a staged upload to Discord, record its metadata, then remove the
// staging file. There is no permanent local byte storage.
async function commitUpload(context, tmpPath, originalName, mime, size, expiresAt = null, idempotencyKey = null) {
  const name = await allocateName(originalName, mime);
  const sha256 = await hashFile(tmpPath);
  const stored = await getStorage().upload({
    filePath: tmpPath,
    originalName: sanitizeOriginalName(originalName),
    mime: mime || mimeFor(name),
    size,
    idempotencyKey,
  });
  await db.recordFile({
    name,
    ownerHash: context.ownerHash || null,
    originalName: sanitizeOriginalName(originalName),
    mime: mime || mimeFor(name),
    size,
    sha256,
    expiresAt,
    ...stored,
  });
  await fs.promises.unlink(tmpPath).catch(() => {});
  return name;
}

function ownerFromReq(req) {
  return (req.user && req.user.userhash)
    || (req.body && req.body.userhash ? String(req.body.userhash) : null);
}

// Browsers opt in by sending X-Catbox-Async: 1. Plain API clients keep the
// original synchronous 200 + plain-text URL contract.
function asyncRequested(req) {
  return String(req.get('X-Catbox-Async') || '') === '1';
}

async function acceptAsync(req, details) {
  const { enqueue } = require('./jobs');
  let jobId;
  try {
    jobId = await enqueue({
      stagedPath: details.stagedPath,
      ownerHash: ownerFromReq(req),
      originalName: details.originalName,
      mime: details.mime,
      size: details.size,
      expiresAt: details.expiresAt || null,
    });
  } catch (err) {
    // No job owns the body yet; remove it before returning an error.
    await fs.promises.unlink(details.stagedPath).catch(() => {});
    throw err;
  }
  // From here on the job runner owns the staged body, even if the client
  // disconnects before it receives the 202 response.
  if (typeof req.releaseStaged === 'function') req.releaseStaged();
  return {
    job_id: jobId,
    status: 'queued',
    status_url: `/api/jobs/${jobId}`,
  };
}

/* ------------------------- file upload ------------------------- */

async function handleFileUpload(req, res) {
  if (!req.file) return text(res, 400, 'No file was supplied.');
  const file = req.file;
  if (file.size > config.maxFileSize) {
    fs.unlink(file.path, () => {});
    return text(res, 413, limitMessage());
  }
  if (isBlockedUpload(file.originalname, file.mimetype)) {
    fs.unlink(file.path, () => {});
    return text(res, 403, "That file type isn't allowed here.");
  }
  if (asyncRequested(req)) {
    const job = await acceptAsync(req, {
      stagedPath: file.path,
      originalName: file.originalname,
      mime: file.mimetype,
      size: file.size,
    });
    return res.status(202).json(job);
  }
  let name;
  try {
    name = await commitUpload({ ownerHash: ownerFromReq(req) }, file.path, file.originalname, file.mimetype, file.size);
  } catch (err) {
    console.error('commit failed:', err);
    fs.unlink(file.path, () => {});
    return text(res, 500, 'Something went wrong storing that file.');
  }
  return text(res, 200, publicUrl(req, `/files/${name}`));
}

/* --------------------------- url upload -------------------------- */

const MAX_REDIRECTS = 5;

async function handleUrlUpload(req, res) {
  const url = String(req.body && req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return text(res, 400, 'That does not look like an http(s) URL.');

  let parsed;
  try { parsed = new URL(url); } catch { return text(res, 400, 'That does not look like an http(s) URL.'); }

  let response;
  try {
    response = await fetch(parsed, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
      headers: { 'user-agent': 'SlabHost/1.0' },
    });
  } catch {
    // Mirrors the reference behaviour: unreachable hosts surface as 412.
    return text(res, 412, 'Could not reach that URL.');
  }
  if (!response.ok || !response.body) return text(res, 412, 'Could not download that file.');

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > config.maxFileSize) return text(res, 413, limitMessage());

  // Derive a filename: Content-Disposition, then URL path, then extension by mime.
  const disposition = response.headers.get('content-disposition') || '';
  const dispMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const urlName = path.basename(new URL(response.url).pathname) || '';
  const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const originalName =
    sanitizeOriginalName(dispMatch ? decodeURIComponent(dispMatch[1]) : urlName) ||
    `file.${extForMime(mime)}`;
  if (isBlockedUpload(originalName, mime)) return text(res, 403, "That file type isn't allowed here.");

  const tmpPath = path.join(config.tmpDir, `url_${randomName(16)}`);
  let size = 0;
  const out = fs.createWriteStream(tmpPath);
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > config.maxFileSize) {
        reader.cancel();
        throw Object.assign(new Error('too big'), { tooBig: true });
      }
      if (!out.write(Buffer.from(value))) {
        await new Promise(r => out.once('drain', r));
      }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.unlink(tmpPath, () => {});
    if (err.tooBig) return text(res, 413, limitMessage());
    console.error('url download failed:', err);
    return text(res, 412, 'Could not download that file.');
  }
  if (size === 0) { fs.unlink(tmpPath, () => {}); return text(res, 412, 'That URL returned nothing.'); }

  if (asyncRequested(req)) {
    const job = await acceptAsync(req, {
      stagedPath: tmpPath,
      originalName,
      mime,
      size,
    });
    return res.status(202).json(job);
  }
  let name;
  try {
    name = await commitUpload({ ownerHash: ownerFromReq(req) }, tmpPath, originalName, mime, size);
  } catch (err) {
    console.error('commit failed:', err);
    fs.unlink(tmpPath, () => {});
    return text(res, 500, 'Something went wrong storing that file.');
  }
  return text(res, 200, publicUrl(req, `/files/${name}`));
}

/* ------------------------- file deletion ------------------------- */

async function handleDeleteFiles(req, res) {
  const userhash = ownerFromReq(req) || '';
  const user = await db.findUserByHash(userhash);
  if (!user) return text(res, 401, 'A valid userhash is required to delete files.');

  const names = String(req.body.files || '').split(/\s+/).filter(Boolean);
  if (!names.length) return text(res, 400, 'No files were named.');

  let removed = 0;
  for (const name of names) {
    if (!/^[a-z0-9]{1,10}(\.[a-z0-9]{1,8})?$/i.test(name)) continue;
    const row = await db.getFile(name);
    if (!row || row.owner_hash !== userhash) continue;
    try {
      await getStorage().remove(row);
    } catch (err) {
      console.error('discord delete failed:', err);
      continue;
    }
    if (await db.deleteFilesOwnedBy([name], userhash)) removed++;
  }
  return text(res, 200, `Removed ${removed} file(s).`);
}

/* --------------------------- albums ------------------------------ */

function validShort(short) { return /^[a-z0-9]{6}$/i.test(String(short || '')); }

async function allocateShort() {
  for (let i = 0; i < 40; i++) {
    const short = randomName();
    if (!await db.getAlbum(short)) return short;
  }
  return randomName(10);
}

// "files" arguments are single-space separated names; dedupe, keep order.
function parseFileList(raw) {
  const seen = new Set();
  const out = [];
  for (const n of String(raw || '').split(/\s+/).filter(Boolean)) {
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

async function handleCreateAlbum(req, res) {
  // A valid session is authoritative; the body field is the fallback for the
  // plain reference-style API clients that authenticate with userhash only.
  const userhash = ownerFromReq(req) || '';
  const user = userhash ? await db.findUserByHash(userhash) : null;
  if (userhash && !user) return text(res, 401, 'That userhash is not valid.');

  const title = String(req.body.title || '').trim().slice(0, 200);
  const desc = String(req.body.desc || '').trim().slice(0, 2000);
  const files = parseFileList(req.body.files);
  if (!title) return text(res, 400, 'An album needs a title.');
  if (!files.length) return text(res, 400, 'An album needs at least one file.');
  if (files.length > config.albumMaxFiles) {
    return text(res, 413, `Albums are limited to ${config.albumMaxFiles} files.`);
  }

  const short = await allocateShort();
  await db.createAlbum({ short, ownerHash: user ? userhash : null, title, description: desc });
  await db.setAlbumFiles(short, files);
  return text(res, 200, publicUrl(req, `/a/${short}`));
}

// The reference service treats editalbum as a direct overwrite of every
// supplied field, so all three are required here as well.
async function handleEditAlbum(req, res) {
  const album = await ownAlbum(req, res);
  if (!album) return null;
  const title = String(req.body.title || '').trim().slice(0, 200);
  const desc = String(req.body.desc || '').trim().slice(0, 2000);
  const files = parseFileList(req.body.files);
  if (!title) return text(res, 400, 'An album needs a title.');
  if (files.length > config.albumMaxFiles) {
    return text(res, 413, `Albums are limited to ${config.albumMaxFiles} files.`);
  }
  await db.setAlbumMeta(album.short, title, desc);
  await db.setAlbumFiles(album.short, files);
  return text(res, 200, publicUrl(req, `/a/${album.short}`));
}

async function handleAddToAlbum(req, res) {
  const album = await ownAlbum(req, res);
  if (!album) return null;
  const files = parseFileList(req.body.files);
  if (!files.length) return text(res, 400, 'No files were named.');
  if (await db.albumCount(album.short) + files.length > config.albumMaxFiles) {
    return text(res, 413, `Albums are limited to ${config.albumMaxFiles} files.`);
  }
  const added = await db.addToAlbum(album.short, files);
  return text(res, 200, `Added ${added} file(s).`);
}

async function handleRemoveFromAlbum(req, res) {
  const album = await ownAlbum(req, res);
  if (!album) return null;
  const files = parseFileList(req.body.files);
  if (!files.length) return text(res, 400, 'No files were named.');
  const removed = await db.removeFromAlbum(album.short, files);
  return text(res, 200, `Removed ${removed} file(s).`);
}

async function handleDeleteAlbum(req, res) {
  const album = await ownAlbum(req, res);
  if (!album) return null;
  await db.deleteAlbum(album.short);
  return text(res, 200, 'Album deleted.');
}

// Shared ownership gate for every mutating album request.
async function ownAlbum(req, res) {
  const userhash = ownerFromReq(req) || '';
  const user = await db.findUserByHash(userhash);
  if (!user) { text(res, 401, 'A valid userhash is required to manage albums.'); return null; }
  const short = String(req.body.short || '');
  if (!validShort(short)) { text(res, 400, 'That album id is not valid.'); return null; }
  const album = await db.getAlbum(short);
  if (!album) { text(res, 404, 'No such album.'); return null; }
  // Anonymous albums exist but are permanently unmanageable.
  if (!album.owner_hash || album.owner_hash !== userhash) {
    text(res, 403, 'You do not own that album.'); return null;
  }
  return album;
}

/* --------------------------- router ------------------------------ */

// Multipart forms may repeat a field name (the upload form ships hidden inputs
// and the upload script also appends them). Multer then hands us an array.
// Collapse each repeated field to its last non-empty value, which is what a
// single-valued form post would have produced.
function singleValue(value) {
  if (!Array.isArray(value)) return value;
  const parts = value.filter(v => v !== undefined && v !== null && v !== '');
  return parts.length ? parts[parts.length - 1] : '';
}

function normalizeBody(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) out[key] = singleValue(value);
  return out;
}

async function handleApi(req, res) {
  req.body = normalizeBody(req.body);
  const reqtype = String(req.body.reqtype || '').trim();
  switch (reqtype) {
    case 'fileupload':      return handleFileUpload(req, res);
    case 'urlupload':       return handleUrlUpload(req, res);
    case 'deletefiles':     return handleDeleteFiles(req, res);
    case 'createalbum':     return handleCreateAlbum(req, res);
    case 'editalbum':       return handleEditAlbum(req, res);
    case 'addtoalbum':      return handleAddToAlbum(req, res);
    case 'removefromalbum': return handleRemoveFromAlbum(req, res);
    case 'deletealbum':     return handleDeleteAlbum(req, res);
    default:                return text(res, 412, 'Unknown or missing reqtype.');
  }
}

module.exports = { handleApi, allocateName, commitUpload };
