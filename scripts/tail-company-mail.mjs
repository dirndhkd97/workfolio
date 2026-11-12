#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT = 'ae40d286be880d4faf549a14530875dc';
const MARKER = 'community_company_mail_failure';
const KINDS = new Set(['configuration_encoding', 'network', 'timeout', 'provider_rejected']);
const MAX_DURATION_MS = 120000;

function parseDetails(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { /* Some runtimes use console inspection syntax. */ }
  const match = /^\{\s*kind:\s*['"](configuration_encoding|network|timeout|provider_rejected)['"],\s*status:\s*(null|\d{3})\s*\}$/.exec(value);
  return match ? { kind: match[1], status: match[2] === 'null' ? null : Number(match[2]) } : null;
}

// Ignore every request field and every other console message. Construct a new
// object rather than forwarding any provider-owned or application-owned object.
export function safeFailures(event) {
  const failures = [];
  for (const log of Array.isArray(event?.logs) ? event.logs : []) {
    if (log?.level !== 'error' || !Array.isArray(log.message)) continue;
    let details;
    if (log.message[0] === MARKER) details = parseDetails(log.message[1]);
    else if (log.message.length === 1 && typeof log.message[0] === 'string' && log.message[0].startsWith(`${MARKER} `)) {
      details = parseDetails(log.message[0].slice(MARKER.length + 1));
    }
    if (!details || !KINDS.has(details.kind)) continue;
    const status = details.status;
    if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) continue;
    if (details.kind !== 'provider_rejected' && status !== null) continue;
    failures.push({ kind: details.kind, status });
  }
  return failures;
}

// Wrangler 4.77's jsonPrintLogs calls logger.json, which prints an entire pretty
// JSON object (four-space indentation), not one JSON object per line. Recognize
// balanced objects across arbitrary stream chunks, with bounded memory. Invalid
// or oversized frames are discarded, never printed or saved.
export function createObjectParser(onObject, maxChars = 1024 * 1024) {
  let depth = 0, quoted = false, escaped = false, frame = '', oversized = false;
  return {
    write(chunk) {
      for (const char of chunk) {
        if (!depth) {
          if (char !== '{') continue;
          depth = 1; quoted = false; escaped = false; frame = '{'; oversized = false;
          continue;
        }
        if (!oversized) {
          frame += char;
          if (frame.length > maxChars) { frame = ''; oversized = true; }
        }
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (!depth) {
            if (!oversized) {
              let object;
              try { object = JSON.parse(frame); } catch { /* Discard non-JSON CLI output. */ }
              if (object) onObject(object);
            }
            frame = '';
          }
        }
      }
    },
    clear() { depth = 0; quoted = false; escaped = false; frame = ''; oversized = false; },
  };
}

// Official GET endpoint. Wrangler requires an explicit deployment ID in CI even
// with --environment production, so resolve the latest successful deployment.
// https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/
export async function productionDeployment(token, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/workfolio/deployments?env=production&per_page=25`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.success !== true || !Array.isArray(data.result)) return null;
    return data.result.filter(item => item?.environment === 'production'
      && item.latest_stage?.name === 'deploy' && item.latest_stage?.status === 'success'
      && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(item.id)
      && Number.isFinite(Date.parse(item.created_on)))
      .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0]?.id ?? null;
  } catch { return null; }
}

export async function tailProcess({ deployment, env, logPath, durationMs, spawnImpl = spawn, killImpl = process.kill, write = line => process.stdout.write(line) }) {
  return new Promise(resolveResult => {
    let child, done = false, expired = false, killTimer, timeout;
    const parser = createObjectParser(event => {
      for (const failure of safeFailures(event)) write(`${JSON.stringify(failure)}\n`);
    });
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timeout); clearTimeout(killTimer); parser.clear();
      process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
      resolveResult(ok);
    };
    const kill = signal => { if (child?.pid) { try { killImpl(-child.pid, signal); } catch { /* Already exited. */ } } };
    const cancel = () => { kill('SIGKILL'); finish(false); };
    try {
      child = spawnImpl('npx', ['--no-install', 'wrangler', 'pages', 'deployment', 'tail', deployment,
        '--project-name', 'workfolio', '--environment', 'production', '--format', 'json', '--search', MARKER], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CI: 'true', WRANGLER_SEND_METRICS: 'false',
          WRANGLER_LOG_PATH: logPath, WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG: 'error',
          NO_COLOR: '1', npm_config_logs_max: '0', npm_config_update_notifier: 'false' },
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (!done) parser.write(chunk); });
      child.stderr.on('data', () => {}); // Drop all CLI errors; they can include request data.
      child.on('error', () => finish(false));
      child.on('close', code => finish(expired || code === 0));
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      timeout = setTimeout(() => {
        expired = true;
        kill('SIGTERM');
        killTimer = setTimeout(() => { kill('SIGKILL'); finish(true); }, Math.min(1000, durationMs));
      }, Math.max(0, durationMs - Math.min(1000, durationMs)));
    } catch { finish(false); }
  });
}

export async function main() {
  const startedAt = Date.now();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token || (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT)) return false;
  const deployment = await productionDeployment(token);
  if (!deployment) return false;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'workfolio-mail-tail-'));
    const logPath = join(directory, 'discard.log');
    // Wrangler writes debug logs independently of stdout. The .log suffix makes
    // it use this exact path; a null-device symlink prevents raw data persistence.
    await symlink('/dev/null', logPath);
    const remaining = MAX_DURATION_MS - (Date.now() - startedAt);
    if (remaining <= 0) return false;
    return await tailProcess({ deployment, env: process.env, logPath, durationMs: remaining });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Exit code signals setup/connection failure. Stdout contains ONLY allowlisted
  // kind/status pairs; neither stderr nor thrown error text is exposed.
  main().then(ok => { if (!ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; });
}
