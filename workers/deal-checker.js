// Cron Worker — runs daily, checks Flipp for deals on every subscribed user's list,
// and sends a push notification if anything is on sale.

function b64u(data) {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromb64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function cat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.byteLength, 0)); let i = 0;
  for (const a of arrs) { const ua = ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a); out.set(ua, i); i += ua.byteLength; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const sK = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', sK, ikm));
  const pK = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return (new Uint8Array(await crypto.subtle.sign('HMAC', pK, cat(info, new Uint8Array([1]))))).slice(0, len);
}
async function vapidAuthHeader(endpoint, publicKey, privateKeyJwk, contact) {
  const enc = new TextEncoder(), origin = new URL(endpoint).origin, exp = Math.floor(Date.now() / 1000) + 43200;
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
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, cat(enc.encode(payloadStr), new Uint8Array([2]))));
  const header = new Uint8Array(21 + serverPub.byteLength);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096, false); header[20] = serverPub.byteLength; header.set(serverPub, 21);
  return cat(header, ciphertext);
}
async function sendPush(subscription, payloadStr, keys, contact) {
  if (!keys.privateKeyJwk) throw Object.assign(new Error('VAPID keys need refresh — visit /api/vapid'), { statusCode: 500 });
  const authorization = await vapidAuthHeader(subscription.endpoint, keys.publicKey, keys.privateKeyJwk, contact);
  const body = await encryptPush(subscription, payloadStr);
  const resp = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: { 'Authorization': authorization, 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'TTL': '86400' },
    body,
  });
  if (!resp.ok) throw Object.assign(new Error(`Push service ${resp.status}`), { statusCode: resp.status });
}

const STORES = {
  Costco: { flipp: 'Costco' },
  TNT:    { flipp: 'T&T Supermarket' },
};

