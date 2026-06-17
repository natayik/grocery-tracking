function b64u(data) {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromb64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function cat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.byteLength, 0));
  let i = 0;
  for (const a of arrs) {
    const ua = ArrayBuffer.isView(a)
      ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
      : new Uint8Array(a);
    out.set(ua, i);
    i += ua.byteLength;
  }
  return out;
}

async function hkdf(salt, ikm, info, len) {
  const saltK = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltK, ikm));
  const prkK = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const t = new Uint8Array(await crypto.subtle.sign('HMAC', prkK, cat(info, new Uint8Array([1]))));
  return t.slice(0, len);
}

async function vapidAuthHeader(endpoint, publicKey, privateKeyJwk, contact) {
  const origin = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 43200;
  const enc = new TextEncoder();
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(enc.encode(JSON.stringify({ aud: origin, exp, sub: contact })));
  const signing = `${h}.${p}`;
  const key = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signing)));
  return `vapid t=${signing}.${b64u(sig)},k=${publicKey}`;
}

async function encryptPush(subscription, payloadStr) {
  const enc = new TextEncoder();
  const clientPub = await crypto.subtle.importKey('raw', fromb64u(subscription.keys.p256dh), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const authSecret = fromb64u(subscription.keys.auth);
  const clientPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', clientPub));
  const serverKP = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPub = new Uint8Array(await crypto.subtle.exportKey('raw', serverKP.publicKey));
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPub }, serverKP.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdf(authSecret, ikm, cat(enc.encode('WebPush: info\x00'), clientPubRaw, serverPub), 32);
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\x00'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    cat(enc.encode(payloadStr), new Uint8Array([2]))
  ));
  const header = new Uint8Array(21 + serverPub.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPub.byteLength;
  header.set(serverPub, 21);
  return cat(header, ciphertext);
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let reqBody;
  try { reqBody = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const subscription = reqBody && reqBody.subscription;
  if (!subscription) return new Response('Missing subscription', { status: 400 });

  const kv = env.GROCERY_KV;
  const raw = await kv.get('vapid');
  if (!raw) return new Response('VAPID keys not initialised — call /api/vapid first', { status: 500 });
  const keys = JSON.parse(raw);
  if (!keys.privateKeyJwk) return new Response('VAPID keys need refresh — visit /api/vapid', { status: 500 });

  const contact = env.VAPID_CONTACT || 'mailto:admin@grocery-tracker.app';
  try {
    const authorization = await vapidAuthHeader(subscription.endpoint, keys.publicKey, keys.privateKeyJwk, contact);
    const pushBody = await encryptPush(subscription, JSON.stringify({
      title: 'Grocery Tracker',
      body: 'Push notifications are working!',
    }));
    const pushResp = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
      },
      body: pushBody,
    });
    if (!pushResp.ok) return new Response(`Push service returned ${pushResp.status}`, { status: 502 });
  } catch (e) {
    return new Response('Push failed: ' + e, { status: 502 });
  }
  return Response.json({ ok: true });
}
