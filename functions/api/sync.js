export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  if (!/^[a-z0-9]{12,}$/i.test(code)) {
    return new Response('Bad or missing code', { status: 400 });
  }
  const key = 'sync/' + code.toLowerCase();
  const kv = env.GROCERY_KV;

  if (request.method === 'GET') {
    const raw = await kv.get(key);
    if (!raw) return new Response('Not found', { status: 404 });
    return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    if (!body || typeof body !== 'object') return new Response('Bad payload', { status: 400 });
    body.syncedAt = Date.now();
    await kv.put(key, JSON.stringify(body));
    return Response.json({ ok: true, syncedAt: body.syncedAt });
  }

  return new Response('Method not allowed', { status: 405 });
}