function titleCase(s) {
  const units = /^(\d*)(g|kg|ml|l|pk|oz|lb|ct|pack|lbs)$/i;
  const unitCase = { l:'L', ml:'ml', g:'g', kg:'kg', oz:'oz', lb:'lb', lbs:'lbs', ct:'ct', pk:'pk', pack:'pack' };
  return (s || '').replace(/[A-Za-z0-9][A-Za-z0-9'\u2018\u2019]*/g, w => {
    const m = w.match(units);
    if (m) return (m[1] || '') + (unitCase[m[2].toLowerCase()] || m[2].toLowerCase());
    if (/^[A-Z][A-Z0-9]*$/.test(w) && w.length <= 3) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

function buildBody(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  const shown = [names[0]];
  for (let i = 1; i < names.length; i++) {
    const candidate = [...shown, names[i]].join(', ');
    const full = i < names.length - 1 ? candidate + ' and more' : candidate;
    if (full.length <= 120) shown.push(names[i]);
    else break;
  }
  return shown.length < names.length ? shown.join(', ') + ' and more' : shown.join(', ');
}

const STOPWORDS = new Set([
  'whole','signature','kirkland','fresh','natural','original','value',
  'pack','count','large','small','family','select','classic','brand',
  'with','and','the','plus','free','low','new',
]);

function qTokens(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length >= 3);
}
function contentTokens(s) { return qTokens(s).filter(w => !STOPWORDS.has(w)); }
function sortKey(name) {
  name = name || '';
  const latin = name.match(/[A-Za-z].*/);
  return (latin ? latin[0] : name).toLowerCase().trim();
}
function nameScore(itemName, flyerName) {
  const a = contentTokens(itemName); if (!a.length) return 0;
  const b = contentTokens(flyerName); if (!b.length) return 0;
  const bSet = new Set(b);
  const overlapTokens = a.filter(w => bSet.has(w));
  const overlap = overlapTokens.length;
  const score = overlap / Math.min(a.length, b.length);
  if (score < 0.75) {
    const overlapSet = new Set(overlapTokens);
    const aExtra = a.filter(w => !overlapSet.has(w));
    const bExtra = b.filter(w => !overlapSet.has(w));
    if (aExtra.length >= 2 && bExtra.length >= 2) {
      const aExtraSet = new Set(aExtra);
      if (!bExtra.some(w => aExtraSet.has(w))) return 0;
    }
  }
  return score;
}
function parseSize(s) {
  const m = (s || '').replace(/\s/g, '').match(/^([\d.]+)(ml|l|g|kg|lb|oz)$/i);
  if (!m) return null;
  let v = parseFloat(m[1]), u = m[2].toLowerCase();
  if (u === 'l')  { v *= 1000; u = 'ml'; }
  if (u === 'kg') { v *= 1000; u = 'g'; }
  if (u === 'lb') { v = Math.round(v * 453.6); u = 'g'; }
  if (u === 'oz') { v = Math.round(v * 28.35); u = 'g'; }
  return { value: v, unit: u };
}
function daysLeft(dateISO) {
  const purchased = new Date(dateISO + 'T00:00:00');
  const expiry = new Date(purchased); expiry.setDate(expiry.getDate() + 30);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
}
function qualifies(item, deal) {
  if (!deal) return false;
  if (item.kind === 'purchase') return daysLeft(item.date) >= 0 && deal.price < (item.price || Infinity);
  return true;
}
function dealFrom(r, exact) {
  return { flyerName: r.name, price: r.current_price, original: r.original_price || null, validTo: r.valid_to || '', exact: !!exact };
}
async function flippSearch(term, postal) {
  const url = 'https://backflipp.wishabi.com/flipp/items/search?locale=en-ca&postal_code=' +
    encodeURIComponent(postal) + '&q=' + encodeURIComponent(term);
  const res = await fetch(url);
  if (!res.ok) throw new Error('flipp ' + res.status);
  return (await res.json()).items || [];
}
async function flippItemDetail(id, postal) {
  const url = 'https://backflipp.wishabi.com/flipp/items/' + id + '?locale=en-ca&postal_code=' + encodeURIComponent(postal);
  const res = await fetch(url);
  if (!res.ok) throw new Error('detail ' + res.status);
  const it = (await res.json()).item || {};
  return { sku: (it.sku || '').toString().trim() };
}
async function findDeal(item, postal) {
  const merch = STORES[item.store] && STORES[item.store].flipp;
  const now = Date.now();
  const ctoks = contentTokens(item.name);
  const toks = ctoks.length ? ctoks : qTokens(item.name);
  const q = toks.slice(0, 2).join(' ') || toks[0];
  if (!q) return null;
  const rejected = new Set((item.rejectedFlyers || []).map(s => (s || '').toLowerCase()));
  let results;
  try { results = await flippSearch(q, postal); } catch { return null; }
  const cands = results.filter(r =>
    (!merch || r.merchant_name === merch) && r.current_price > 0 &&
    (!r.valid_to || new Date(r.valid_to).getTime() > now) &&
    !rejected.has((r.name || '').toLowerCase())
  );
  if (!cands.length) return null;
  const itemSize = parseSize(item.size);
  cands.forEach(r => {
    r._score = nameScore(item.name, r.name);
    const flyerSizeMatch = (r.name || '').replace(/\s/g, '').match(/([\d.]+(?:ml|l|g|kg|lb|oz))/i);
    if (flyerSizeMatch) {
      const flyerSize = parseSize(flyerSizeMatch[0]);
      if (itemSize && flyerSize && itemSize.unit === flyerSize.unit) {
        const ratio = itemSize.value / flyerSize.value;
        if (ratio >= 0.85 && ratio <= 1.18) r._score += 0.15;
        else r._score -= 0.4;
      } else if (itemSize && flyerSize) { r._score -= 0.4; }
    }
  });
  cands.sort((a, b) => b._score - a._score);
  const threshold = item.store === 'Costco' ? 0.8 : 0.5;
  return cands[0]._score >= threshold ? dealFrom(cands[0], false) : null;
}

async function runCheck(env, { force = false } = {}) {
  const kv = env.GROCERY_KV;
  const vapidRaw = await kv.get('vapid');
  if (!vapidRaw) return { error: 'No VAPID keys in KV — visit /api/vapid first' };
  const keys = JSON.parse(vapidRaw);

  const contact = env.VAPID_CONTACT || 'mailto:admin@grocery-tracker.app';

  const list = await kv.list({ prefix: 'sub/' });
  const results = [];

  for (const { name } of list.keys) {
    const syncCode = name.slice(4);
    const [subRaw, syncRaw] = await Promise.all([
      kv.get(name),
      kv.get('sync/' + syncCode),
    ]);
    if (!subRaw || !syncRaw) { results.push({ syncCode, skipped: 'missing sub or sync data' }); continue; }

    let subRecord, syncData;
    try { subRecord = JSON.parse(subRaw); } catch { continue; }
    try { syncData = JSON.parse(syncRaw); } catch { continue; }

    const { subscription, postal } = subRecord;
    if (!subscription || !postal) { results.push({ syncCode, skipped: 'no subscription or postal' }); continue; }

    const items = (syncData.items || []).filter(i => i.kind === 'watch' && STORES[i.store] && STORES[i.store].flipp);
    if (!items.length) { results.push({ syncCode, skipped: 'no watchlist items' }); continue; }

    const checked = [];
    const deals = [];
    for (const item of items) {
      try {
        const deal = await findDeal(item, postal);
        const matched = qualifies(item, deal);
        checked.push({ name: item.name, deal: deal ? { price: deal.price, name: deal.name } : null, matched });
        if (matched) deals.push({ item, deal });
      } catch (e) {
        checked.push({ name: item.name, error: String(e) });
      }
    }

    if (!deals.length) { results.push({ syncCode, postal, checked, notified: false }); continue; }

    const lastNotifiedItems = subRecord.lastNotifiedItems || {};
    const newDeals = deals.filter(({ item, deal }) =>
      lastNotifiedItems[titleCase(item.name)] !== (deal.validTo || '')
    );
    if (!force && !newDeals.length) { results.push({ syncCode, postal, checked, notified: false, skipped: 'no new deals' }); continue; }

    const names = deals.map(d => titleCase(d.item.name));
    const title = titleCase(`${deals.length} item${deals.length === 1 ? '' : 's'} on sale now!`);
    const body = buildBody(names);

    let notified = false, pushError = null;
    try {
      await sendPush(subscription, JSON.stringify({
        title,
        body,
        tag: 'deal-alert',
      }), keys, contact);
      subRecord.lastNotifiedItems = Object.fromEntries(deals.map(({ item, deal }) => [titleCase(item.name), deal.validTo || '']));
      delete subRecord.lastNotifiedAt;
      await kv.put(name, JSON.stringify(subRecord));
      notified = true;
    } catch (e) {
      pushError = { statusCode: e.statusCode, message: e.message, body: e.body };
      if (e.statusCode === 410) await kv.delete(name);
    }
    results.push({ syncCode, postal, checked, notified, message: body, pushError });
  }

  return { checked: results.length, results };
}

export default {
  async scheduled(event, env, ctx) {
    await runCheck(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') return new Response('Not found', { status: 404 });
    const force = url.searchParams.get('force') === 'true';
    const result = await runCheck(env, { force });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  },
};
