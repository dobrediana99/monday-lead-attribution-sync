# monday-lead-attribution-sync

Aplicație **serverless** pentru **Netlify** (Node.js, fără TypeScript) care ascultă webhook-uri de la **monday.com**. Când un rând din boardul **„Comenzi / Curse”** are coloana **„Status Transport”** setată exact la **„Finalizat / Livrat”**, funcția caută un lead în **„Solicitari”** apoi în **„Solicitari 2”** și, dacă găsește un lead valid, actualizează comanda conform boardului de proveniență al lead‑ului.

Integrarea se face prin **Netlify Functions** și **monday GraphQL API** (`fetch`).

---

## Ce face aplicația (comportament real)

### Lead din **„Solicitari”** (board `1905911565`)

- Setează **„Sursa Client”** la eticheta **„Website”**.
- Completează relația **„link to Solicitari”** (`board_relation_mm21tkwr`) cu ID‑ul lead‑ului. Această coloană acceptă **doar** iteme din boardul **„Solicitari”**.

### Lead din **„Solicitari 2”** (board `5092436128`)

- Setează **„Sursa Client”** la **„Website”**.
- **Nu** scrie în **„link to Solicitari”** (relația nu acceptă iteme din acest board).
- După un **update reușit**, trimite **notificare** persoanei din coloana **„Principal”** (`deal_owner`), prin API (vezi mai jos). Dacă **Principal** lipsește, se creează un **singur** `create_update` pe item cu mesajul explicativ (fără mențiune), pentru audit.

### Notificarea către **Principal**

- **Nu** se configurează printr-o automatizare monday separată pentru notificare: aplicația apelează API‑ul monday.
- **Preferat:** `create_notification` (notificare în clopoțel), cu `target_id` = itemul comenzii.
- **Fallback:** dacă `create_notification` eșuează, se folosește **`create_update`** cu **`mentions_list`** către userul din **Principal** (când există).

Notificarea / fallback‑ul cu mențiune rulează **doar după** `change_multiple_column_values` reușit și **doar dacă** tocmai s-a făcut o schimbare necesară (vezi idempotency).

### Idempotency (fără update / fără notificare la rerulare)

Dacă itemul este **deja** în starea dorită:

- **„Sursa Client”** este deja **„Website”**, și
- pentru lead din **„Solicitari”**: relația **„link to Solicitari”** conține deja ID‑ul lead‑ului găsit,

atunci funcția **nu** apelează `change_multiple_column_values`, **nu** trimite notificare și răspunde cu `skipped: "no changes needed"`.

---

## Structura proiectului

| Fișier / folder | Rol |
|-----------------|-----|
| `netlify/functions/monday-webhook.js` | Funcția serverless: challenge, webhook, matching, update, notificare |
| `netlify.toml` | Director functions + bundler |
| `package.json` | Metadate minimale; Node **≥ 18** (fetch nativ) |
| `.env.example` | Exemplu variabile de mediu |

Nu există UI, bază de date sau framework web.

---

## Variabile de mediu

| Variabilă | Descriere |
|-----------|-----------|
| `MONDAY_API_TOKEN` | Token API monday cu **citire** pe boardurile implicate și **scriere** pe **„Comenzi / Curse”**; pentru notificări: permisiuni pentru `create_notification` și `create_update` (după caz). |

Pe Netlify: **Site settings → Environment variables** → `MONDAY_API_TOKEN`.

---

## `netlify.toml`

```toml
[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
```

Directorul funcțiilor este setat **explicit** sub `[functions]` (conform cerinței proiectului).

---

## Deploy pe Netlify

1. Import repo în Netlify, adaugă **`MONDAY_API_TOKEN`**.
2. URL funcție după deploy:

   `https://<subdomeniul-tău>.netlify.app/.netlify/functions/monday-webhook`

3. **Challenge** monday:

   ```bash
   curl -X POST "https://<subdomeniul-tău>.netlify.app/.netlify/functions/monday-webhook" ^
     -H "Content-Type: application/json" ^
     -d "{\"challenge\":\"test123\"}"
   ```

   Răspuns: `{"challenge":"test123"}`.

---

## Cum configurezi monday

### Automatizare webhook (suficient pentru trigger)

Creează o automatizare care rulează când **„Status Transport”** devine **„Finalizat / Livrat”** și trimite **webhook POST** la URL‑ul funcției Netlify de mai sus.

**Notificarea către Principal nu se face din această automatizare** — o face aplicația prin API, după update, conform secțiunii de mai sus.

### Challenge

monday poate trimite `{ "challenge": "..." }`; funcția răspunde cu același JSON.

---

## Boarduri și coloane (referință)

### „Comenzi / Curse” — `2030349838`

| Coloană | ID |
|--------|-----|
| Status Transport | `color_mkse52dk` → **„Finalizat / Livrat”** |
| Email Semnare Client | `email_mkse8jyb` |
| GCLID | `text_mm21cvwz` |
| Sursa Client | `color_mktcvtpz` → **„Website”** |
| link to Solicitari | `board_relation_mm21tkwr` (doar board **1905911565**) |
| Principal | `deal_owner` (people, max 1) |

### „Solicitari” — `1905911565`

| Coloană | ID |
|--------|-----|
| Email Client | `email_mkvmar5w` |
| GCLID | `text_mm1h3m1v` |

### „Solicitari 2” — `5092436128`

| Coloană | ID |
|--------|-----|
| Email Client | `email_mm0zexk0` |
| GCLID | `text_mm2egv20` |

---

## Reguli de matching (ambele boarduri de lead)

1. **Email**: egal după **trim** și **lowercase**.
2. **GCLID pe lead**: trebuie să existe și să nu fie gol (după trim).
3. Dacă **comanda** are GCLID: **egalitate strictă** cu GCLID lead.
4. Dacă **comanda** nu are GCLID: se acceptă lead **doar dacă** GCLID pe lead este completat.
5. **Ordinea**: întâi **„Solicitari”**, apoi **„Solicitari 2”**.
6. Dacă există **mai multe** leaduri care trec filtrele: se folosește **primul** din lista returnată de căutarea pe email (comportament documentat în cod prin log).

---

## Exemple de răspuns JSON

| Situație | Exemplu |
|----------|---------|
| Nimic de schimbat (idempotent) | `{ "ok": true, "skipped": "no changes needed", "matchedIn": "Solicitari", ... }` |
| Status nu e livrat | `{ "ok": true, "skipped": "status not delivered" }` |
| Fără lead | `{ "ok": true, "skipped": "no matching lead", "orderId": "..." }` |
| Update făcut | `{ "ok": true, "matchedIn": "Solicitari", "leadId": "...", "orderId": "...", "updated": true, "changes": { "source": true, "relation": false } }` |
| Eroare | `{ "ok": false, "error": "..." }` |

---

## Limitări

- **Parsare relație** (`board_relation_*`): se încearcă mai multe forme JSON (`linkedPulseIds`, `item_ids`). Dacă monday returnează alt format, idempotency pe relație poate necesita ajustare.
- **Căutare email**: `items_page_by_column_values` folosește potrivirea monday pe coloana de email; normalizarea la lowercase presupune date consistente în monday.
- **Paginare**: limită de siguranță la numărul de pagini în căutarea după email.

---

## Dezvoltare locală (opțional)

```bash
npm i -g netlify-cli
netlify dev
```

---

## Licență

MIT (conform `package.json`).
