import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

// Returns the public VAPID key the browser needs to subscribe to push.
// The keypair is generated once on first call and persisted in Netlify Blobs,
// so it stays stable (subscriptions are tied to the key used at subscribe time).
export default async () => {
  const store = getStore('grocery');
  let keys = await store.get('vapid', { type: 'json' });
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await store.setJSON('vapid', keys);
  }
  return Response.json({ publicKey: keys.publicKey });
};
