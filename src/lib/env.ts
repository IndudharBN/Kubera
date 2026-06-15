export const env = {
  appName: import.meta.env.VITE_APP_NAME || 'Sutra',
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL || '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  t212BridgeUrl: import.meta.env.VITE_T212_BRIDGE_URL || '',
  alpacaKey: import.meta.env.VITE_ALPACA_KEY || '',
  alpacaSecret: import.meta.env.VITE_ALPACA_SECRET || '',
  alpacaDataUrl: import.meta.env.VITE_ALPACA_DATA_URL || 'https://data.alpaca.markets',
  finnhubKey: import.meta.env.VITE_FINNHUB_KEY || '',
};

export function hasSupabaseConfig() {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}

export function hasAlpacaConfig() {
  return Boolean(env.alpacaKey && env.alpacaSecret);
}
