// Simple diagnostic script: downloads a HF parquet resolve URL and checks for the Parquet magic bytes.
// Usage:
//   node ui/scripts/verify-hf-parquet-download.mjs "https://huggingface.co/datasets/org/repo/resolve/main/file.parquet"
// Optionally provide an HF token:
//   HF_TOKEN=hf_xxx node ui/scripts/verify-hf-parquet-download.mjs "..."

import { gunzipSync } from 'node:zlib';

function isParquet(buf) {
  if (!buf || buf.length < 8) return false;
  return buf.subarray(0, 4).toString('ascii') === 'PAR1' && buf.subarray(buf.length - 4).toString('ascii') === 'PAR1';
}

function looksLikeHtml(buf) {
  const head = buf.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head');
}

function looksLikeGitLFSPointer(buf) {
  const head = buf.subarray(0, 200).toString('utf8');
  return head.startsWith('version https://git-lfs.github.com/spec/v1');
}

const url = process.argv[2];
if (!url) {
  console.error('Missing URL argument');
  process.exit(2);
}

const token = process.env.HF_TOKEN || '';
const headers = {
  'User-Agent': 'ai-toolkit-verify',
  Accept: '*/*',
  ...(token ? { Authorization: `Bearer ${token.replace(/^Bearer\s+/i, '')}` } : {}),
};

const res = await fetch(url, { headers, redirect: 'follow' });
console.log('status:', res.status, res.statusText);
console.log('requested:', url);
console.log('finalUrl:', res.url);
console.log('content-type:', res.headers.get('content-type'));
console.log('content-encoding:', res.headers.get('content-encoding'));

const arr = await res.arrayBuffer();
let buf = Buffer.from(arr);

const enc = (res.headers.get('content-encoding') || '').toLowerCase();
const ct = (res.headers.get('content-type') || '').toLowerCase();
if (enc.includes('gzip') || ct.includes('gzip') || ct.includes('application/gzip')) {
  try {
    buf = gunzipSync(buf);
    console.log('gunzip: ok');
  } catch (e) {
    console.log('gunzip: failed', String(e));
  }
}

console.log('bytes:', buf.length);
console.log('isParquet:', isParquet(buf));

if (!isParquet(buf)) {
  console.log('looksLikeHtml:', looksLikeHtml(buf));
  console.log('looksLikeGitLFSPointer:', looksLikeGitLFSPointer(buf));
  console.log('preview:', JSON.stringify(buf.subarray(0, 300).toString('utf8')));
  process.exitCode = 1;
}
