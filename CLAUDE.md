# Grocery Tracker — Claude context

## What this is
A mobile-first PWA for tracking Costco and T&T grocery purchases, price guarantees, and deal alerts.
Single self-contained file: `index.html`. No build step. Deploy = push to GitHub → Netlify auto-deploys.

## Files
- `index.html` — the entire app (HTML + CSS + JS, ~1750 lines)
- `sw.js` — service worker for push notifications
- `card-playground.html` — scratch file for Yi to experiment with card designs

## How to deploy
```
deploy   # terminal alias → git add index.html && commit && push
```
Netlify picks it up within ~60 seconds.

## How to preview locally
```
preview  # terminal alias → opens index.html in browser
```
No server needed. Refresh after any change.

---

## App structure (index.html)

### Sections in order
1. **CSS** (lines ~12–296) — all styles inline in `<style>`
2. **HTML shell** (lines ~298–540) — header, tabs, main view, all sheet/modal panels
3. **JavaScript** (lines ~542–1753) — all logic inline in `<script>`

### Two tabs
- **Watchlist** — items to buy when on sale. Grouped by category.
- **Purchases** — items bought, tracking the 30-day Costco price guarantee window. Grouped: On sale now → Within 30 days → Expired.

### Item data model
Each item in `state.items[]` (saved to localStorage):
```
kind: 'purchase' | 'watch'
store: 'Costco' | 'TNT'
name, size, code (Costco item #)
price, qty, discount, unitPrice, unit ('each'|'100g'|'kg'|'lb'|'L'|'g')
date (purchase date, ISO string) — purchase only
category (auto-assigned by Gemini or keyword)
deal: { price, original, validTo, flyerName, image } — set when a flyer match found
priceHistory: [{price, date}]
notes, link — watchlist only
```

### Stores
```js
STORES = {
  Costco: { label:'Costco', color:'#e31837', flipp:'Costco' },
  TNT:    { label:'T&T',    color:'#00833e', flipp:'T&T Supermarket' },
}
```
To add a store: add an entry here — chips, toggles, and filters all pick it up automatically.

### Categories
`['Produce','Meat & Seafood','Dairy & Eggs','Bakery','Pantry','Frozen','Snacks','Beverages','Household','Personal Care','Other']`

---

## Key CSS classes (plain English)

| Class | What it is |
|---|---|
| `header` | Green sticky top bar with app title and icon buttons |
| `.tabs` | Two-tab bar (Watchlist / Purchases) |
| `main#view` | Main scrollable content area |
| `.card` | A single item card in the list |
| `.card-row` | Flex row inside card: thumbnail left, content right |
| `.card-main` | Right side of card (flex:1, min-width:0, overflow:hidden) |
| `.card-top` | Item name + price row at top of card |
| `.card-head` | Store chip + item name (left side of card-top) |
| `.price-col` | Price display (right side of card-top, nowrap) |
| `.sale-zone` | Green highlighted section wrapping on-sale items |
| `.sheet` | Bottom sheet modal (slides up) |
| `.sheet.page` | Full-screen form (add/edit item, settings, receipt review) |
| `.page-head` | Sticky header inside a full-screen form |
| `.page-body` | Scrollable body inside a full-screen form |
| `.page-foot` | Sticky footer with Save/Delete buttons |
| `.two` | Two-column flex layout for paired form fields |
| `.seg` | Segmented control (store or type selector) |
| `.fab` | Green + button fixed at bottom right |
| `.filter-bar` | Store filter chips below the tabs |
| `.days-pill` | "X days left" pill on purchase cards (red if ≤3 days) |
| `.hist-row` | Price history row inside item edit form |
| `.rev-row` | One item row in the receipt review sheet |

---

## Key JS functions

| Function | What it does |
|---|---|
| `render()` | Re-renders the full tab view |
| `card(i)` | Returns HTML string for one item card |
| `openSheet()` | Opens the add/edit form |
| `editItem(id)` | Opens the edit form for a specific item |
| `saveItem()` | Saves form to state, re-renders |
| `setKind(k)` | Switches form between 'purchase' and 'watch' mode |
| `setStore(k)` | Switches active store in form |
| `checkDeals(manual)` | Fetches Flipp flyer data and matches to watchlist items |
| `renderReview()` | Renders the receipt review sheet after scanning |
| `commitReview()` | Saves all checked receipt items as purchases |
| `openSettings()` | Opens settings sheet |
| `saveSettings()` | Saves API key, postal code, etc. |

---

## Backend (Netlify Functions)
- `/.netlify/functions/sync` — cloud sync (last-write-wins, no login, sync-code model)
- `/.netlify/functions/vapid` — returns VAPID public key for push notifications
- `/.netlify/functions/test-push` — sends a test push notification

## External APIs
- **Gemini** — receipt scanning, label scanning, item categorization (user provides their own API key in Settings)
- **Flipp** — flyer deal matching (no key needed, uses postal code)

---

## What Yi doesn't know / doesn't need to touch
Yi is a UX designer, not a developer. She does not write or read code.
- Never ask her to edit files directly
- Never ask her to run anything other than `deploy` or `preview`
- Describe changes in terms of what she'll see, not how the code works

---

## Fixes & changes log
| Date | Change |
|---|---|
| 2026-06-16 | Fixed horizontal scroll on purchase form page — added `overflow-x:hidden` to `.page-body` |
| 2026-06-16 | Updated both Gemini prompts (BATCH_PROMPT, ITEM_PROMPT) to always return Traditional Chinese (繁體中文), never Simplified |

## Planned / discussed future iterations
_(update this section as things are decided)_
- Nothing queued yet
