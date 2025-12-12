import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { mkdir } from 'fs/promises';
import crypto from 'crypto';
import zlib from 'zlib';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getDatasetsRoot, getHFToken } from '@/server/settings';

// Ensure we run in the Node.js runtime (we need fs + large buffers)
export const runtime = 'nodejs';

type HFRepoType = 'auto' | 'datasets' | 'models';

type HFParquetRef = {
  repoId: string;
  revision: string;
  filePath: string;
  repoType: HFRepoType;
};

function parseHFParquetPath(inputRaw: string): HFParquetRef {
  const input = (inputRaw || '').trim().replace(/^https?:\/\/(www\.)?huggingface\.co\//, '');
  const parts = input.split('/').filter(Boolean);

  // Supported inputs:
  // - org/repo/path/to/file.parquet
  // - org/repo@rev/path/to/file.parquet
  // - datasets/org/repo/path/to/file.parquet
  // - https://huggingface.co/datasets/org/repo/resolve/main/path/to/file.parquet
  // - https://huggingface.co/org/repo/resolve/main/path/to/file.parquet

  if (parts.length < 3) {
    throw new Error('Invalid Hugging Face parquet path. Expected: org/repo/path/to/file.parquet');
  }

  let repoType: HFRepoType = 'auto';
  let i = 0;

  // Handle dataset repo prefix
  if (parts[0] === 'datasets') {
    repoType = 'datasets';
    i = 1;
  }

  // If the user pasted a full blob/resolve URL path, parse it.
  // Format: [datasets?]/org/repo/(resolve|blob)/REVISION/<filePath>
  const isResolveOrBlob = parts[i + 2] === 'resolve' || parts[i + 2] === 'blob';
  if (isResolveOrBlob) {
    if (parts.length < i + 5) {
      throw new Error('Invalid Hugging Face parquet URL. Expected: .../(resolve|blob)/REVISION/path/to/file.parquet');
    }

    const org = parts[i];
    const repo = parts[i + 1];
    const revision = parts[i + 3] || 'main';
    const filePath = parts.slice(i + 4).join('/');

    if (!filePath.toLowerCase().endsWith('.parquet')) {
      throw new Error('The Hugging Face file path must point to a .parquet file');
    }

    // If repoType wasn't explicit, default to models for this URL shape.
    const finalRepoType: HFRepoType = repoType === 'auto' ? 'models' : repoType;

    return {
      repoId: `${org}/${repo}`,
      revision,
      filePath,
      repoType: finalRepoType,
    };
  }

  // Format: [datasets?]/org/repo@rev?/path/to/file.parquet
  if (parts.length < i + 3) {
    throw new Error('Invalid Hugging Face parquet path. Expected: org/repo/path/to/file.parquet');
  }

  const org = parts[i];
  const repoWithMaybeRevision = parts[i + 1];

  let repo = repoWithMaybeRevision;
  let revision = 'main';

  // Support org/repo@revision/path/to/file.parquet
  if (repoWithMaybeRevision.includes('@')) {
    const [repoName, rev] = repoWithMaybeRevision.split('@');
    if (repoName) repo = repoName;
    if (rev) revision = rev;
  }

  const filePath = parts.slice(i + 2).join('/');

  if (!filePath.toLowerCase().endsWith('.parquet')) {
    throw new Error('The Hugging Face file path must point to a .parquet file');
  }

  return { repoId: `${org}/${repo}`, revision, filePath, repoType };
}

function sanitizeFileName(fileName: string): string {
  // Keep it simple: replace anything potentially unsafe.
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function uniquePath(dir: string, baseName: string, extensionWithDot: string) {
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

function md5Hex(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function coerceToBuffer(value: any): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));

  // Sometimes libraries decode binary as base64 string
  if (typeof value === 'string') {
    // Heuristic: base64 is usually longer and contains only base64 chars
    const isLikelyBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length % 4 === 0;
    if (isLikelyBase64) {
      try {
        return Buffer.from(value, 'base64');
      } catch {
        // fall through
      }
    }
    return Buffer.from(value, 'utf8');
  }

  return null;
}

function encodeHFPath(p: string) {
  return p
    .split('/')
    .filter(Boolean)
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

type HFDownloadOk = {
  ok: true;
  buf: Buffer;
  status: number;
  statusText: string;
  url: string;
  finalUrl: string;
  contentType: string | null;
  contentEncoding: string | null;
};

type HFDownloadErr = {
  ok: false;
  status: number;
  statusText: string;
  url: string;
  hfErrorMessage?: string;
  bodyPreview?: string;
};

type HFDownloadAttempt = HFDownloadOk | HFDownloadErr;

function isErrAttempt(a: HFDownloadAttempt): a is HFDownloadErr {
  return (a as HFDownloadErr).ok === false;
}

async function downloadHFFile(
  repoId: string,
  revision: string,
  filePath: string,
  repoType: HFRepoType,
): Promise<HFDownloadOk> {
  // Important: if the user has an HF token set, it may be required for gated/private repos.
  // Also: tokens sometimes get pasted with quotes/newlines or already prefixed with "Bearer".
  // We sanitize hard to avoid accidental 401/404s.
  let token = (await getHFToken()) || '';
  token = token
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^"(.+)"$/, '$1')
    .replace(/^'(.+)'$/, '$1')
    .split(/\s+/)[0];

  const baseHeaders: Record<string, string> = {
    // Some hosts behave differently depending on UA; setting one avoids edge cases.
    'User-Agent': 'ai-toolkit',
    Accept: '*/*',
  };

  const headersWithAuth: Record<string, string> = token
    ? {
        ...baseHeaders,
        Authorization: `Bearer ${token}`,
      }
    : baseHeaders;

  const headersNoAuth: Record<string, string> = baseHeaders;

  const rev = encodeURIComponent(revision || 'main');
  const fp = encodeHFPath(filePath);

  const buildUrl = (type: Exclude<HFRepoType, 'auto'>) => {
    if (type === 'datasets') {
      return `https://huggingface.co/datasets/${repoId}/resolve/${rev}/${fp}`;
    }
    return `https://huggingface.co/${repoId}/resolve/${rev}/${fp}`;
  };

  const withDownloadQuery = (url: string) => (url.includes('?') ? `${url}&download=true` : `${url}?download=true`);

  const tryFetch = async (url: string, headers: Record<string, string>): Promise<HFDownloadAttempt> => {
    const res = await fetch(url, { headers, redirect: 'follow' });
    if (res.ok) {
      const arr = await res.arrayBuffer();
      return {
        ok: true as const,
        buf: Buffer.from(arr),
        status: res.status,
        statusText: res.statusText,
        url,
        finalUrl: res.url || url,
        contentType: res.headers.get('content-type'),
        contentEncoding: res.headers.get('content-encoding'),
      };
    }

    const text = await res.text().catch(() => '');
    const hfErr = res.headers.get('x-error-message') || '';
    return {
      ok: false as const,
      status: res.status,
      statusText: res.statusText,
      url,
      hfErrorMessage: hfErr,
      bodyPreview: text.slice(0, 300),
    };
  };

  const tryWithFallbackAuth = async (url: string): Promise<HFDownloadAttempt> => {
    const candidates = [url, withDownloadQuery(url)];

    const attemptOnce = async (u: string, headers: Record<string, string>) => {
      const r = await tryFetch(u, headers);
      if (r.ok) return r;
      return r;
    };

    if (token) {
      // Try with auth first
      for (const u of candidates) {
        const attemptAuth = await attemptOnce(u, headersWithAuth);
        if (attemptAuth.ok) return attemptAuth;

        // Then retry without auth (helps when repo/file is public or auth header is rejected)
        const attemptNoAuth = await attemptOnce(u, headersNoAuth);
        if (attemptNoAuth.ok) return attemptNoAuth;

        // Keep going to next candidate URL
      }

      // If everything failed, return the last auth attempt details.
      return await tryFetch(candidates[candidates.length - 1], headersWithAuth);
    }

    for (const u of candidates) {
      const out = await attemptOnce(u, headersNoAuth);
      if (out.ok) return out;
    }

    return await tryFetch(candidates[candidates.length - 1], headersNoAuth);
  };

  const formatAttempt = (label: string, a: HFDownloadAttempt) => {
    const extra = isErrAttempt(a)
      ? [a.hfErrorMessage ? `x-error-message: ${a.hfErrorMessage}` : '', a.bodyPreview ? a.bodyPreview : '']
          .filter(Boolean)
          .join(' | ')
      : '';
    return `- ${label}: ${a.url} -> ${a.status} ${a.statusText}${extra ? ` (${extra})` : ''}`;
  };

  if (repoType === 'datasets' || repoType === 'models') {
    const url = buildUrl(repoType);
    const out = await tryWithFallbackAuth(url);
    if (out.ok) return out;

    throw new Error(
      `Failed to download from Hugging Face (${out.status} ${out.statusText}) at ${out.url}: ` +
        `${out.hfErrorMessage || out.bodyPreview || ''}`,
    );
  }

  // repoType === 'auto' -> try dataset repo first, then model repo.
  const datasetAttempt = await tryWithFallbackAuth(buildUrl('datasets'));
  if (datasetAttempt.ok) return datasetAttempt;

  const modelAttempt = await tryWithFallbackAuth(buildUrl('models'));
  if (modelAttempt.ok) return modelAttempt;

  throw new Error(
    `Failed to download from Hugging Face. Tried:\n` +
      `${formatAttempt('datasets', datasetAttempt)}\n` +
      `${formatAttempt('models', modelAttempt)}\n` +
      `\nIf the file downloads in your browser but fails here, it usually means the server is not receiving a valid HF token. ` +
      `Please re-save HF_TOKEN in Settings (paste the raw \"hf_...\" token, no quotes).`,
  );
}

function isParquetBuffer(buf: Buffer): boolean {
  // Parquet files start AND end with the magic bytes "PAR1".
  if (!buf || buf.length < 8) return false;
  return buf.subarray(0, 4).toString('ascii') === 'PAR1' && buf.subarray(buf.length - 4).toString('ascii') === 'PAR1';
}

function looksLikeGitLFSPointer(buf: Buffer): boolean {
  const head = buf.subarray(0, 200).toString('utf8');
  return head.startsWith('version https://git-lfs.github.com/spec/v1');
}

function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head');
}

