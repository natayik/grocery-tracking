import webpush from 'web-push';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const subscription = body && body.subscription;
  if (!subscription) return new Response('Missing subscription', { status: 400 });

  const kv = env.GROCERY_KV;
  const raw = await kv.get('vapid');
  if (!raw) return new Response('VAPID keys not initialised — call /api/vapid first', { status: 500 });
  const keys = JSON.parse(raw);

  const contact = env.VAPID_CONTACT || 'mailto:admin@grocery-tracker.app';
  webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);
  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      title: 'Grocery Tracker',
      body: 'Push notifications are working 🎉'
    }));
  } catch (e) {
    return new Response('Push failed: ' + (e && e.statusCode ? e.statusCode : e), { status: 502 });
  }
  return Response.json({ ok: true });
}
