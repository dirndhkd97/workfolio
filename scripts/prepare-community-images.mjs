#!/usr/bin/env node
// Keep uploads private. Published images are served through the application.
const ACCOUNT = 'ae40d286be880d4faf549a14530875dc';
const BUCKET = 'workfolio-community-images';
const mode = process.argv[2];
if (!['--preflight', '--apply'].includes(mode)) throw new Error('Use --preflight or --apply.');
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required.');
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT) throw new Error('Unexpected Cloudflare account.');

async function request(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`Image storage request failed (HTTP ${response.status}, codes ${(data.errors || []).map(error => Number(error.code)).join(',')}). R2 must be enabled and the deployment token must have Workers R2 Storage Edit permission.`);
  return data.result;
}

const result = await request('GET', '');
const exists = result.buckets?.some(bucket => bucket.name === BUCKET) === true;
if (!exists && mode === '--apply') await request('POST', '', { name: BUCKET });
console.log(JSON.stringify({ stage: 'image-storage', bucket: BUCKET, exists: exists || mode === '--apply', created: !exists && mode === '--apply', mode }));
