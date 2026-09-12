/**
 * treasury-cod-worker — NEW ACCOUNT (ecommoda-dev)
 * v2.3.0 — Analytics Endpoint
 *
 * Changes from v2.2.0:
 *   - [NEW] get_analytics: pre-aggregated D1 SQL + Shopify enrichment
 *   - [NEW] PENDING_START_DATE = '2026-05-01' (hard lower-bound for pending orders)
 *   - [NEW] classifyOrderType() — from S2 + returnStatus (NOT bosta_order_type)
 *   - [NEW] extractCODPaymentDate() — from Shopify transactions (kind=SALE, COD gateway)
 *   - [NEW] fetchShopifyOrdersForAnalytics() — paginated PAID+PARTIALLY_REFUNDED orders
 *   - [NEW] ANALYTICS_GQL_QUERY — includes transactions, S2, courier, treasury metafields
 *
 * D1 Schema:
 *   tool:  'treasury'
 *   types: 'deposit' | 'login' | 'logout'
 *
 * Shopify Metafields:
 *   treasury_amount       → number_integer
 *   treasury_count        → number_integer
 *   treasury_last_updated → date_time (UTC ISO 8601)
 */
// EcomModa — Treasury-COD (v2.3.0)
// skills: migration-playbook v2.5.0 · worker-builder v2.1.0 · constants v1.8.0 — 06-09-2026

// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════
const TOOL_NAME = 'treasury';

const ALLOWED_FINANCIAL_STATUSES = ['PAID', 'PARTIALLY_REFUNDED'];

const WARNING_BLOCK_THRESHOLD = 0.10;

// [NEW v2.3.0] أقدم تاريخ يُعتبر فيه الأوردر "pending treasury"
// (بدأنا نظام التسجيل في الخزينة من هذا التاريخ)
const PENDING_START_DATE = '2026-05-01';

// ══════════════════════════════════════════════════════════════
// §CORS — Option B (strict) — financial/write tool
// ══════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://ecommoda-dev.github.io',
];

function getCORS(request) {
  const origin  = (request && request.headers.get('Origin')) || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': '*' });
  return new Response(JSON.stringify(data), { status, headers });
}

// ══════════════════════════════════════════════════════════════
// §SHARED — Auth & Logging Functions — EcomModa D1 Pattern v1.3.0
// Copy verbatim — do not modify
// ══════════════════════════════════════════════════════════════

async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();
  if (!row) return null;
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username).run().catch(() => {});
  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row) return { exists: false, hasPin: false, isActive: false };
  return { exists: true, hasPin: !!row.pin, isActive: !!row.is_active };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');
  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?').bind(pin, username).run();
  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null,
  ).run();
}

async function getLogs(db, {
  tool = null, employee = null, type = null,
  search = null, limit = 100, offset = 0,
  dateFrom = null, dateTo = null,
} = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';                 b.push(tool); }
  if (employee) { sql += ' AND employee = ?';             b.push(employee); }
  if (type)     { sql += ' AND type = ?';                 b.push(type); }
  if (search)   {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND timestamp >= ?';           b.push(dateFrom); }
  if (dateTo)   { sql += ' AND timestamp <= ?';           b.push(dateTo.replace('T00:00:00', 'T23:59:59').replace(/T\d{2}:\d{2}:\d{2}.*$/, 'T23:59:59.999Z')); }
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  b.push(Math.min(limit, 500), offset);
  return (await db.prepare(sql).bind(...b).all()).results;
}

async function getLogsCount(db, {
  tool = null, employee = null, search = null,
  dateFrom = null, dateTo = null,
} = {}) {
  let sql = "SELECT COUNT(*) as total FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';                 b.push(tool); }
  if (employee) { sql += ' AND employee = ?';             b.push(employee); }
  if (search)   {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND timestamp >= ?';           b.push(dateFrom); }
  if (dateTo)   { sql += ' AND timestamp <= ?';           b.push(dateTo.replace(/T\d{2}:\d{2}:\d{2}.*$/, 'T23:59:59.999Z')); }
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

async function getLogsExport(db, {
  tool = null, employee = null, search = null,
  dateFrom = null, dateTo = null,
} = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';                 b.push(tool); }
  if (employee) { sql += ' AND employee = ?';             b.push(employee); }
  if (search)   {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND timestamp >= ?';           b.push(dateFrom); }
  if (dateTo)   { sql += ' AND timestamp <= ?';           b.push(dateTo.replace(/T\d{2}:\d{2}:\d{2}.*$/, 'T23:59:59.999Z')); }
  sql += ' ORDER BY timestamp DESC LIMIT 2000';
  return (await db.prepare(sql).bind(...b).all()).results;
}

// ══════════════════════════════════════════════════════════════
// END SHARED BLOCK
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════════════

async function getAccessToken(env) {
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
    }),
  });
  return (await res.json()).access_token || null;
}

