import path from 'path';
import dotenv from 'dotenv';

// Load daemon/.env.daemon — must run before anything else imports env
dotenv.config({ path: path.join(__dirname, '../.env.daemon') });

export const env = {
  // Provider selector: 'kite' (NSE — default) or 'alpaca' (legacy US baseline).
  BROKER: (process.env['BROKER'] ?? 'kite') as 'kite' | 'alpaca',

  // Alpaca (legacy baseline) — optional now; only used when BROKER='alpaca'.
  ALPACA_KEY:      process.env['ALPACA_KEY'] ?? '',
  ALPACA_SECRET:   process.env['ALPACA_SECRET'] ?? '',
  ALPACA_BASE_URL: process.env['ALPACA_BASE_URL'] ?? 'https://paper-api.alpaca.markets',

  DAEMON_PORT:  parseInt(process.env['DAEMON_PORT'] ?? '5003', 10), // Kubera backend = 5003 (Sutra uses 3001)
  // Safety: execution is OFF unless explicitly enabled (shadow-first posture).
  AUTO_EXECUTE: process.env['DAEMON_AUTO_EXECUTE'] === 'true',
};
