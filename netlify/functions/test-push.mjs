import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

// Sends a single test notification to the subscription the client just created.
// No storage of the subscription — this only proves the push pipe works end-to-end.
export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const subscription = body && body.subscription;
  if (!subscription) return new Response('Missing subscription', { status: 400 });

  const store = getStore('grocery');
  const keys = await store.get('vapid', { type: 'json' });
  if (!keys) return new Response('VAPID keys not initialised — call /vapid first', { status: 500 });

  webpush.setVapidDetails('mailto:notifications@grocery-tracker.app', keys.publicKey, keys.privateKey);
  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      title: 'Grocery Tracker',
      body: 'Push notifications are working 🎉'
    }));
  } catch (e) {
    return new Response('Push failed: ' + (e && e.statusCode ? e.statusCode : e), { status: 502 });
  }
  return Response.json({ ok: true });
};