async function shopifyGQL(env, token, query, variables = {}) {
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body:    JSON.stringify({ query, variables }),
  });
  return res.json();
}

// [NEW v2.3.0] GraphQL query للـ analytics — يجلب كل البيانات المطلوبة
// transactions: list مباشر (ليس connection) — لا edges/nodes
// S2 (status_2_r_e) + manual_status + courier + treasury metafields
const ANALYTICS_GQL_QUERY = `
  query GetOrdersAnalytics($cursor: String, $q: String!) {
    orders(first: 250, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        createdAt
        returnStatus
        displayFinancialStatus
        totalPriceSet { shopMoney { amount } }
        transactions {
          kind
          status
          gateway
          processedAt
          amountSet { shopMoney { amount } }
        }
        treasury_count:  metafield(namespace: "custom", key: "treasury_count")  { value }
        treasury_amount: metafield(namespace: "custom", key: "treasury_amount") { value }
        courier:         metafield(namespace: "custom", key: "courier")          { value }
        s2:              metafield(namespace: "custom", key: "status_2_r_e")    { value }
        manual_status:   metafield(namespace: "custom", key: "manual_status")   { value }
      }
    }
  }
`;

// [NEW v2.3.0] تصنيف نوع الأوردر من S2 + returnStatus
// لا علاقة لـ bosta_order_type — جزء من الأوردرات لا يشحن مع بوسطة
function classifyOrderType(s2, returnStatus) {
  if (s2) {
    const up = s2.toUpperCase();
    // S2 يحمل EXCHANGE → استبدال
    if (up.includes('EXCHANGE')) return 'استبدال';
    // S2 يحمل RETURN أو مراحل الإرجاع → استرجاع
    if (up.includes('RETURN') || s2 === 'In-Return' || s2 === 'Returned') return 'استرجاع';
    // S2 = "Ready" أو "Shipped" → مرحلة وسيطة، نستخدم returnStatus للحكم
    if (returnStatus === 'RETURNED' || returnStatus === 'IN_PROGRESS') return 'استرجاع';
    // S2 موجود ولا يوجد RETURN keyword → على الأرجح استبدال
    return 'استبدال';
  }
  // S2 غير موجود → نعتمد على Shopify returnStatus
  if (returnStatus === 'RETURNED' || returnStatus === 'IN_PROGRESS') return 'استرجاع';
  return 'أساسي'; // NO_RETURN أو null
}

// [NEW v2.3.0] استخراج تاريخ التحصيل من transactions
// نأخذ أحدث SALE transaction ناجح على Cash on Delivery (COD)
function extractCODPaymentDate(transactions, fallback) {
  if (!Array.isArray(transactions) || !transactions.length) return fallback;
  const sales = transactions
    .filter(t =>
      t.kind    === 'SALE'    &&
      t.status  === 'SUCCESS' &&
      t.gateway === 'Cash on Delivery (COD)'
    )
    .sort((a, b) => new Date(b.processedAt) - new Date(a.processedAt));
  return sales[0]?.processedAt || fallback;
}

// [NEW v2.3.0] جلب أوردرات Shopify للـ analytics (pagination كاملة)
// يجلب PAID + PARTIALLY_REFUNDED بشكل منفصل ثم يدمجهم
// MAX_PAGES = 20 (حد أمان = 5000 أوردر)
async function fetchShopifyOrdersForAnalytics(env, token, fromDate, toDate) {
  const allOrders = [];
  const MAX_PAGES = 20;

  for (const status of ['paid', 'partially_refunded']) {
    let cursor  = null;
    let hasNext = true;
    let pages   = 0;
    const q = `financial_status:${status} created_at:>=${fromDate} created_at:<=${toDate}`;

    while (hasNext && pages < MAX_PAGES) {
      const data = await shopifyGQL(env, token, ANALYTICS_GQL_QUERY, { cursor, q });
      const conn = data?.data?.orders;
      if (!conn) break;

      for (const node of conn.nodes) allOrders.push(node);
      hasNext = conn.pageInfo.hasNextPage;
      cursor  = conn.pageInfo.endCursor;
      pages++;
    }
  }

  return allOrders;
}

