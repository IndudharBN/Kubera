import path from 'path';
import dotenv from 'dotenv';

// Load daemon/.env.daemon — must run before anything else imports env
dotenv.config({ path: path.join(__dirname, '../.env.daemon') });

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const env = {
  ALPACA_KEY:    require_env('ALPACA_KEY'),
  ALPACA_SECRET: require_env('ALPACA_SECRET'),
  ALPACA_BASE_URL: process.env['ALPACA_BASE_URL'] ?? 'https://paper-api.alpaca.markets',
  DAEMON_PORT:   parseInt(process.env['DAEMON_PORT'] ?? '3001', 10),
  AUTO_EXECUTE:  process.env['DAEMON_AUTO_EXECUTE'] !== 'false',
};
