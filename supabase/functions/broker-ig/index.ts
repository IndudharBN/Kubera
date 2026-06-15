import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405 });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      status: 'scaffold',
      broker: 'ig-share-dealing',
      message: 'IG Share Dealing protected broker function scaffold is ready.',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
});