// ══════════════════════════════════════════════════════════════
// §TREASURY — Core Logic
// ══════════════════════════════════════════════════════════════

async function fetchOrderData(env, token, cleanName) {
  const query = `
    query getOrderData($q: String!) {
      orders(first: 1, query: $q) {
        nodes {
          id name cancelledAt displayFinancialStatus
          currentSubtotalPriceSet    { shopMoney { amount } }
          totalOutstandingSet { shopMoney { amount } }
          tAmt: metafield(namespace: "custom", key: "treasury_amount")       { value }
          tCnt: metafield(namespace: "custom", key: "treasury_count")        { value }
          tUpd: metafield(namespace: "custom", key: "treasury_last_updated") { value }
        }
      }
    }
  `;
  const data   = await shopifyGQL(env, token, query, { q: `name:#${cleanName}` });
  const orders = data?.data?.orders?.nodes;
  if (!orders?.length) return null;

  const o  = orders[0];
  const id = o.id.replace('gid://shopify/Order/', '');

  if (o.cancelledAt)
    return { numericId: id, orderName: o.name, cancelled: true, financialStatus: o.displayFinancialStatus };

  return {
    numericId:           id,
    orderName:           o.name,
    cancelled:           false,
    financialStatus:     o.displayFinancialStatus,
    totalPrice:          parseFloat(o.currentSubtotalPriceSet?.shopMoney?.amount || '0'),
    outstanding:         parseFloat(o.totalOutstandingSet?.shopMoney?.amount || '0'),
    treasuryAmount:      o.tAmt?.value != null ? parseInt(o.tAmt.value, 10)  : 0,
    treasuryCount:       o.tCnt?.value != null ? parseInt(o.tCnt.value, 10)  : 0,
    treasuryLastUpdated: o.tUpd?.value || null,
  };
}

async function setTreasuryMetafields(env, token, numericId, amount, count, isoTs) {
  const mutation = `
    mutation SetTreasury($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors  { field message }
      }
    }
  `;
  const owner = `gid://shopify/Order/${numericId}`;
  const data  = await shopifyGQL(env, token, mutation, {
    metafields: [
      { ownerId: owner, namespace: 'custom', key: 'treasury_amount',       type: 'number_integer', value: String(amount) },
      { ownerId: owner, namespace: 'custom', key: 'treasury_count',        type: 'number_integer', value: String(count)  },
      { ownerId: owner, namespace: 'custom', key: 'treasury_last_updated', type: 'date_time',      value: isoTs          },
    ],
  });
  const payload = data?.data?.metafieldsSet;
  if (payload?.userErrors?.length)
    return { success: false, error: payload.userErrors.map(e => e.message).join(', ') };
  if (payload?.metafields?.length)
    return { success: true };
  return { success: false, error: 'لم ترجع ميتافيلدات من Shopify' };
}

function buildWarning(delta, totalPrice, treasuryAmount) {
  if (totalPrice <= 0) return { message: null, needsOverride: false };

  const remaining  = Math.round(totalPrice) - treasuryAmount;
  const absDelta   = Math.abs(delta);
  const absRemain  = Math.abs(remaining);

  if (absDelta === absRemain) return { message: null, needsOverride: false };

  const diff      = Math.abs(absDelta - absRemain);
  const ratio     = diff / Math.round(totalPrice);
  const needsOverride = ratio > WARNING_BLOCK_THRESHOLD;

  const message =
    `المبلغ المُدخل (${absDelta.toLocaleString('en-US')}) ` +
    `يختلف عن المبلغ المتبقي للأوردر (${absRemain.toLocaleString('en-US')}) ` +
    `— فرق: ${diff.toLocaleString('en-US')} (${(ratio * 100).toFixed(1)}%)`;

  return { message, needsOverride };
}

async function getD1SumForOrder(db, orderName) {
  const row = await db.prepare(`
    SELECT SUM(delta) as total FROM logs
    WHERE tool   = 'treasury'
      AND order_name = ?
      AND type   = 'deposit'
      AND (notes IS NULL OR notes NOT LIKE 'SHOPIFY_WRITE_FAILED%')
  `).bind(orderName).first();
  if (row?.total == null) return null;
  return Number(row.total);
}

