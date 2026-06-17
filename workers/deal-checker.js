// Cron Worker — runs daily, checks Flipp for deals on every subscribed user's list,
// and sends a push notification if anything is on sale.
import webpush from 'web-push';

const STORES = {
  Costco: { flipp: 'Costco' },
  TNT:    { flipp: 'T&T Supermarket' },
};

const STOPWORDS = new Set([
  'whole','signature','kirkland','organic','fresh','natural','original','value',
  'pack','count','large','small','family','select','classic','premium','brand',
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
  const queries = [...new Set([toks.slice(0, 2).join(' '), toks[0], sortKey(item.name) || item.name].filter(Boolean))];
  const rejected = new Set((item.rejectedFlyers || []).map(s => (s || '').toLowerCase()));
  let cands = [];
  for (const q of queries) {
    let results;
    try { results = await flippSearch(q, postal); } catch { continue; }
    cands = results.filter(r =>
      (!merch || r.merchant_name === merch) && r.current_price > 0 &&
      (!r.valid_to || new Date(r.valid_to).getTime() > now) &&
      !rejected.has((r.name || '').toLowerCase())
    );
    if (cands.length) break;
  }
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
      } else if (itemSize && flyerSize) {
        r._score -= 0.4;
      }
    }
  });
  cands.sort((a, b) => b._score - a._score);
  const isCostco = item.store === 'Costco';
  if (item.code) {
    for (const r of cands.slice(0, 3)) {
      try {
        const det = await flippItemDetail(r.flyer_item_id || r.id, postal);
        if (det.sku && det.sku === String(item.code).trim()) return dealFrom(r, true);
      } catch {}
    }
    if (isCostco) return null;
  }
  const threshold = isCostco ? 0.8 : 0.5;
  return cands[0]._score >= threshold ? dealFrom(cands[0], false) : null;
}

async function runCheck(env, { force = false } = {}) {
  const kv = env.GROCERY_KV;
  const vapidRaw = await kv.get('vapid');
  if (!vapidRaw) return { error: 'No VAPID keys in KV — visit /api/vapid first' };
  const keys = JSON.parse(vapidRaw);

  const contact = env.VAPID_CONTACT || 'mailto:admin@grocery-tracker.app';
  webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);

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

    const { subscription, postal, lastNotifiedAt } = subRecord;
    if (!subscription || !postal) { results.push({ syncCode, skipped: 'no subscription or postal' }); continue; }

    if (!force && lastNotifiedAt && Date.now() - lastNotifiedAt < 22 * 3600 * 1000) {
      results.push({ syncCode, skipped: 'notified recently', lastNotifiedAt });
      continue;
    }

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

    const body = deals.length === 1
      ? `${deals[0].item.name} is on sale for $${deals[0].deal.price.toFixed(2)}`
      : `${deals.length} items on your list are on sale now`;

    let notified = false;
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: 'Grocery Tracker — Deal Alert',
        body,
        tag: 'deal-alert',
      }));
      subRecord.lastNotifiedAt = Date.now();
      await kv.put(name, JSON.stringify(subRecord));
      notified = true;
    } catch (e) {
      if (e.statusCode === 410) await kv.delete(name);
    }
    results.push({ syncCode, postal, checked, notified, message: body });
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
