// Kubera — Zerodha Kite daily auto-login (TOTP).
//
// Kite issues a fresh access_token each morning (expires ~07:30 IST next day). This
// automates the request_token → access_token exchange so the daemon refreshes itself
// pre-open with no manual login.
//
// Flow (uses Kite's web login endpoints + the Connect redirect):
//   1. POST /api/login  (user_id + password) → request_id
//   2. POST /api/twofa  (request_id + TOTP) → session cookies
//   3. GET  /connect/login?api_key  → redirect carrying request_token
//   4. kc.generateSession(request_token, api_secret) → access_token
//
// Steps 1–3 hit internal endpoints and can change; on any failure we fall back to
// a clear instruction to set KITE_ACCESS_TOKEN manually, and the daemon still boots.
// TOTP is computed locally (RFC 6238) — no extra dependency.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { KiteConnect } from 'kiteconnect';
import { kiteEnv, accessToken, setRuntimeAccessToken } from './kiteEnv';

const TOKEN_FILE = path.join(__dirname, '../../../data/kite-token.json');

// ── TOTP (RFC 6238: SHA1, 6 digits, 30s) from a base32 secret ─────────────────
function base32ToBuffer(b32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = b32.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx >= 0) bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32ToBuffer(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
            | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

// ── token persistence (skip re-login if today's token already exists) ─────────
function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function persistToken(token: string): void {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: token, date: todayIST() }));
  } catch { /* best-effort */ }
}

function loadTodaysToken(): string | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) as { access_token: string; date: string };
    return j.date === todayIST() && j.access_token ? j.access_token : null;
  } catch { return null; }
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}
function getSetCookies(resp: Response): string[] {
  const h = resp.headers as unknown as { getSetCookie?: () => string[] };
  return h.getSetCookie?.() ?? [];
}

/** Exchange a request_token for an access_token and activate it. */
export async function exchangeRequestToken(requestToken: string): Promise<string> {
  const kc = new KiteConnect({ api_key: kiteEnv.API_KEY });
  const session = (await kc.generateSession(requestToken, kiteEnv.API_SECRET)) as unknown as { access_token: string };
  if (!session.access_token) throw new Error('generateSession returned no access_token');
  setRuntimeAccessToken(session.access_token);
  persistToken(session.access_token);
  return session.access_token;
}

/** Full TOTP auto-login → access_token. Throws on failure (caller falls back). */
export async function autoLogin(): Promise<string> {
  const { USER_ID, PASSWORD, TOTP_SECRET, API_KEY, API_SECRET } = kiteEnv;
  if (!(USER_ID && PASSWORD && TOTP_SECRET && API_KEY && API_SECRET)) {
    throw new Error('auto-login needs KITE_USER_ID, KITE_PASSWORD, KITE_TOTP_SECRET, KITE_API_KEY, KITE_API_SECRET');
  }

  // 1. password login → request_id
  const r1 = await fetch('https://kite.zerodha.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_id: USER_ID, password: PASSWORD }),
  });
  const j1 = (await r1.json()) as { data?: { request_id?: string }; message?: string };
  const requestId = j1.data?.request_id;
  if (!requestId) throw new Error(`login failed: ${j1.message ?? JSON.stringify(j1)}`);
  let cookies = getSetCookies(r1);

  // 2. TOTP 2FA → session cookies
  const r2 = await fetch('https://kite.zerodha.com/api/twofa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(cookies) },
    body: new URLSearchParams({
      user_id: USER_ID, request_id: requestId,
      twofa_value: totp(TOTP_SECRET), twofa_type: 'totp',
    }),
  });
  const j2 = (await r2.json()) as { status?: string; message?: string };
  if (j2.status !== 'success') throw new Error(`2FA failed: ${j2.message ?? JSON.stringify(j2)}`);
  cookies = [...cookies, ...getSetCookies(r2)];

  // 3. Connect login → follow redirects until request_token appears
  let url: string | null = `https://kite.zerodha.com/connect/login?api_key=${API_KEY}&v=3`;
  let requestToken: string | null = null;
  for (let hop = 0; hop < 6 && url && !requestToken; hop++) {
    const resp: Response = await fetch(url, { headers: { Cookie: cookieHeader(cookies) }, redirect: 'manual' });
    cookies = [...cookies, ...getSetCookies(resp)];
    const loc = resp.headers.get('location');
    if (!loc) break;
    const m = loc.match(/request_token=([^&]+)/);
    if (m) { requestToken = decodeURIComponent(m[1]); break; }
    url = loc.startsWith('http') ? loc : `https://kite.zerodha.com${loc}`;
  }
  if (!requestToken) throw new Error('could not obtain request_token from Connect redirect');

  // 4. exchange
  return exchangeRequestToken(requestToken);
}

/**
 * Ensure a valid access_token before trading. Order of preference:
 *   1. token already active (env KITE_ACCESS_TOKEN or runtime)
 *   2. today's persisted token (from an earlier auto-login)
 *   3. TOTP auto-login (if creds present)
 * Never throws — logs and returns false so the daemon still boots (and warns).
 */
export async function ensureKiteLogin(): Promise<boolean> {
  if (accessToken()) return true;

  const cached = loadTodaysToken();
  if (cached) { setRuntimeAccessToken(cached); console.log('[kite] using today’s cached access token'); return true; }

  if (!(kiteEnv.USER_ID && kiteEnv.PASSWORD && kiteEnv.TOTP_SECRET)) {
    console.warn('[kite] no access token and no auto-login creds — set KITE_ACCESS_TOKEN or KITE_USER_ID/PASSWORD/TOTP_SECRET in daemon/.env.daemon');
    return false;
  }
  try {
    await autoLogin();
    console.log('[kite] auto-login OK — access token refreshed');
    return true;
  } catch (err) {
    console.error('[kite] auto-login FAILED —', (err as Error).message,
      '\n        → generate a token manually and set KITE_ACCESS_TOKEN, or fix creds');
    return false;
  }
}
