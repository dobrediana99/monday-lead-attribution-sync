# monday-lead-attribution-sync

Aplicație **serverless** pentru **Netlify** (Node.js, fără TypeScript) care ascultă webhook-uri de la **monday.com**. Când un rând din boardul **„Comenzi / Curse”** are coloana **„Status Transport”** setată exact la **„Finalizat / Livrat”**, funcția caută un lead corespunzător în **„Solicitari”** sau **„Solicitari 2”** (după regulile de mai jos) și, dacă îl găsește, actualizează comanda:

1. **„Sursa Client”** → eticheta **„Website”**  
2. **„link to Solicitari”** → relație către itemul lead găsit  

Integrarea se face prin **Netlify Functions** și **monday GraphQL API** (`fetch`).

---

## Structura proiectului

| Fișier / folder | Rol |
|-----------------|-----|
| `netlify/functions/monday-webhook.js` | Funcția serverless: verificare challenge, webhook, logică matching + update |
| `netlify.toml` | Configurare Netlify (director functions) |
| `package.json` | Metadate minimale; Node **≥ 18** (fetch nativ) |
| `.env.example` | Exemplu variabile de mediu |

Nu există UI, bază de date sau framework web.

---

## Variabile de mediu

| Variabilă | Descriere |
|-----------|-----------|
| `MONDAY_API_TOKEN` | Token API monday cu drepturi de **citire** pe boardurile implicate și **scriere** pe **„Comenzi / Curse”** (items + coloanele menționate). |

Copiază `.env.example` în `.env` pentru teste locale cu Netlify CLI (opțional).

Pe Netlify: **Site settings → Environment variables** → adaugă `MONDAY_API_TOKEN`.

---

## Deploy pe Netlify

1. **Creează un repo Git** cu acest conținut (sau încarcă folderul în GitHub/GitLab/Bitbucket).

