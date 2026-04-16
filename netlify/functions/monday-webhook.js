/**
 * Netlify Function: monday.com webhook → atribuire lead (Sursa Client + link relație).
 *
 * NOTE IMPORTANT:
 * - Relația `link to Solicitari` acceptă doar iteme din boardul "Solicitari" (1905911565).
 *   Dacă lead-ul e găsit în "Solicitari 2", NU scriem în coloana relațională; setăm doar
 *   "Sursa Client" și trimitem notificare + (opțional) update pe item cu explicația.
 */

const MONDAY_API_URL = "https://api.monday.com/v2";

// --- Board IDs ---
const BOARD_COMENZI = "2030349838";
const BOARD_SOLICITARI = "1905911565";
const BOARD_SOLICITARI_2 = "5092436128";

// --- Coloane: Comenzi / Curse ---
const COL_STATUS_TRANSPORT = "color_mkse52dk";
const COL_EMAIL_COMANDA = "email_mkse8jyb";
const COL_GCLID_COMANDA = "text_mm21cvwz";
const COL_SURSA_CLIENT = "color_mktcvtpz";
const COL_LINK_SOLICITARI = "board_relation_mm21tkwr";
const COL_PRINCIPAL = "deal_owner";

// --- Coloane: Solicitari ---
const COL_EMAIL_SOLICITARI = "email_mkvmar5w";
const COL_GCLID_SOLICITARI = "text_mm1h3m1v";

// --- Coloane: Solicitari 2 ---
const COL_EMAIL_SOLICITARI_2 = "email_mm0zexk0";
const COL_GCLID_SOLICITARI_2 = "text_mm2egv20";

// --- Valori business ---
const STATUS_DELIVERED_LABEL = "Finalizat / Livrat";
const SURSA_WEBSITE_LABEL = "Website";

// --- Coloane citite la getItem pentru comandă ---
const ORDER_COLUMN_IDS = [
  COL_STATUS_TRANSPORT,
  COL_EMAIL_COMANDA,
  COL_GCLID_COMANDA,
  COL_SURSA_CLIENT,
  COL_LINK_SOLICITARI,
  COL_PRINCIPAL,
];

// ---------------------------------------------------------------------------
// monday GraphQL
// ---------------------------------------------------------------------------

async function mondayRequest(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    const err = new Error("MONDAY_API_TOKEN is not set");
    err.code = "CONFIG";
    throw err;
  }

  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      // Folosim o versiune suficient de nouă pentru a avea opțiuni moderne (ex. mentions_list),
      // dar codul funcționează și fără ele (fallback).
      "API-Version": "2025-07",
    },
    body: JSON.stringify({ query, variables }),
  });

  let json;
  try {
    json = await res.json();
  } catch (e) {
    console.error("monday API error: invalid JSON body", e);
    const err = new Error("monday API returned non-JSON response");
    err.code = "MONDAY_HTTP";
    throw err;
  }

  if (!res.ok) {
    console.error("monday API error: HTTP", res.status, json);
    const err = new Error(`monday API HTTP ${res.status}`);
    err.code = "MONDAY_HTTP";
    throw err;
  }

  if (json.errors && json.errors.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    console.error("monday API error:", json.errors);
    const err = new Error(msg);
    err.code = "MONDAY_GQL";
    throw err;
  }

  return json.data;
}

// ---------------------------------------------------------------------------
// Helpers: column_values
// ---------------------------------------------------------------------------

function getColumn(item, columnId) {
  if (!item || !Array.isArray(item.column_values)) return null;
  return item.column_values.find((cv) => cv && cv.id === columnId) || null;
}

function getTextValue(item, columnId) {
  const col = getColumn(item, columnId);
  if (!col) return "";
  const rawText = typeof col.text === "string" ? col.text : "";
  if (rawText.trim()) return rawText.trim();
  if (!col.value) return "";
  try {
    const v = JSON.parse(col.value);
    if (v && typeof v.text === "string" && v.text.trim()) return v.text.trim();
    if (v && typeof v.value === "string" && v.value.trim()) return v.value.trim();
  } catch {
    // ignore
  }
  return "";
}

