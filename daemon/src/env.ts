import path from 'path';
import dotenv from 'dotenv';

// Load daemon/.env.daemon — must run before anything else imports env
dotenv.config({ path: path.join(__dirname, '../.env.daemon') });

export const env = {
  DAEMON_PORT:  parseInt(process.env['DAEMON_PORT'] ?? '5003', 10), // Kubera backend = 5003 (Sutra uses 3001)
  // Safety: execution is OFF unless explicitly enabled (shadow-first posture).
  AUTO_EXECUTE: process.env['DAEMON_AUTO_EXECUTE'] === 'true',
};
