// pm2 process config — run from project root.
// Usage: pm2 start ecosystem.config.cjs   ← start both apps
//        pm2 stop all / pm2 restart all
//        pm2 logs sutra-daemon / pm2 logs sutra-ui
//        pm2 save        ← persist process list across reboots (re-run after any change)

'use strict';

module.exports = {
  apps: [
    {
      name: 'sutra-daemon',
      script: './daemon/dist/index.js',
      // CWD must be project root so data/ and daemon/.env.daemon resolve correctly
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      // Log files (relative to CWD)
      out_file: './logs/daemon-out.log',
      error_file: './logs/daemon-error.log',
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Keep last 7 days / 50 MB of logs (requires pm2-logrotate)
      // pm2 install pm2-logrotate

      env: {
        NODE_ENV: 'production',
      },
    },

    {
      name: 'sutra-ui',
      script: './node_modules/vite/bin/vite.js',
      args: '--port=3006 --host=0.0.0.0',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      out_file: './logs/ui-out.log',
      error_file: './logs/ui-error.log',
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