function getEmailValue(item, columnId) {
  const col = getColumn(item, columnId);
  if (!col) return "";
  if (col.value) {
    try {
      const v = JSON.parse(col.value);
      const email = v && typeof v.email === "string" ? v.email : "";
      if (email) return normalizeEmail(email);
    } catch {
      // fall through
    }
  }
  if (typeof col.text === "string" && col.text.trim()) {
    return normalizeEmail(col.text);
  }
  return "";
}

function normalizeEmail(value) {
  if (value == null) return "";
  return String(value).trim().toLowerCase();
}

/**
 * Citește eticheta statusului (coloane tip status / color în UI).
 */
function getStatusLabel(item, columnId) {
  const col = getColumn(item, columnId);
  if (!col) return "";
  if (typeof col.text === "string" && col.text.trim()) return col.text.trim();
  if (!col.value) return "";
  try {
    const v = JSON.parse(col.value);
    if (v && typeof v.label === "string" && v.label.trim()) return v.label.trim();
  } catch {
    // ignore
  }
  return "";
}

// ---------------------------------------------------------------------------
// Date despre itemi
// ---------------------------------------------------------------------------

async function getItem(itemId) {
  const query = `
    query ($ids: [ID!], $columnIds: [String!]) {
      items(ids: $ids) {
        id
        board {
          id
        }
        column_values(ids: $columnIds) {
          id
          type
          text
          value
        }
      }
    }
  `;
  const data = await mondayRequest(query, {
    ids: [String(itemId)],
    columnIds: ORDER_COLUMN_IDS,
  });
  const item = data.items && data.items[0];
  return item || null;
}

/**
 * Returnează toți itemii din board care au exact emailul dat (API + verificare locală).
 * Paginare: items_page_by_column_values → next_items_page.
 */
async function findItemsByEmail(boardId, emailColumnId, email, extraColumnIds) {
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) return [];

  const columnIds = [emailColumnId, ...(extraColumnIds || [])].filter(Boolean);

  const initialQuery = `
    query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!, $limit: Int!, $columnIds: [String!]) {
      items_page_by_column_values(board_id: $boardId, columns: $columns, limit: $limit) {
        cursor
        items {
          id
          column_values(ids: $columnIds) {
            id
            type
            text
            value
          }
        }
      }
    }
  `;

  const nextQuery = `
    query ($cursor: String!, $limit: Int!, $columnIds: [String!]) {
      next_items_page(cursor: $cursor, limit: $limit) {
        cursor
        items {
          id
          column_values(ids: $columnIds) {
            id
            type
            text
            value
          }
        }
      }
    }
  `;

  const columns = [
    {
      column_id: emailColumnId,
      column_values: [emailNorm],
    },
  ];

  const aggregated = [];
  let cursor = null;
  let page = 0;

  // Prima pagină
  const first = await mondayRequest(initialQuery, {
    boardId: String(boardId),
    columns,
    limit: 500,
    columnIds,
  });

  const firstPage = first.items_page_by_column_values;
  if (!firstPage) return [];

  for (const it of firstPage.items || []) {
    if (itemEmailMatches(it, emailColumnId, emailNorm)) aggregated.push(it);
  }
  cursor = firstPage.cursor || null;
  page += 1;

  // Pagini următoare
  while (cursor) {
    const next = await mondayRequest(nextQuery, {
      cursor,
      limit: 500,
      columnIds,
    });
    const np = next.next_items_page;
    if (!np || !np.items || !np.items.length) break;
    for (const it of np.items) {
      if (itemEmailMatches(it, emailColumnId, emailNorm)) aggregated.push(it);
    }
    cursor = np.cursor || null;
    page += 1;
    if (page > 50) {
      console.error("findItemsByEmail: stopped after 50 pages to avoid runaway loop");
      break;
    }
  }

  return aggregated;
}

function itemEmailMatches(item, emailColumnId, emailNorm) {
  return getEmailValue(item, emailColumnId) === emailNorm;
}

function normalizeGclid(value) {
  if (value == null) return "";
  return String(value).trim();
}

