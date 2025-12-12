#!/usr/bin/env node
/**
 * Standalone HF parquet importer.
 *
 * Why this exists:
 * Next.js/webpack struggles to bundle/parses parquet-wasm's .wasm in some setups.
 * This script runs under Node directly (no bundling), so parquet-wasm works reliably.
 *
 * Usage (called by the API route):
 *   node ui/scripts/import-hf-parquet.mjs \
 *     --datasetDir /abs/path/to/dataset \
 *     --parquetFile /abs/path/to/file.parquet \
 *     --repoId org/repo \
 *     --revision main \
 *     --repoType datasets
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { createRequire } from 'node:module';

import { initSync, readParquet } from 'parquet-wasm/esm';
import { tableFromIPC } from 'apache-arrow';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function uniquePath(dir, baseName, extensionWithDot) {
  const safeBase = sanitizeFileName(baseName);
  const safeExt = sanitizeFileName(extensionWithDot.startsWith('.') ? extensionWithDot : `.${extensionWithDot}`);

  let candidate = path.join(dir, `${safeBase}${safeExt}`);
  if (!fs.existsSync(candidate)) return candidate;

  for (let i = 1; i < 10_000; i++) {
    candidate = path.join(dir, `${safeBase}_${i}${safeExt}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Unable to find a unique filename after many attempts');
}

function getSidecarCaptionPath(imageAbsPath) {
  return imageAbsPath.replace(/\.[^/.]+$/, '') + '.txt';
}

function pickCaptionColumn(row) {
  if (row?.text != null) return String(row.text);
  if (row?.caption != null) return String(row.caption);
  return null;
}

function pickImageColumn(row) {
  return row?.image;
}

function getStructField(val, key) {
  if (!val) return null;
  if (val instanceof Map) return val.get(key);
  if (typeof val === 'object') return val[key];
  return null;
}

function coerceToBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return null;
}

async function inferExtensionFromBytes(imageBytes) {
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    const ft = await fileTypeFromBuffer(imageBytes);
    return ft?.ext || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const datasetDir = args.datasetDir;
  const parquetFile = args.parquetFile;

  if (!datasetDir || !parquetFile) {
    throw new Error('Missing required args: --datasetDir and --parquetFile');
  }

  // Initialize parquet-wasm from bytes (Node fetch does not support file://)
  const require = createRequire(import.meta.url);
  const entryPath = require.resolve('parquet-wasm/esm');
  const wasmPath = entryPath.replace(/parquet_wasm\.js$/, 'parquet_wasm_bg.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);
  initSync({ module: wasmBytes });

  const parquetBuffer = fs.readFileSync(parquetFile);
  const wasmTable = readParquet(new Uint8Array(parquetBuffer));
  const ipc = wasmTable.intoIPCStream();
  const table = tableFromIPC(ipc);

  const columnNames = table.schema.fields.map(f => f.name);

  const getRow = idx => {
    const row = {};
    for (const name of columnNames) {
      const col = table.getChild(name);
      row[name] = col ? col.get(idx) : null;
    }
    return row;
  };

  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (let rowIndex = 1; rowIndex <= table.numRows; rowIndex++) {
    try {
      const row = getRow(rowIndex - 1);
      const caption = pickCaptionColumn(row) ?? '';
      const imageValue = pickImageColumn(row);

      if (!imageValue) {
        skipped++;
        continue;
      }

      const imageBytesValue = getStructField(imageValue, 'bytes') ?? getStructField(imageValue, 'data') ?? null;
      let imageBytes = coerceToBuffer(imageBytesValue);

      // Optional fallback: if parquet only contains a path reference, download it from HF.
      const imagePathInRepo = getStructField(imageValue, 'path');
      if (!imageBytes && imagePathInRepo && args.repoId) {
        const token = args.hfToken || process.env.HF_TOKEN || '';
        imageBytes = await downloadHFFileAsBuffer({
          repoId: String(args.repoId),
          revision: String(args.revision || 'main'),
          filePath: String(imagePathInRepo),
          repoType: String(args.repoType || 'auto'),
          token,
        });
      }

      if (!imageBytes) {
        throw new Error('Could not extract image bytes from parquet row (expected image.bytes or image.path)');
      }

      let baseName = null;
      let extension = null;

      const imagePathHint = imageValue?.path ? String(imageValue.path) : '';
      if (imagePathHint) {
        const bn = path.posix.basename(imagePathHint);
        if (bn && bn !== '.' && bn !== '/') {
          baseName = bn.replace(/\.[^/.]+$/, '');
          const ext = path.posix.extname(bn);
          if (ext) extension = ext.replace(/^\./, '');
        }
      }

      if (!baseName) baseName = md5Hex(imageBytes);
      if (!extension) extension = (await inferExtensionFromBytes(imageBytes)) || 'jpg';

      const absImagePath = uniquePath(datasetDir, baseName, `.${extension}`);
      fs.writeFileSync(absImagePath, imageBytes);
      fs.writeFileSync(getSidecarCaptionPath(absImagePath), caption, 'utf8');
      imported++;
    } catch (e) {
      errors.push({ row: rowIndex, error: e?.message || String(e) });
    }
  }

  process.stdout.write(JSON.stringify({ imported, skipped, errors }));
}

function encodeHFPath(p) {
  return p
    .split('/')
    .filter(Boolean)
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

async function downloadHFFileAsBuffer({ repoId, revision, filePath, repoType, token }) {
  const baseHeaders = {
    'User-Agent': 'ai-toolkit',
    Accept: '*/*',
  };

  const cleanToken = String(token || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^"(.+)"$/, '$1')
    .replace(/^'(.+)'$/, '$1')
    .split(/\s+/)[0];

  const headersWithAuth = cleanToken ? { ...baseHeaders, Authorization: `Bearer ${cleanToken}` } : baseHeaders;

  const rev = encodeURIComponent(revision || 'main');
  const fp = encodeHFPath(filePath);

  const buildUrl = type => {
    if (type === 'datasets') {
      return `https://huggingface.co/datasets/${repoId}/resolve/${rev}/${fp}?download=true`;
    }
    return `https://huggingface.co/${repoId}/resolve/${rev}/${fp}?download=true`;
  };

  const tryFetch = async (url, headers) => {
    const res = await fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HF download failed (${res.status} ${res.statusText}): ${text.slice(0, 200)}`);
    }
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  };

  const tryRepoType = async type => {
    const url = buildUrl(type);
    if (cleanToken) {
      try {
        return await tryFetch(url, headersWithAuth);
      } catch {
        // retry without auth
        return await tryFetch(url, baseHeaders);
      }
    }
    return await tryFetch(url, baseHeaders);
  };

  if (repoType === 'datasets' || repoType === 'models') {
    return await tryRepoType(repoType);
  }

  // auto: try datasets then models
  try {
    return await tryRepoType('datasets');
  } catch {
    return await tryRepoType('models');
  }
}

main().catch(err => {
  process.stderr.write(String(err?.stack || err?.message || err));
  process.exitCode = 1;
});
