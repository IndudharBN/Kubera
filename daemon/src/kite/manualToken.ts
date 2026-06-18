// Kubera — one-shot manual access-token generator.
//
// Use this when programmatic auto-login can't complete the Connect redirect
// (e.g. a brand-new Kite Connect app that needs a one-time browser approval).
//
//   1. Print the login URL:        npm run kite:token
//   2. Open it in a browser, log in + approve the app. Zerodha redirects to your
//      app's Redirect URL with ...?request_token=XXXXX&action=login&status=success
//   3. Copy that request_token (or the whole redirected URL) and run:
//        npm run kite:token -- <request_token | full redirect URL>
//   4. It exchanges request_token → access_token, persists it for today, and the
//      backtest / daemon will pick it up automatically (loadTodaysToken()).
//
// The access_token expires ~07:30 IST next morning; re-run for a fresh day, or
// fix TOTP auto-login for unattended refresh.

import { kiteEnv } from './kiteEnv';
import { exchangeRequestToken } from './kiteLogin';

function extractRequestToken(arg: string): string {
  // Accept either a bare token or a full redirect URL containing request_token=...
  const m = arg.match(/request_token=([^&\s]+)/);
  return m ? decodeURIComponent(m[1]) : arg.trim();
}

async function main(): Promise<void> {
  if (!kiteEnv.API_KEY || !kiteEnv.API_SECRET) {
    console.error('✗ set KITE_API_KEY and KITE_API_SECRET in daemon/.env.daemon first');
    process.exit(1);
  }

  const arg = process.argv[2];
  if (!arg) {
    const url = `https://kite.zerodha.com/connect/login?api_key=${kiteEnv.API_KEY}&v=3`;
    console.log('\n=== Kubera manual Kite login ===');
    console.log('1) Open this URL in a browser and log in (approve the app if prompted):\n');
    console.log('   ' + url + '\n');
    console.log('2) You will be redirected to your app Redirect URL with ?request_token=XXXX');
    console.log('3) Re-run with that token (or the whole redirected URL):\n');
    console.log('   npm run kite:token -- <request_token | full redirect URL>\n');
    process.exit(0);
  }

  const requestToken = extractRequestToken(arg);
  console.log('exchanging request_token (…' + requestToken.slice(-6) + ') for access_token…');
  try {
    const token = await exchangeRequestToken(requestToken);
    console.log('✓ access_token obtained and persisted for today (…' + token.slice(-6) + ')');
    console.log('  → run:  npm run kite:check   (then npm run bt:nse)');
    process.exit(0);
  } catch (e) {
    console.error('✗ exchange failed —', (e as Error).message);
    console.error('  request_token is single-use and expires in minutes; redo step 1 for a fresh one.');
    process.exit(1);
  }
}

main();