/**
 * Reguli matching (valabile pentru ambele boarduri de lead):
 * - email deja filtrat (exact, după normalize)
 * - GCLID pe lead: trebuie să existe și să nu fie gol
 * - dacă comanda are GCLID: match strict (egalitate)
 * - dacă comanda NU are GCLID: acceptă doar dacă lead-ul are GCLID completat
 */
function isLeadMatch(orderGclidNorm, leadItem, leadGclidColumnId) {
  const leadGclid = normalizeGclid(getTextValue(leadItem, leadGclidColumnId));
  if (!leadGclid) return false;

  if (orderGclidNorm) {
    return leadGclid === orderGclidNorm;
  }
  return true;
}

function getBoardRelationItemIds(item, columnId) {
  const col = getColumn(item, columnId);
  if (!col || !col.value) return [];
  try {
    const v = JSON.parse(col.value);
    // Formate întâlnite: { linkedPulseIds: [{ linkedPulseId: 123 }] } / { item_ids: [...] } etc.
    if (Array.isArray(v?.linkedPulseIds)) {
      return v.linkedPulseIds
        .map((x) => (x && (x.linkedPulseId ?? x.linkedPulseId?.id ?? x.id)) ?? null)
        .filter(Boolean)
        .map((x) => String(x));
    }
    if (Array.isArray(v?.item_ids)) return v.item_ids.map((x) => String(x));
  } catch {
    // ignore
  }
  return [];
}

function getPeopleUserIds(item, columnId) {
  const col = getColumn(item, columnId);
  if (!col || !col.value) return [];
  try {
    const v = JSON.parse(col.value);
    const personsAndTeams = Array.isArray(v?.personsAndTeams) ? v.personsAndTeams : [];
    return personsAndTeams
      .filter((p) => p && (p.kind === "person" || p.type === "person" || p.kind === "user"))
      .map((p) => p.id)
      .filter(Boolean)
      .map((id) => String(id));
  } catch {
    return [];
  }
}

function getPrincipalUserId(item) {
  const ids = getPeopleUserIds(item, COL_PRINCIPAL);
  return ids.length ? ids[0] : null;
}

function shouldUpdateOrder({ item, leadBoardLabel, leadId }) {
  const currentSource = getStatusLabel(item, COL_SURSA_CLIENT); // status/color column label in .text
  const sourceNeedsUpdate = currentSource !== SURSA_WEBSITE_LABEL;

  if (leadBoardLabel === "Solicitari") {
    const currentLinked = getBoardRelationItemIds(item, COL_LINK_SOLICITARI);
    const relationNeedsUpdate = !currentLinked.includes(String(leadId));
    return { shouldUpdate: sourceNeedsUpdate || relationNeedsUpdate, sourceNeedsUpdate, relationNeedsUpdate };
  }

  // Solicitari 2: NU încercăm să scriem relația
  return { shouldUpdate: sourceNeedsUpdate, sourceNeedsUpdate, relationNeedsUpdate: false };
}

async function findMatchingLead(orderEmail, orderGclidRaw) {
  const orderEmailNorm = normalizeEmail(orderEmail);
  const orderGclidNorm = normalizeGclid(orderGclidRaw);

  if (!orderEmailNorm) {
    return { lead: null, reason: "order email missing" };
  }

  // 1) Solicitari
  const leads1 = await findItemsByEmail(BOARD_SOLICITARI, COL_EMAIL_SOLICITARI, orderEmailNorm, [
    COL_GCLID_SOLICITARI,
  ]);
  const matched1 = leads1.filter((it) => isLeadMatch(orderGclidNorm, it, COL_GCLID_SOLICITARI));
  if (matched1.length) {
    if (matched1.length > 1) {
      console.log(
        `findMatchingLead: multiple Solicitari matches (${matched1.length}), using first id=${matched1[0].id}`
      );
    }
    console.log(`lead found in Solicitari: item ${matched1[0].id}`);
    return { lead: matched1[0], boardLabel: "Solicitari" };
  }

  // 2) Solicitari 2
  const leads2 = await findItemsByEmail(BOARD_SOLICITARI_2, COL_EMAIL_SOLICITARI_2, orderEmailNorm, [
    COL_GCLID_SOLICITARI_2,
  ]);
  const matched2 = leads2.filter((it) => isLeadMatch(orderGclidNorm, it, COL_GCLID_SOLICITARI_2));
  if (matched2.length) {
    if (matched2.length > 1) {
      console.log(
        `findMatchingLead: multiple Solicitari 2 matches (${matched2.length}), using first id=${matched2[0].id}`
      );
    }
    console.log(`lead found in Solicitari 2: item ${matched2[0].id}`);
    return { lead: matched2[0], boardLabel: "Solicitari 2" };
  }

  console.log("no matching lead found");
  return { lead: null, reason: "no matching lead" };
}

