import { getStore } from '@netlify/blobs';

function codeFrom(req) {
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') || '').trim();
  return /^[a-z0-9]{12,}$/i.test(code) ? code : null;
}

export default async (req) => {
  const store = getStore({ name: 'grocery', consistency: 'strong' });
  const code = codeFrom(req);
  if (!code) return new Response('Bad or missing code', { status: 400 });
  const key = 'sync/' + code.toLowerCase();

  if (req.method === 'GET') {
    const data = await store.get(key, { type: 'json' });
    if (!data) return new Response('Not found', { status: 404 });
    return Response.json(data);
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    if (!body || typeof body !== 'object') return new Response('Bad payload', { status: 400 });
    body.syncedAt = Date.now();
    await store.setJSON(key, body);
    return Response.json({ ok: true, syncedAt: body.syncedAt });
  }

  return new Response('Method not allowed', { status: 405 });
};
