import webpush from 'web-push';

export async function onRequest({ env }) {
  const kv = env.GROCERY_KV;
  let raw = await kv.get('vapid');
  let keys;
  if (!raw) {
    keys = webpush.generateVAPIDKeys();
    await kv.put('vapid', JSON.stringify(keys));
  } else {
    keys = JSON.parse(raw);
  }
  return Response.json({ publicKey: keys.publicKey });
}