async function updateOrder({ orderItemId, leadItemId, leadBoardLabel }) {
  const columnValuesObj = {
    [COL_SURSA_CLIENT]: { label: SURSA_WEBSITE_LABEL },
  };

  if (leadBoardLabel === "Solicitari") {
    columnValuesObj[COL_LINK_SOLICITARI] = { item_ids: [String(leadItemId)] };
  } else {
    console.log("relation skipped because Solicitari 2 is not allowed in relation column");
  }

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: String!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await mondayRequest(mutation, {
    boardId: String(BOARD_COMENZI),
    itemId: String(orderItemId),
    columnValues: JSON.stringify(columnValuesObj),
  });
  console.log(`order updated successfully: order ${orderItemId} updated (lead ${leadItemId}, from ${leadBoardLabel})`);
}

async function createItemUpdateWithMention({ itemId, principalUserId, message }) {
  const mutation = `
    mutation ($itemId: ID!, $body: String!, $userId: ID!) {
      create_update(
        item_id: $itemId,
        body: $body,
        mentions_list: [{ id: $userId, type: User }]
      ) {
        id
      }
    }
  `;
  try {
    await mondayRequest(mutation, {
      itemId: String(itemId),
      body: String(message),
      userId: String(principalUserId),
    });
    console.log("create_update fallback used (mentions_list)");
    return { ok: true, usedMentionsList: true };
  } catch (e) {
    console.error("create_update with mentions_list failed", e);
    // Fallback final: create_update simplu (fără mention) – util pentru audit/explicație
    const mutation2 = `
      mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) { id }
      }
    `;
    await mondayRequest(mutation2, { itemId: String(itemId), body: String(message) });
    console.log("create_update fallback used (no mentions_list)");
    return { ok: true, usedMentionsList: false };
  }
}

async function sendPrincipalNotification({ itemId, principalUserId, message }) {
  if (!principalUserId) {
    console.log("principal missing, notification skipped");
    return { ok: true, skipped: "principal missing" };
  }

  // Preferat: create_notification (bell notification)
  const mutation = `
    mutation ($userId: ID!, $targetId: ID!, $text: String!) {
      create_notification(
        user_id: $userId,
        target_id: $targetId,
        text: $text,
        target_type: Project
      ) {
        id
      }
    }
  `;

  try {
    await mondayRequest(mutation, {
      userId: String(principalUserId),
      targetId: String(itemId),
      text: String(message),
    });
    console.log("notification sent (create_notification)");
    return { ok: true, method: "create_notification" };
  } catch (e) {
    console.error("notification failed (create_notification), trying create_update fallback", e);
    await createItemUpdateWithMention({ itemId, principalUserId, message });
    console.log("notification sent (via create_update fallback)");
    return { ok: true, method: "create_update_fallback" };
  }
}

// ---------------------------------------------------------------------------
// Webhook: parsare body + extragere item id
// ---------------------------------------------------------------------------

