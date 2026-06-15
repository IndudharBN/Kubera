// Kubera — Zerodha Kite env loader.
//
// Deliberately does NOT throw at import (unlike ../env.ts which requires Alpaca
// keys) so the daemon builds and other modules import cleanly without creds.
// Credentials are validated lazily via assertKiteCreds() when a live call runs.
//
// Daily login: Kite issues a fresh access_token each morning (request_token →
// generateSession). Automate the login (TOTP) pre-open and write KITE_ACCESS_TOKEN
// into daemon/.env.daemon, or call setRuntimeAccessToken() after a programmatic login.

import path from 'path';
import dotenv from 'dotenv';

// daemon/dist/kite/kiteEnv.js → ../../.env.daemon = daemon/.env.daemon
dotenv.config({ path: path.join(__dirname, '../../.env.daemon') });

export type KiteProduct = 'MIS' | 'CNC' | 'NRML';

export const kiteEnv = {
  API_KEY:       process.env['KITE_API_KEY'] ?? '',
  API_SECRET:    process.env['KITE_API_SECRET'] ?? '',
  ACCESS_TOKEN:  process.env['KITE_ACCESS_TOKEN'] ?? '',

  // For unattended daily auto-login (TOTP). Optional — if absent, set ACCESS_TOKEN manually.
  USER_ID:       process.env['KITE_USER_ID'] ?? '',
  PASSWORD:      process.env['KITE_PASSWORD'] ?? '',
  TOTP_SECRET:   process.env['KITE_TOTP_SECRET'] ?? '',

  // India trading config (₹1L intraday MIS @ 1× by default)
  PRODUCT:          (process.env['KITE_PRODUCT'] as KiteProduct) ?? 'MIS',
  CAPITAL_CAP_INR:  parseFloat(process.env['CAPITAL_CAP_INR'] ?? '100000'),
  DEPLOY_CAP_PCT:   parseFloat(process.env['DEPLOY_CAP_PCT'] ?? '0.70'),

  // Safety: auto-execute is OFF unless explicitly enabled (shadow-first posture).
  AUTO_EXECUTE:  process.env['DAEMON_AUTO_EXECUTE'] === 'true',
};

let _runtimeToken: string | null = null;

/** Override the access token at runtime (e.g. after a programmatic daily login). */
export function setRuntimeAccessToken(token: string): void {
  _runtimeToken = token;
}

export function accessToken(): string {
  return _runtimeToken ?? kiteEnv.ACCESS_TOKEN;
}

/** Throw a clear error if the credentials needed for a live call are absent. */
export function assertKiteCreds(): void {
  if (!kiteEnv.API_KEY) {
    throw new Error('KITE_API_KEY missing — set it in daemon/.env.daemon');
  }
  if (!accessToken()) {
    throw new Error(
      'KITE_ACCESS_TOKEN missing — generate the daily token (request_token → generateSession) ' +
      'and set KITE_ACCESS_TOKEN in daemon/.env.daemon, or call setRuntimeAccessToken()',
    );
  }
}
