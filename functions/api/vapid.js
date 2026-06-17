function b64u(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateVAPIDKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return {
    publicKey: b64u(publicKeyRaw),
    privateKey: privateKeyJwk.d,  // raw b64url scalar — keeps deal-checker.js (web-push) working
    privateKeyJwk,
  };
}

export async function onRequest({ env }) {
  const kv = env.GROCERY_KV;
  let raw = await kv.get('vapid');
  let keys;
  if (!raw) {
    keys = await generateVAPIDKeys();
    await kv.put('vapid', JSON.stringify(keys));
  } else {
    keys = JSON.parse(raw);
    if (!keys.privateKeyJwk) {
      keys = await generateVAPIDKeys();
      await kv.put('vapid', JSON.stringify(keys));
    }
  }
  return Response.json({ publicKey: keys.publicKey });
}
