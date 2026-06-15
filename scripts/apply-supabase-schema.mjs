import fs from 'node:fs';
import pg from 'pg';

const { Client } = pg;

const password = process.env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error('SUPABASE_DB_PASSWORD is required.');
  process.exit(1);
}

const sql = fs.readFileSync('supabase/schema.sql', 'utf8');
const client = new Client({
  host: 'db.pvefihftymdnrdgbqsgr.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  await client.query(sql);
  const result = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        'user_settings',
        'broker_connections',
        'scanner_signals',
        'scan_runs',
        'app_orders',
        'broker_positions',
        'performance_events'
      )
    order by table_name
  `);
  console.log(JSON.stringify({
    ok: true,
    tables: result.rows.map((row) => row.table_name),
  }, null, 2));
} finally {
  await client.end().catch(() => {});
}