function maybeGunzip(buf: Buffer, contentEncoding: string | null, contentType: string | null): Buffer {
  const enc = (contentEncoding || '').toLowerCase();
  const ct = (contentType || '').toLowerCase();
  if (enc.includes('gzip') || ct.includes('gzip') || ct.includes('application/gzip')) {
    try {
      return zlib.gunzipSync(buf);
    } catch {
      // If gunzip fails, return original.
      return buf;
    }
  }
  return buf;
}

async function downloadHFFileAsBuffer(
  repoId: string,
  revision: string,
  filePath: string,
  repoType: HFRepoType,
  opts?: { expectParquet?: boolean },
): Promise<Buffer> {
  const out = await downloadHFFile(repoId, revision, filePath, repoType);

  let buf = out.buf;
  buf = maybeGunzip(buf, out.contentEncoding, out.contentType);

  if (opts?.expectParquet) {
    if (!isParquetBuffer(buf)) {
      const preview = buf.subarray(0, 400).toString('utf8');
      const hints: string[] = [];
      if (looksLikeGitLFSPointer(buf)) hints.push('The downloaded file looks like a Git-LFS pointer (not the actual parquet).');
      if (looksLikeHtml(buf)) hints.push('The downloaded file looks like HTML (likely a login/404 page).');
      if ((out.contentType || '').includes('text/html')) hints.push(`content-type=${out.contentType}`);

      throw new Error(
        `Invalid parquet file received from Hugging Face.\n` +
          `Requested: ${out.url}\n` +
          `Final URL: ${out.finalUrl}\n` +
          `content-type: ${out.contentType || 'unknown'}\n` +
          `${hints.length ? `Hint: ${hints.join(' ')}` + '\n' : ''}` +
          `First bytes preview: ${JSON.stringify(preview.slice(0, 300))}`,
      );
    }
  }

  return buf;
}

