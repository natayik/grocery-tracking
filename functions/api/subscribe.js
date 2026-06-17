// Stores or removes a push subscription, paired with the user's sync code and postal code.
// The deal-checker cron uses this to know who to notify and where to check flyers.
export async function onRequest({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const { syncCode, subscription, postal } = body || {};
  if (!syncCode || !/^[a-z0-9]{12,}$/i.test(syncCode)) {
    return new Response('Missing or invalid syncCode', { status: 400 });
  }
  const key = 'sub/' + syncCode.toLowerCase();
  const kv = env.GROCERY_KV;

  if (request.method === 'DELETE') {
    await kv.delete(key);
    return Response.json({ ok: true });
  }

  if (request.method === 'POST') {
    if (!subscription) return new Response('Missing subscription', { status: 400 });
    const existing = await kv.get(key);
    const record = existing ? JSON.parse(existing) : {};
    record.subscription = subscription;
    if (postal) record.postal = postal;
    await kv.put(key, JSON.stringify(record));
    return Response.json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
}
