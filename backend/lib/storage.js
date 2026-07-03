// Single owner of object I/O. Two backends behind one interface:
//
//   STORAGE_BACKEND=r2     → Cloudflare R2 via @aws-sdk/client-s3 (S3-compatible)
//   STORAGE_BACKEND=local  → backend/data/media/ on disk (dev fallback / no R2 yet)
//
// Key invariants (planv2 §1 + §3 Layer 2):
//   - Every key begins `tenants/<safeSlug>/...` and the slug is stamped server-side.
//   - signedGet(slug, key) and delete(slug, key) ASSERT key prefix matches slug — a row
//     pointing at the wrong tenant can't be signed even if the DB lookup was wrong.
//   - put() returns the key, never the URL. Callers always ask for a fresh signed URL.
//
// Public surface:
//   storage.backend                        → 'r2' | 'local'
//   storage.makeKey(slug, kind, ext)       → 'tenants/<slug>/<kind>s/<yyyy>/<mm>/<uuid>.<ext>'
//   storage.put(slug, key, bodyBuf, ctype) → { etag, size }
//   storage.putStream(slug, key, readable, ctype) → { etag, size }
//   storage.signedGet(slug, key, ttlSec?)  → https URL valid for ttlSec
//   storage.delete(slug, key)              → void
//   storage.stat(slug, key)                → { size, contentType, etag, lastModified }
//   storage.ingestFromUrl(slug, key, srcUrl, ctype?) → { size, sha256, contentType }
//
// The R2 backend uses Cloudflare's S3-compatible endpoint
// `https://<account_id>.r2.cloudflarestorage.com` and the bucket name from
// $R2_BUCKET_PROD. Signed URLs use the same endpoint; we'll swap to a custom domain
// (`cdn.online-phantom.com`) once the domain lives on Cloudflare DNS.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import mime from 'mime-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read lazily — entrypoints that load this module before dotenv.config() (legacy
// CommonJS layouts, tests) still get the right backend at first call.
const currentBackend = () => (process.env.STORAGE_BACKEND || 'local').toLowerCase();
const defaultTtl = () => parseInt(process.env.MEDIA_SIGNED_TTL_SEC || '300', 10);

// Mirror lib/tenants.safeSlug locally so storage has no upstream dependency.
function safeSlug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

// Defense in depth: every operation asserts the key is INSIDE the caller's tenant prefix.
function assertKeyMatchesSlug(slug, key) {
  const s = safeSlug(slug);
  if (!s) throw new StorageError('FORBIDDEN', 'tenant slug missing');
  const prefix = `tenants/${s}/`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    throw new StorageError('FORBIDDEN', `key '${key}' does not belong to tenant '${s}'`);
  }
}

class StorageError extends Error {
  constructor(code, message) { super(message); this.name = 'StorageError'; this.code = code; }
}

// ── Key minting ──────────────────────────────────────────────────────────────
//
// makeKey('alice-co', 'reel', 'mp4') → 'tenants/alice-co/renders/2026/06/<24-char-id>.mp4'
//
// kind → folder map. Matches the existing on-disk layout in lib/tenants.js so any
// future migration tool can move tenants/<slug>/public/<folder>/ → R2 1:1.
const KIND_FOLDER = {
  reel: 'renders',
  post: 'posts',
  product: 'products',
  phantom: 'phantoms',
  brand: 'brand',
  scrape: 'scrapes',
  shot: 'shots',
  audio: 'audio',
  scratch: 'scratch',
};

export function makeKey(slug, kind, ext) {
  const s = safeSlug(slug);
  if (!s) throw new StorageError('BAD_REQUEST', 'tenant slug required');
  const folder = KIND_FOLDER[kind];
  if (!folder) throw new StorageError('BAD_REQUEST', `unknown asset kind '${kind}'`);
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeExt = String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const id = nanoid(24);
  // scratch/ doesn't get tenant-bucketed by month — it's TTL-7d trash.
  if (kind === 'scratch') return `tenants/${s}/scratch/${id}.${safeExt}`;
  return `tenants/${s}/${folder}/${yyyy}/${mm}/${id}.${safeExt}`;
}

export function extFromContentType(ct) {
  if (!ct) return 'bin';
  const ext = mime.extension(String(ct).split(';')[0].trim());
  return ext || 'bin';
}

// ── Local-disk backend (dev / fallback) ──────────────────────────────────────
const LOCAL_ROOT = path.join(__dirname, '..', 'data', 'media');

const localBackend = {
  name: 'local',

  async put(key, bodyBuf, contentType) {
    const fp = path.join(LOCAL_ROOT, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, bodyBuf);
    fs.writeFileSync(fp + '.ct', String(contentType || 'application/octet-stream'));
    return { etag: 'local', size: bodyBuf.length };
  },

  async putStream(key, readable, contentType) {
    const fp = path.join(LOCAL_ROOT, key);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const chunks = [];
    for await (const chunk of readable) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(fp, buf);
    fs.writeFileSync(fp + '.ct', String(contentType || 'application/octet-stream'));
    return { etag: 'local', size: buf.length };
  },

  async signedGet(key, _ttlSec) {
    // In local mode the "signed URL" is the in-process /api/media route — the caller
    // returns a 302 to a path that streams from disk. We never expose disk paths.
    const token = crypto.randomBytes(16).toString('hex');
    _localTokens.set(token, { key, exp: Date.now() + (defaultTtl() * 1000) });
    return `/api/media/local/${encodeURIComponent(token)}`;
  },

  async delete(key) {
    const fp = path.join(LOCAL_ROOT, key);
    try { fs.unlinkSync(fp); } catch {}
    try { fs.unlinkSync(fp + '.ct'); } catch {}
  },

  async stat(key) {
    const fp = path.join(LOCAL_ROOT, key);
    const st = fs.statSync(fp);
    let contentType = 'application/octet-stream';
    try { contentType = fs.readFileSync(fp + '.ct', 'utf8'); } catch {}
    return { size: st.size, contentType, etag: 'local', lastModified: new Date(st.mtimeMs) };
  },

  // Internal: lets the /api/media route stream the file when the signed URL is a token.
  _readLocal(token) {
    const entry = _localTokens.get(token);
    if (!entry) return null;
    if (entry.exp < Date.now()) { _localTokens.delete(token); return null; }
    const fp = path.join(LOCAL_ROOT, entry.key);
    if (!fp.startsWith(LOCAL_ROOT)) return null; // belt + suspenders
    let contentType = 'application/octet-stream';
    try { contentType = fs.readFileSync(fp + '.ct', 'utf8'); } catch {}
    return { path: fp, contentType };
  },
};
const _localTokens = new Map();

