import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405 });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      status: 'scaffold',
      broker: 'ibkr',
      message: 'IBKR scaffold is ready. IBKR will still need a Client Portal or Gateway bridge.',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
});