function mkError(rawName, delta, error, d = null) {
  return {
    success:   false,
    orderName: d?.orderName || `#${rawName}`,
    orderId:   d?.numericId || null,
    delta:     typeof delta === 'number' ? delta : parseInt(delta, 10) || 0,
    error,
  };
}

async function previewEntry(env, token, rawName, rawDelta) {
  const name = String(rawName).replace(/^#/, '').trim();
  try {
    const parsedDelta = parseInt(rawDelta, 10);
    if (isNaN(parsedDelta) || parsedDelta === 0)
      return mkError(name, rawDelta, 'مبلغ غير صالح (لا يمكن أن يكون صفراً)');

    const d = await fetchOrderData(env, token, name);
    if (!d) return mkError(name, parsedDelta, 'الأوردر غير موجود');
    if (d.cancelled) return mkError(name, parsedDelta, 'الأوردر ملغي', d);

    if (!ALLOWED_FINANCIAL_STATUSES.includes(d.financialStatus))
      return mkError(name, parsedDelta, `الحالة المالية غير مؤهلة للتسجيل: ${d.financialStatus}`, d);

    const { message: warningMessage, needsOverride } =
      buildWarning(parsedDelta, d.totalPrice, d.treasuryAmount);

    const d1Sum = await getD1SumForOrder(env.DB, d.orderName);
    let reconciliationWarning = null;
    if (d1Sum !== null && d1Sum !== d.treasuryAmount) {
      reconciliationWarning =
        `تباين: مجموع D1 (${d1Sum.toLocaleString('en-US')}) ≠ Shopify (${d.treasuryAmount.toLocaleString('en-US')}) — يُرجى المراجعة`;
    }

    return {
      success:               true,
      orderId:               d.numericId,
      orderName:             d.orderName,
      financialStatus:       d.financialStatus,
      totalPrice:            d.totalPrice,
      treasuryAmount:        d.treasuryAmount,
      treasuryCount:         d.treasuryCount,
      treasuryLastUpdated:   d.treasuryLastUpdated,
      delta:                 parsedDelta,
      newAmount:             d.treasuryAmount + parsedDelta,
      validationWarning:     warningMessage,
      needsOverride,
      reconciliationWarning,
    };
  } catch (err) {
    return mkError(name, rawDelta, err.message);
  }
}

async function registerEntry(env, token, rawName, rawDelta, employee, clientMeta = {}, overrideWarning = false) {
  const name = String(rawName).replace(/^#/, '').trim();
  try {
    const parsedDelta = parseInt(rawDelta, 10);
    if (isNaN(parsedDelta) || parsedDelta === 0)
      return mkError(name, rawDelta, 'مبلغ غير صالح (لا يمكن أن يكون صفراً)');

    const d = await fetchOrderData(env, token, name);
    if (!d) return mkError(name, parsedDelta, 'الأوردر غير موجود');
    if (d.cancelled) return mkError(name, parsedDelta, 'الأوردر ملغي', d);

    if (!ALLOWED_FINANCIAL_STATUSES.includes(d.financialStatus))
      return mkError(name, parsedDelta, `الحالة المالية غير مؤهلة للتسجيل: ${d.financialStatus}`, d);

    const { message: warningMessage, needsOverride } =
      buildWarning(parsedDelta, d.totalPrice, d.treasuryAmount);

    if (needsOverride && !overrideWarning) {
      return {
        ...mkError(name, parsedDelta,
          `الفرق بين المبلغ المُدخل والمتبقي يتجاوز ${(WARNING_BLOCK_THRESHOLD * 100).toFixed(0)}% — ` +
          `${warningMessage} — ` +
          `أرسل overrideWarning: true في الـ request للمتابعة`, d),
        needsOverride: true,
        validationWarning: warningMessage,
      };
    }

    const d1Sum = await getD1SumForOrder(env.DB, d.orderName);
    let reconciliationWarning = null;
    if (d1Sum !== null && d1Sum !== d.treasuryAmount) {
      reconciliationWarning =
        `تباين: مجموع D1 (${d1Sum.toLocaleString('en-US')}) ≠ Shopify (${d.treasuryAmount.toLocaleString('en-US')})`;
    }

    const newAmount = d.treasuryAmount + parsedDelta;
    const newCount  = d.treasuryCount  + 1;
    const nowIso    = new Date().toISOString();
    const notesArr  = [warningMessage, reconciliationWarning].filter(Boolean);

    try {
      await writeLog(env.DB, {
        tool:        TOOL_NAME,
        type:        'deposit',
        timestamp:   nowIso,
        employee:    employee || null,
        orderId:     d.numericId,
        orderName:   d.orderName,
        delta:       parsedDelta,
        valueBefore: d.treasuryAmount,
        valueAfter:  newAmount,
        notes:       notesArr.length ? notesArr.join(' | ') : null,
        extra: {
          operationCount:    newCount,
          totalPrice:        d.totalPrice,
          financialStatus:   d.financialStatus,
          overrideWarning:   overrideWarning || false,
          ip:                clientMeta.ip        || null,
          userAgent:         clientMeta.userAgent || null,
        },
      });
    } catch (d1Err) {
      return mkError(name, parsedDelta, `فشل تسجيل السجل (D1): ${d1Err.message}`, d);
    }

    const metaRes = await setTreasuryMetafields(env, token, d.numericId, newAmount, newCount, nowIso);
    if (!metaRes.success) {
      await writeLog(env.DB, {
        tool:        TOOL_NAME,
        type:        'deposit',
        timestamp:   new Date().toISOString(),
        employee:    employee || null,
        orderId:     d.numericId,
        orderName:   d.orderName,
        delta:       -parsedDelta,
        valueBefore: newAmount,
        valueAfter:  d.treasuryAmount,
        notes:       `SHOPIFY_WRITE_FAILED — تعويض تلقائي: ${metaRes.error}`,
        extra:       { compensating: true, originalError: metaRes.error, ip: clientMeta.ip || null },
      }).catch(() => {});
      return mkError(name, parsedDelta, `فشل الكتابة على Shopify: ${metaRes.error}`, d);
    }

    return {
      success:               true,
      orderId:               d.numericId,
      orderName:             d.orderName,
      financialStatus:       d.financialStatus,
      totalPrice:            d.totalPrice,
      delta:                 parsedDelta,
      previousAmount:        d.treasuryAmount,
      newAmount,
      operationCount:        newCount,
      validationWarning:     warningMessage,
      needsOverride,
      reconciliationWarning,
      registeredAt:          nowIso,
    };
  } catch (err) {
    return mkError(name, rawDelta, err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });

    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: getCORS(request),
      });

    try {

      // ─── §AUTH ────────────────────────────────────────────────
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);
        await writeLog(env.DB, { tool: TOOL_NAME, type: 'login', employee: username, notes: `دخول: ${displayName}` });
        return json({ ok: true, displayName }, 200, request);
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        if (username) {
          await writeLog(env.DB, {
            tool: TOOL_NAME, type: 'logout', employee: username,
            notes: `خروج: ${username.replace(/_/g, ' ')}`,
          });
        }
        return json({ ok: true }, 200, request);
      }

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }
      // ──────────────────────────────────────────────────────────

      const token = await getAccessToken(env);
      if (!token) return json({ success: false, error: 'فشل الاتصال بـ Shopify' }, 500, request);

      const clientMeta = {
        ip:        request.headers.get('CF-Connecting-IP') || null,
        userAgent: request.headers.get('User-Agent')       || null,
      };

      // ─── §TREASURY ────────────────────────────────────────────
      if (action === 'bulkPreview') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { entries } = await request.json().catch(() => ({}));
        if (!Array.isArray(entries) || !entries.length)
          return json({ error: 'entries array is required' }, 400, request);

        const results = await Promise.all(
          entries.map(e => previewEntry(env, token, e.orderName, e.delta))
        );
        return json({ success: true, results }, 200, request);
      }

      if (action === 'bulkRegister') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { entries, employee, overrideWarning = false } = await request.json().catch(() => ({}));

        if (!Array.isArray(entries) || !entries.length)
          return json({ error: 'entries array is required' }, 400, request);

        if (!employee || !String(employee).trim())
          return json({ error: 'employee مطلوب لتسجيل الخزينة' }, 400, request);

        const names      = entries.map(e => String(e.orderName).replace(/^#/, '').trim().toUpperCase());
        const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
        if (duplicates.length)
          return json({
            error: `أوردرات مكررة في نفس الـ batch: ${[...new Set(duplicates)].join(', ')}`,
          }, 400, request);

        const results = await Promise.all(
          entries.map(e => registerEntry(env, token, e.orderName, e.delta, employee, clientMeta, overrideWarning))
        );
        return json({ success: true, results }, 200, request);
      }

      if (action === 'getLog') {
        const rawName    = url.searchParams.get('orderName') || '';
        if (!rawName) return json({ error: 'orderName مطلوب' }, 400, request);

        const cleanName    = String(rawName).replace(/^#/, '').trim();
        const orderNameKey = `#${cleanName}`;

        const { results } = await env.DB.prepare(`
          SELECT * FROM logs
          WHERE tool = ? AND order_name = ? AND type = 'deposit'
          ORDER BY timestamp ASC
        `).bind(TOOL_NAME, orderNameKey).all();

        let currentShopify = null;
        try {
          const d = await fetchOrderData(env, token, cleanName);
          if (d && !d.cancelled) {
            currentShopify = {
              treasuryAmount:  d.treasuryAmount,
              treasuryCount:   d.treasuryCount,
              financialStatus: d.financialStatus,
              totalPrice:      d.totalPrice,
              lastUpdated:     d.treasuryLastUpdated,
            };
          }
        } catch {}

        if (!results?.length && !currentShopify)
          return json({ success: false, notFound: true }, 200, request);

        const entries = (results || []).map(row => {
          let extra = {};
          try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
          return {
            registeredAt:      row.timestamp,
            employee:          row.employee,
            delta:             row.delta,
            previousAmount:    row.value_before,
            newAmount:         row.value_after,
            operationCount:    extra.operationCount  || 0,
            totalPrice:        extra.totalPrice      || null,
            financialStatus:   extra.financialStatus || null,
            validationWarning: extra.compensating ? null : (row.notes || null),
            compensatingEntry: extra.compensating    || false,
            overrideWarning:   extra.overrideWarning || false,
            ip:                extra.ip              || null,
          };
        });

        const confirmedEntries     = entries.filter(e => !e.compensatingEntry);
        const d1Sum                = confirmedEntries.reduce((acc, e) => acc + (e.delta || 0), 0);
        const shopifyAmount        = currentShopify?.treasuryAmount ?? null;
        const hasReconciliationGap = shopifyAmount !== null ? d1Sum !== shopifyAmount : false;

        return json({
          success:      true,
          orderName:    orderNameKey,
          entries,
          currentShopify,
          reconciliation: {
            d1Sum,
            shopifyAmount,
            inSync: !hasReconciliationGap,
          },
        }, 200, request);
      }
      // ──────────────────────────────────────────────────────────

      // ─── §ANALYTICS ───────────────────────────────────────────
      if (action === 'get_analytics') {
        // 1. Parse & validate date params
        const today     = new Date().toISOString().substring(0, 10);
        const dateFrom  = (url.searchParams.get('date_from') || PENDING_START_DATE);
        const dateTo    = (url.searchParams.get('date_to')   || today);

        // pending: lower-bound = max(dateFrom, PENDING_START_DATE)
        const pendingFromDate = new Date(Math.max(
          new Date(dateFrom + 'T00:00:00Z'),
          new Date(PENDING_START_DATE + 'T00:00:00Z')
        ));
        const pendingFrom = pendingFromDate.toISOString().substring(0, 10);
        const pendingTo   = dateTo;

        // 2. D1 queries — run in parallel (8 queries)
        const d1From = dateFrom + 'T00:00:00.000Z';
        const d1To   = dateTo   + 'T23:59:59.999Z';

        const [
          summaryRow,
          dailyRes,
          warningsRes,
          repeatsRes,
          overridesRes,
          failuresRes,
          orderTotalsRes,
        ] = await Promise.all([

          // Q1: Summary KPIs
          env.DB.prepare(`
            SELECT
              COUNT(*)                   AS ops,
              COUNT(DISTINCT order_name) AS orders,
              COALESCE(SUM(delta), 0)    AS total
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND (notes IS NULL OR notes NOT LIKE 'SHOPIFY_WRITE_FAILED%')
              AND timestamp >= ? AND timestamp <= ?
          `).bind(d1From, d1To).first(),

          // Q2: Daily breakdown
          env.DB.prepare(`
            SELECT
              DATE(timestamp)            AS day,
              SUM(delta)                 AS amount,
              COUNT(*)                   AS ops,
              COUNT(DISTINCT order_name) AS orders
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND (notes IS NULL OR notes NOT LIKE 'SHOPIFY_WRITE_FAILED%')
              AND timestamp >= ? AND timestamp <= ?
            GROUP BY DATE(timestamp)
            ORDER BY day ASC
          `).bind(d1From, d1To).all(),

          // Q3: Validation Warnings (notes IS NOT NULL, not a Shopify failure)
          env.DB.prepare(`
            SELECT order_name, employee, timestamp, delta, value_before, value_after, notes, extra
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND notes IS NOT NULL
              AND notes NOT LIKE 'SHOPIFY_WRITE_FAILED%'
              AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp DESC
          `).bind(d1From, d1To).all(),

          // Q4: Repeat Registrations (same order > 1 deposit)
          env.DB.prepare(`
            SELECT order_name, COUNT(*) AS cnt, SUM(delta) AS total
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND (notes IS NULL OR notes NOT LIKE 'SHOPIFY_WRITE_FAILED%')
              AND timestamp >= ? AND timestamp <= ?
            GROUP BY order_name
            HAVING cnt > 1
            ORDER BY cnt DESC
          `).bind(d1From, d1To).all(),

          // Q5: Override Approvals (overrideWarning: true in extra)
          env.DB.prepare(`
            SELECT order_name, employee, timestamp, delta, notes, extra
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND extra LIKE '%"overrideWarning":true%'
              AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp DESC
          `).bind(d1From, d1To).all(),

          // Q6: Shopify Write Failures (compensating entries)
          env.DB.prepare(`
            SELECT order_name, employee, timestamp, delta, notes
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND notes LIKE 'SHOPIFY_WRITE_FAILED%'
              AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp DESC
          `).bind(d1From, d1To).all(),

          // Q7: Per-order totals + names (for Shopify enrichment join)
          env.DB.prepare(`
            SELECT order_name, SUM(delta) AS total_deposited, COUNT(*) AS ops
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND (notes IS NULL OR notes NOT LIKE 'SHOPIFY_WRITE_FAILED%')
              AND timestamp >= ? AND timestamp <= ?
            GROUP BY order_name
          `).bind(d1From, d1To).all(),
        ]);

        // Build deposited order map: name → total_deposited
        const orderTotals    = {};
        const depositedNames = new Set();
        for (const row of (orderTotalsRes.results || [])) {
          orderTotals[row.order_name] = row.total_deposited;
          depositedNames.add(row.order_name);
        }

        // 3. Shopify: fetch PAID + PARTIALLY_REFUNDED orders for pending + enrichment
        let shopifyOrders = [];
        let shopifyError  = null;
        try {
          shopifyOrders = await fetchShopifyOrdersForAnalytics(env, token, pendingFrom, pendingTo);
        } catch (err) {
          shopifyError = err.message;
        }

        // 4. Process Shopify orders
        const pending    = [];
        const enriched   = [];

        for (const o of shopifyOrders) {
          const tCount       = parseInt(o.treasury_count?.value || '0', 10);
          const totalPrice   = parseFloat(o.totalPriceSet?.shopMoney?.amount || '0');
          const collectionDate = extractCODPaymentDate(o.transactions, o.createdAt);
          const daysSince    = Math.max(0, Math.floor((Date.now() - new Date(collectionDate)) / 86400000));
          const orderType    = classifyOrderType(o.s2?.value, o.returnStatus);
          const courier      = o.courier?.value || 'غير محدد';

          const entry = {
            name:            o.name,
            createdAt:       o.createdAt,
            collectionDate,
            daysSince,
            totalPrice,
            courier,
            orderType,
            financialStatus: o.displayFinancialStatus,
          };

          // Pending = treasury_count = 0 (لم يُودَع في الخزينة بعد)
          if (tCount === 0) pending.push(entry);

          // Enriched = موجود في D1 deposits خلال الفترة
          if (depositedNames.has(o.name)) enriched.push(entry);
        }

        // 5. Build byCourier (deposited + pending)
        const courierMap        = {};
        const pendingByCourier  = {};

        for (const o of enriched) {
          const deposited = orderTotals[o.name] || 0;
          if (!courierMap[o.courier])
            courierMap[o.courier] = { deposited: 0, orders: 0 };
          courierMap[o.courier].deposited += deposited;
          courierMap[o.courier].orders++;
        }

        for (const o of pending) {
          if (!pendingByCourier[o.courier])
            pendingByCourier[o.courier] = { count: 0, amount: 0 };
          pendingByCourier[o.courier].count++;
          pendingByCourier[o.courier].amount += o.totalPrice;
        }

        const allCouriers = new Set([
          ...Object.keys(courierMap),
          ...Object.keys(pendingByCourier),
        ]);
        const byCourier = Array.from(allCouriers).map(c => ({
          courier:         c,
          deposited:       courierMap[c]?.deposited || 0,
          depositedOrders: courierMap[c]?.orders    || 0,
          pendingCount:    pendingByCourier[c]?.count  || 0,
          pendingAmount:   pendingByCourier[c]?.amount || 0,
        })).sort((a, b) => b.deposited - a.deposited);

        // 6. Build byOrderType (deposited + pending)
        const typeMap        = {};
        const pendingByType  = {};

        for (const o of enriched) {
          const deposited = orderTotals[o.name] || 0;
          if (!typeMap[o.orderType])
            typeMap[o.orderType] = { deposited: 0, orders: 0 };
          typeMap[o.orderType].deposited += deposited;
          typeMap[o.orderType].orders++;
        }

        for (const o of pending) {
          if (!pendingByType[o.orderType])
            pendingByType[o.orderType] = { count: 0, amount: 0 };
          pendingByType[o.orderType].count++;
          pendingByType[o.orderType].amount += o.totalPrice;
        }

        const allTypes = new Set([
          ...Object.keys(typeMap),
          ...Object.keys(pendingByType),
        ]);
        const byOrderType = Array.from(allTypes).map(t => ({
          orderType:       t,
          deposited:       typeMap[t]?.deposited || 0,
          depositedOrders: typeMap[t]?.orders    || 0,
          pendingCount:    pendingByType[t]?.count  || 0,
          pendingAmount:   pendingByType[t]?.amount || 0,
        })).sort((a, b) => b.deposited - a.deposited);

        // 7. Parse extra JSON for warnings/overrides
        const parseExtra = row => {
          let extra = {};
          try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
          return { ...row, extra };
        };

        return json({
          ok: true,
          dateRange: {
            from:        dateFrom,
            to:          dateTo,
            pendingFrom,
            pendingTo,
          },
          summary: {
            totalDeposited: summaryRow?.total  || 0,
            totalOrders:    summaryRow?.orders || 0,
            totalOperations: summaryRow?.ops   || 0,
            pendingCount:   pending.length,
            pendingAmount:  pending.reduce((s, o) => s + o.totalPrice, 0),
          },
          daily:   dailyRes.results   || [],
          pending: pending.sort((a, b) => b.daysSince - a.daysSince),
          byCourier,
          byOrderType,
          anomalies: {
            warnings:  (warningsRes.results  || []).map(parseExtra),
            repeats:    repeatsRes.results   || [],
            overrides: (overridesRes.results || []).map(parseExtra),
            failures:   failuresRes.results  || [],
          },
          shopifyError,
        }, 200, request);
      }
      // ──────────────────────────────────────────────────────────

      // ─── §LOG-ENDPOINTS ───────────────────────────────────────
      if (action === 'get_logs') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const limit    = Math.min(parseInt(url.searchParams.get('limit')  || '100'), 500);
        const offset   = Math.max(parseInt(url.searchParams.get('offset') || '0'),    0);
        const dateFrom = url.searchParams.get('date_from') || null;
        const dateTo   = url.searchParams.get('date_to')   || null;
        const entries  = await getLogs(env.DB, { tool: TOOL_NAME, employee, search, limit, offset, dateFrom, dateTo });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const dateFrom = url.searchParams.get('date_from') || null;
        const dateTo   = url.searchParams.get('date_to')   || null;
        const total    = await getLogsCount(env.DB, { tool: TOOL_NAME, employee, search, dateFrom, dateTo });
        return json({ ok: true, total }, 200, request);
      }

      if (action === 'get_logs_export') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const dateFrom = url.searchParams.get('date_from') || null;
        const dateTo   = url.searchParams.get('date_to')   || null;
        const entries  = await getLogsExport(env.DB, { tool: TOOL_NAME, employee, search, dateFrom, dateTo });
        return json({ ok: true, entries }, 200, request);
      }
      // ──────────────────────────────────────────────────────────

      return json({ error: 'Unknown action' }, 404, request);

    } catch (err) {
      return json({ error: err.message }, 500, request);
    }
  },
};