2. În [Netlify](https://www.netlify.com/): **Add new site → Import an existing project** și conectează repo-ul.

3. Setări build (în general Netlify detectează singur):
   - Nu este obligatoriu un build step dacă nu folosești dependențe npm.
   - Directorul functions este definit în `netlify.toml` (`functions = "netlify/functions"`).

4. Adaugă variabila **`MONDAY_API_TOKEN`** în **Site settings → Environment variables** (aceeași valoare ca tokenul monday folosit la API).

5. Deploy. După publicare, URL-ul funcției va fi:

   `https://<subdomeniul-tău>.netlify.app/.netlify/functions/monday-webhook`

   Exemplu: dacă site-ul este `https://hero-site.netlify.app`, endpointul complet este:

   `https://hero-site.netlify.app/.netlify/functions/monday-webhook`

6. **Test rapid challenge** (monday trimite asta la configurarea webhook-ului):

   ```bash
   curl -X POST "https://<subdomeniul-tău>.netlify.app/.netlify/functions/monday-webhook" ^
     -H "Content-Type: application/json" ^
     -d "{\"challenge\":\"test123\"}"
   ```

   Răspuns așteptat: `{"challenge":"test123"}`.

---

## Cum configurezi monday

### 1. Automatizare la schimbarea statusului

În monday, creează o **automatizare / integrare** care rulează când:

- coloana **„Status Transport”** devine **„Finalizat / Livrat”**  
  (sau echivalent: „când se schimbă la această valoare”).

Acțiunea trebuie să fie **„Send webhook”** / **„Trimite webhook”** (denumirea exactă poate varia după limbă și plan).

### 2. URL webhook

Setează URL-ul la:

`https://<subdomeniul-tău>.netlify.app/.netlify/functions/monday-webhook`

Metoda: **POST**, tip conținut: **JSON** (dacă monday cere aceste opțiuni).

### 3. Verificarea (challenge)

La prima salvare, monday trimite un payload de verificare de forma:

```json
{ "challenge": "..." }
```

Aplicația răspunde cu **același** câmp `challenge` în JSON. Fără acest pas, monday poate refuza webhook-ul.

### 4. Scopuri API (recomandat)

Tokenul API trebuie să poată:

- citi itemi și valori de coloană pe boardurile **Comenzi / Curse**, **Solicitari**, **Solicitari 2**;
- rula interogări precum `items_page_by_column_values` / `next_items_page`;
- executa mutația `change_multiple_column_values` pe boardul **Comenzi / Curse**.

Dacă apare **403** sau erori de permisiuni, verifică rolul utilizatorului asociat tokenului și scope-urile aplicației API.

---

## Comportament și reguli de matching

1. **Challenge** → răspuns `{ "challenge": "<valoare>" }`.

2. **Webhook real** → se încearcă extragerea **ID-ului itemului** din payload (mai multe căi posibile: `itemId`, `pulseId`, `event.*`, etc.).

3. Se citește itemul prin API (`items`) și se verifică că este pe boardul **Comenzi / Curse** (`2030349838`).

4. Se citește **„Status Transport”** din datele API (nu doar din payload). Dacă eticheta nu este **exact** `Finalizat / Livrat`, răspuns de tip skip.

5. Se citesc **email** (coloana „Email Semnare Client”) și **GCLID** (coloana „GCLID”) ale comenzii. Emailul este normalizat: **trim + lowercase**.

6. **Board „Solicitari”** (căutare după email prin API, apoi filtrare în cod):
   - email comandă = email solicitare (după normalizare);
   - pe solicitare, **GCLID trebuie să existe și să nu fie gol**;
   - dacă comanda are GCLID nevid: trebuie **egalitate strictă** GCLID comandă ↔ GCLID solicitare;
   - dacă comanda **nu** are GCLID: se acceptă solicitarea **doar dacă** GCLID-ul solicitării este completat (nevid).

7. **Board „Solicitari 2”** (dacă nu s-a găsit nimic în „Solicitari”):
   - **momentan matching doar pe email** — în schema primită **nu există coloană GCLID** pe acest board;
   - în cod există constanta `COL_GCLID_SOLICITARI_2 = null` și comentarii: când adaugi ID-ul coloanei GCLID în monday, setezi constanta și poți replica regulile de la „Solicitari”.

8. Dacă există lead valid → `change_multiple_column_values`: **Sursa Client** = `{ "label": "Website" }`, **link to Solicitari** = `{ "item_ids": ["<leadId>"] }`.

9. Dacă nu există lead → **nu** se modifică comanda; răspuns JSON cu `skipped` clar.

---

## Exemple de răspuns JSON

| Situație | Exemplu |
|----------|---------|
| Status nu e livrat | `{ "ok": true, "skipped": "status not delivered" }` |
| Email lipsă pe comandă | `{ "ok": true, "skipped": "order email missing" }` |
| Fără lead | `{ "ok": true, "skipped": "no matching lead", "orderId": "..." }` |
| Succes | `{ "ok": true, "matchedIn": "Solicitari", "leadId": "...", "orderId": "...", "updated": true }` |
| Eroare API / config | `{ "ok": false, "error": "..." }` |

Logurile în Netlify (**Functions → Logs**) includ mesaje precum: verificare challenge, status nepotrivit, lead găsit în Solicitari / Solicitari 2, lipsă lead, update reușit, erori monday.

---

## Limitări

- **„Solicitari 2”**: fără coloană GCLID în schemă, pot exista **mai multe solicitări cu același email**; funcția folosește **primul** item care trece filtrele și loghează dacă sunt mai multe potriviri. După introducerea GCLID, completează `COL_GCLID_SOLICITARI_2` și logica din `isSolicitari2Match`.
- **Căutare după email în monday**: `items_page_by_column_values` face potrivire **exactă** pe valoarea din coloana de email; normalizarea la lowercase presupune că datele din monday sunt aliniate (ex. emailuri stocate în formă comparabilă).
- **Volum mare de itemi**: paginarea este limitată la un număr maxim de pagini pentru a evita bucle infinite; la boarduri foarte mari, poate fi nevoie de ajustare.
- **Forma payload-ului webhook**: se încearcă mai multe chei uzuale; dacă monday trimite un format nou, poate fi nevoie să extinzi `extractItemIdFromPayload`.

---

## Dezvoltare locală (opțional)

```bash
npm i -g netlify-cli
netlify dev
```

Funcția va fi disponibilă la un URL local afișat de CLI (de obicei tot sub `/.netlify/functions/monday-webhook`).

---

## Licență

MIT (sau conform `package.json`).