function getSidecarCaptionPath(imageAbsPath: string) {
  return imageAbsPath.replace(/\.[^/.]+$/, '') + '.txt';
}

function pickCaptionColumn(row: any): string | null {
  if (row?.text != null) return String(row.text);
  if (row?.caption != null) return String(row.caption);
  return null;
}

function pickImageColumn(row: any): any {
  return row?.image;
}

const execFileAsync = promisify(execFile);

async function importWithNodeHelper(parquetBuffer: Buffer, datasetDir: string): Promise<any> {
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aitk-parquet-'));
  const parquetPath = path.join(tmpBase, 'input.parquet');
  await fs.promises.writeFile(parquetPath, parquetBuffer);

  try {
    const cwd = process.cwd();
    // In `ui/` deployments, cwd is often `${repoRoot}/ui`.
    const candidates = [
      path.join(cwd, 'scripts', 'import-hf-parquet.mjs'),
      path.join(cwd, 'ui', 'scripts', 'import-hf-parquet.mjs'),
    ];

    const scriptPath = candidates.find(p => fs.existsSync(p));
    if (!scriptPath) {
      throw new Error(`Could not find helper script. Tried: ${candidates.join(', ')}`);
    }

    const { stdout, stderr } = await execFileAsync(process.execPath, [
      scriptPath,
      '--datasetDir',
      datasetDir,
      '--parquetFile',
      parquetPath,
    ]);

    if (stderr && String(stderr).trim()) {
      // Keep stderr for debugging but still attempt to parse stdout.
      console.warn('HF parquet helper stderr:', String(stderr).slice(0, 4000));
    }

    return JSON.parse(String(stdout || '{}'));
  } catch (e: any) {
    // Attach context for easier debugging
    throw new Error(`Parquet helper failed: ${e?.message || String(e)}`);
  } finally {
    // Best-effort cleanup
    await fs.promises.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

async function inferExtensionFromBytes(imageBytes: Buffer): Promise<string | null> {
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    const ft = await fileTypeFromBuffer(imageBytes);
    return ft?.ext || null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const datasetName = String(body?.datasetName || '').trim();
    const hfParquetPath = String(body?.hfParquetPath || '').trim();

    if (!datasetName) {
      return NextResponse.json({ error: 'datasetName is required' }, { status: 400 });
    }
    if (!hfParquetPath) {
      return NextResponse.json({ error: 'hfParquetPath is required' }, { status: 400 });
    }

    const datasetsRoot = await getDatasetsRoot();
    const datasetDir = path.join(datasetsRoot, datasetName);
    await mkdir(datasetDir, { recursive: true });

    const { repoId, revision, filePath, repoType } = parseHFParquetPath(hfParquetPath);

    const parquetBuffer = await downloadHFFileAsBuffer(repoId, revision, filePath, repoType, { expectParquet: true });

    const result = await importWithNodeHelper(parquetBuffer, datasetDir);
    return NextResponse.json(result);
  } catch (error: any) {
    // Some libs can throw non-Error values.
    const message = typeof error === 'string' ? error : error?.message || String(error) || 'Failed to import parquet';
    console.error('HF parquet import error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