// ── R2 backend ───────────────────────────────────────────────────────────────
let r2Backend = null;
async function getR2() {
  if (r2Backend) return r2Backend;
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } =
    await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_PROD || 'phantom-prod';
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new StorageError('CONFIG', 'STORAGE_BACKEND=r2 but R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set');
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });

  r2Backend = {
    name: 'r2',
    bucket,
    client,
    async put(key, bodyBuf, contentType) {
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bodyBuf,
        ContentType: contentType || 'application/octet-stream',
      });
      const r = await client.send(cmd);
      return { etag: r.ETag, size: bodyBuf.length };
    },
    async putStream(key, readable, contentType) {
      // Buffer the stream — R2 doesn't accept chunked uploads in the simple PutObject path.
      // For >50 MB use multipart (not needed yet; biggest expected asset is ~30 MB Seedance).
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType || 'application/octet-stream',
      });
      const r = await client.send(cmd);
      return { etag: r.ETag, size: body.length };
    },
    async signedGet(key, ttlSec) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      return await getSignedUrl(client, cmd, { expiresIn: ttlSec });
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async stat(key) {
      const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        size: r.ContentLength,
        contentType: r.ContentType,
        etag: r.ETag,
        lastModified: r.LastModified,
      };
    },
  };
  return r2Backend;
}

// ── Backend dispatcher ───────────────────────────────────────────────────────
async function backend() {
  if (currentBackend() === 'r2') return await getR2();
  return localBackend;
}

// ── Public API ───────────────────────────────────────────────────────────────
export const storage = {
  get backend() { return currentBackend(); },
  makeKey,
  extFromContentType,

  async put(slug, key, bodyBuf, contentType) {
    assertKeyMatchesSlug(slug, key);
    const b = await backend();
    return await b.put(key, bodyBuf, contentType);
  },

  async putStream(slug, key, readable, contentType) {
    assertKeyMatchesSlug(slug, key);
    const b = await backend();
    return await b.putStream(key, readable, contentType);
  },

  async signedGet(slug, key, ttlSec = defaultTtl()) {
    assertKeyMatchesSlug(slug, key);
    const b = await backend();
    return await b.signedGet(key, ttlSec);
  },

  // A URL an EXTERNAL service (Fal) can actually fetch. R2 signed URLs qualify;
  // local-backend "URLs" are in-process paths, so inline the bytes as a data URI
  // (fal file inputs accept hosted URLs, data URIs, or fal-storage URLs).
  async fetchableUrl(slug, key, ttlSec = defaultTtl()) {
    assertKeyMatchesSlug(slug, key);
    const b = await backend();
    const url = await b.signedGet(key, ttlSec);
    if (/^https:\/\//.test(url)) return url;
    const fp = path.join(LOCAL_ROOT, key);
    const ct = fs.existsSync(fp + '.ct') ? fs.readFileSync(fp + '.ct', 'utf8').trim() : 'application/octet-stream';
    return `data:${ct};base64,${fs.readFileSync(fp).toString('base64')}`;
  },

  async delete(slug, key) {
    assertKeyMatchesSlug(slug, key);
    const b = await backend();
    return await b.delete(key);
  },

  async stat(slug, key) {
    assertKeyMatchesSlug(slug, key);
    const b = await backend();
    return await b.stat(key);
  },

  // Ingest a remote URL (e.g. Enhancor result_url) into our bucket. SSRF guard:
  // only allowlisted hosts are accepted as a source. Returns { size, sha256, contentType }.
  async ingestFromUrl(slug, key, srcUrl, { allowHosts = null, contentTypeHint = null } = {}) {
    assertKeyMatchesSlug(slug, key);
    const url = new URL(srcUrl);
    const hosts = allowHosts || INGEST_ALLOWED_HOSTS;
    if (!hosts.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
      throw new StorageError('SSRF_BLOCKED', `host '${url.hostname}' not in ingest allowlist`);
    }
    const r = await fetch(srcUrl);
    if (!r.ok) throw new StorageError('UPSTREAM', `ingest fetch failed ${r.status} ${r.statusText}`);
    const ctype = contentTypeHint || r.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await r.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const b = await backend();
    const put = await b.put(key, buf, ctype);
    return { size: put.size, sha256: sha, contentType: ctype, etag: put.etag };
  },

  // Local-disk fallback streamer (only used when STORAGE_BACKEND=local).
  _readLocal(token) { return localBackend._readLocal(token); },
};

// SSRF allowlist for ingestFromUrl. Edit via env if Enhancor changes domains.
const INGEST_ALLOWED_HOSTS = (process.env.INGEST_ALLOWED_HOSTS
  || 'fal.media,fal.run,r2.cloudflarestorage.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

export { StorageError };
export default storage;