function parseJsonBody(event) {
  let raw = event.body;
  if (raw == null) return {};
  if (event.isBase64Encoded && typeof raw === "string") {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function extractItemIdFromPayload(body) {
  if (!body || typeof body !== "object") return null;

  const candidates = [
    body.itemId,
    body.item_id,
    body.pulseId,
    body.pulse_id,
    body.item && body.item.id,
    body.event && body.event.itemId,
    body.event && body.event.item_id,
    body.event && body.event.pulseId,
    body.event && body.event.pulse_id,
    body.event && body.event.item && body.event.item.id,
    body.payload && body.payload.itemId,
    body.payload && body.payload.item_id,
    body.payload && body.payload.pulseId,
    body.data && body.data.itemId,
    body.data && body.data.pulse_id,
  ];

  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s) return s;
  }
  return null;
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------------------
// Handler Netlify
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod === "GET" || event.httpMethod === "HEAD") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const body = parseJsonBody(event);

  // Verificare webhook monday (challenge)
  if (Object.prototype.hasOwnProperty.call(body, "challenge")) {
    console.log("webhook verification: responding to challenge");
    return jsonResponse(200, { challenge: body.challenge });
  }

  const itemId = extractItemIdFromPayload(body);
  if (!itemId) {
    console.log("item not found in webhook payload (missing item id)");
    return jsonResponse(200, {
      ok: true,
      skipped: "no item id in payload",
    });
  }

  try {
    const item = await getItem(itemId);
    if (!item) {
      console.log(`item not found via API: ${itemId}`);
      return jsonResponse(200, { ok: true, skipped: "item not found" });
    }

    const boardId = item.board && item.board.id ? String(item.board.id) : "";
    if (boardId !== BOARD_COMENZI) {
      console.log(`item ${itemId} not on Comenzi board (boardId=${boardId || "unknown"})`);
      return jsonResponse(200, { ok: true, skipped: "wrong board" });
    }

    const statusLabel = getStatusLabel(item, COL_STATUS_TRANSPORT);
    if (statusLabel !== STATUS_DELIVERED_LABEL) {
      console.log(`status not delivered for item ${itemId}: "${statusLabel}"`);
      return jsonResponse(200, { ok: true, skipped: "status not delivered" });
    }

    const orderEmail = getEmailValue(item, COL_EMAIL_COMANDA);
    if (!normalizeEmail(orderEmail)) {
      console.log(`order email missing for item ${itemId}`);
      return jsonResponse(200, { ok: true, skipped: "order email missing" });
    }

    const orderGclid = getTextValue(item, COL_GCLID_COMANDA);

    const { lead, boardLabel, reason } = await findMatchingLead(orderEmail, orderGclid);
    if (!lead) {
      return jsonResponse(200, {
        ok: true,
        skipped: reason || "no matching lead",
        orderId: String(itemId),
      });
    }

    const { shouldUpdate, sourceNeedsUpdate, relationNeedsUpdate } = shouldUpdateOrder({
      item,
      leadBoardLabel: boardLabel,
      leadId: lead.id,
    });

    if (!shouldUpdate) {
      console.log("no changes needed");
      return jsonResponse(200, {
        ok: true,
        skipped: "no changes needed",
        matchedIn: boardLabel,
        leadId: String(lead.id),
        orderId: String(itemId),
      });
    }

    await updateOrder({ orderItemId: itemId, leadItemId: lead.id, leadBoardLabel: boardLabel });
    console.log("order updated");

    const principalUserId = getPrincipalUserId(item);

    const message =
      boardLabel === "Solicitari"
        ? "Lead identificat automat în Solicitari. Sursa Client a fost setată la Website și lead-ul a fost conectat."
        : "Lead identificat automat în Solicitari 2. Sursa Client a fost setată la Website. Lead-ul nu a fost conectat în coloana relațională deoarece aceasta acceptă doar iteme din boardul Solicitari.";

    // Solicitari 2 fără Principal: un singur update pe item (audit), fără dubluri cu sendPrincipalNotification.
    if (boardLabel === "Solicitari 2" && !principalUserId) {
      try {
        const mutation = `mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`;
        await mondayRequest(mutation, { itemId: String(itemId), body: message });
      } catch (e) {
        console.error("failed to create informational update for Solicitari 2 case (no principal)", e);
      }
    }

    // Notificare doar după update reușit și doar când schimbarea e făcută de aplicație.
    await sendPrincipalNotification({ itemId, principalUserId, message });

    return jsonResponse(200, {
      ok: true,
      matchedIn: boardLabel,
      leadId: String(lead.id),
      orderId: String(itemId),
      updated: true,
      changes: {
        source: sourceNeedsUpdate,
        relation: relationNeedsUpdate,
      },
    });
  } catch (e) {
    console.error("monday API error", e);
    return jsonResponse(500, {
      ok: false,
      error: e && e.message ? e.message : "Unknown error",
    });
  }
};
