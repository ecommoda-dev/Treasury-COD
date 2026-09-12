/**
 * treasury-cod-worker — EcomModa (ecommoda-dev)
 * v2.4.0 — Hardening pass (عقد النداءات + التوقيت + السجل)
 *
 * Changes from v2.3.0:
 *   - [FIX] shopifyGQL بالعقد الكامل (Step 5A ①) — بترمي على ٥ حالات + backoff
 *   - [FIX] حارس WORKER_SECRET الغايب قبل فحص الـ auth (Step 8)
 *   - [FIX] extra.result على كل صف + وسم الصف الأصلي لما كتابة Shopify تفشل
 *           → استعلامات المُودَع مابقتش تعدّ عملية فشلت (كانت بتطلع أعلى من الحقيقة)
 *   - [FIX] توقيت القاهرة محسوب بـ Intl (constants §13) — التجميع اليومي وحدود الفترة
 *   - [FIX] parseInt بحراسة Number.isFinite على limit/offset
 *   - [FIX] writeLog التعويضي مابقاش .catch(()=>{}) — بيرجع logged:false
 *   - [NEW] ?action=diag و ?action=get_config (Step 5A ⑨)
 *   - [NEW] MAX_BATCH + موجات متوازية بدل Promise.all على الدفعة كلها (Step 5A ⑪)
 *   - [NEW] buildLogFilterSQL + logParamsFrom — فلاتر قوايم (employees/types) + ترتيب server-side
 *   - [NEW] get_logs_export بيرجّع { cap, total, truncated } (Standards #30)
 *   - [NEW] legacyResourceId في استعلام التحليلات → orderId في كل صف
 *   - [NEW] truncated على سحب أوردرات التحليلات بدل القصّ الصامت
 *   - [FIX] endpoints السجل مابقتش تحتاج توكن شوبيفاي
 *   - [NEW] status: success | warning | error | rejected في كل نتيجة (Step 5A ④)
 *
 * D1 Schema:
 *   tool:  'treasury'
 *   types: 'deposit' | 'login' | 'logout'
 *   extra.result: success | warning | error   (مفردات constants §12)
 *
 * ⚠️ معلّق بوعي: الصفوف اللي بتتوقف **قبل** أي محاولة على شوبيفاي (أوردر مش
 *    موجود · حالة مالية غير مؤهلة · تجاوز حد التحذير) لسه مابتسيبش صف في D1.
 *    تنفيذ Step 5A ⑭ بالكامل محتاج `type='rejected'` يتسجّل في
 *    `ecommoda-constants §7` لأداة الخزنة الأول — Rule 7 بتمنع الكتابة قبل التسجيل.
 *
 * Shopify Metafields:
 *   treasury_amount       → number_integer
 *   treasury_count        → number_integer
 *   treasury_last_updated → date_time (UTC ISO 8601)
 */
// EcomModa — Treasury-COD (Worker v2.4.0)
// skills: migration-playbook v2.5.0 · worker-builder v3.1.0 · html-builder v7.1.0 · constants v1.8.0 — 12-09-2026

// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════
const TOOL_NAME      = 'treasury';
const WORKER_VERSION = '2.4.0';

const ALLOWED_FINANCIAL_STATUSES = ['PAID', 'PARTIALLY_REFUNDED'];

const WARNING_BLOCK_THRESHOLD = 0.10;

// أقدم تاريخ يُعتبر فيه الأوردر "pending treasury"
const PENDING_START_DATE = '2026-05-01';

// ─── سلسلة السقوف التلاتة — ولا رقم منهم يتقرا لوحده (Step 5A ⑪) ───
// ① الواجهة    CHUNK            = 10   ← وقت: ~0.9 ث/أوردر (نداءين شوبيفاي + نداءين D1) ≈ ٩ ث للنداء
// ② الـ Worker  MAX_BATCH        = 200  ← حارس لصق. كل أوردر = ٢ subrequests لشوبيفاي
//                                         (٤٠٠ إجمالًا — سقف Paid ١٠٬٠٠٠ · Free ٥٠)
// ③ الـ Worker  ORDERS_PER_WAVE  = 10   ← موجة متوازية جوّه النداء الواحد.
//                                         الأداة دي بتسأل عن **أوردر واحد لكل استعلام**
//                                         (`orders(first:1, query:"name:#…")`) مش `nodes(ids:)`،
//                                         فالحد هنا بالتزامن مش بتكلفة النقط.
const MAX_BATCH       = 200;
const ORDERS_PER_WAVE = 10;

// سقف صفحات التحليلات — 20 صفحة × 250 = 5000 أوردر لكل حالة مالية
const ANALYTICS_MAX_PAGES = 20;

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

// ─── §HELPERS::assertEnv ───
// متغير ناقص لازم يوقف العملية برسالة **باسمه** — SHOP_DOMAIN الناقصة بترجّع
// `"error code: 1003" is not valid JSON`، وCLIENT_ID الناقصة بترجّع «فشل الاتصال».
const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
};

function assertEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      if (env[key] === undefined || env[key] === null || String(env[key]).trim() === '') missing.push(key);
    }
  }
  if (!env.DB) missing.push('DB (D1 binding)');
  if (missing.length) {
    throw new Error(
      `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ضِفها من ` +
      `Dashboard → Settings → Variables ثم Promote النسخة. (شغّل ?action=diag)`
    );
  }
}

// ─── §HELPERS::time — توقيت القاهرة يتحسب مايتكتبش ثابت (constants §13) ───
// نفس النسخة بالحرف في الواجهة — نسختين مختلفتين = الشاشة والسجل بيقولوا وقتين
// مختلفين لنفس الصف.
const CAIRO_TZ = 'Africa/Cairo';
const _cairoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAIRO_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function cairoParts(d) {
  const o = {};
  for (const p of _cairoFmt.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';        // حارس: بعض المحركات بترجّع 24
  return o;
}
function cairoOffsetMinutes(d) {             // ١٨٠ صيفًا · ١٢٠ شتاءً
  const p = cairoParts(d);
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day,
                              +p.hour, +p.minute, +p.second) - d.getTime()) / 60000);
}
function cairoDate() { const p = cairoParts(new Date()); return `${p.year}-${p.month}-${p.day}`; }

// حدود يوم تقويمي بالقاهرة → UTC. الإزاحة تتقاس عند **ظهر** اليوم لأن التحويل
// بيحصل فجرًا، فقياس منتصف الليل بيقع في الساعة المكرّرة/المفقودة.
function cairoDayBoundsUTC(dateStr) {
  const offMin = cairoOffsetMinutes(new Date(`${dateStr}T12:00:00.000Z`));
  return {
    start: new Date(Date.parse(`${dateStr}T00:00:00.000Z`) - offMin * 60000).toISOString(),
    end:   new Date(Date.parse(`${dateStr}T23:59:59.999Z`) - offMin * 60000).toISOString(),
  };
}
// معدِّل SQLite بيحوّل timestamp المخزّن (UTC) ليوم القاهرة — بيتحسب للفترة
// المطلوبة مش مكتوب ثابت. (فترة بتعدّي تحويل التوقيت بتاخد إزاحة المنتصف —
// فرق ساعة واحدة على أطراف الفترة، مقبول لتجميع يومي ومكتوب عن قصد.)
function cairoSQLModifier(refDateStr) {
  const offMin = cairoOffsetMinutes(new Date(`${refDateStr}T12:00:00.000Z`));
  return `+${offMin} minutes`;
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

const LOG_EXPORT_MAX = 2000;   // سقف التصدير — بيرجع للواجهة كـ `cap`

// بنّاء شرط الفلترة الموحّد — التلات دوال تحته بتستخدمه، فمفيش SQL مكرر يتعتّق
// في واحدة ويسيب التانية. القوايم (employees/types) والمفرد الاتنين مقبولين.
// ⚠️ dateFrom/dateTo بيتقارنوا بـ substr(timestamp,1,10) يعني **UTC**، والعرض
//    بتوقيت القاهرة. فرق الساعتين/التلاتة ممكن يحط عملية بالليل في يوم UTC اللي
//    بعده — مقبول لفلتر بالأيام، **بس مكتوب**.
function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL مباشرةً
//    (ORDER BY مابيقبلش bind). أي قيمة بره القايمة بترجع للافتراضي بدون خطأ.
// ⚠️ المفاتيح لازم تطابق `data-sort-key` في الواجهة **حرفيًا**.
const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee', orderName: 'order_name',
  delta: 'delta', valueBefore: 'value_before', valueAfter: 'value_after',
  result: `json_extract(extra, '$.result')`,
};

function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 🔴 كاسر تعادل إلزامي: من غيره صفوف نفس القيمة بترتيب عشوائي بين الصفحات،
  //    والصف الواحد ممكن يظهر في صفحتين **أو مايظهرش خالص**.
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

// ⚠️ بتقص عند LOG_EXPORT_MAX في السكوت — الـ endpoint **لازم** يرجّع
//    cap/total/truncated معاها (Standards #30).
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  // التصدير والعدّ بيتجاهلوا الترتيب عن قصد — التصدير بياخد ترتيب السيرفر الافتراضي.
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

// بيقرا فلاتر السجل من الـ query string — CSV للقوايم
// (employees=ahmed,sara · types=deposit). الاسم المفرد لسه مقبول للتوافق الرجعي.
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    // dateFrom/dateTo الجديدة، و date_from/date_to القديمة للتوافق الرجعي
    dateFrom:  url.searchParams.get('dateFrom') || url.searchParams.get('date_from') || null,
    dateTo:    url.searchParams.get('dateTo')   || url.searchParams.get('date_to')   || null,
  };
}

// 🔴 parseInt('abc') → NaN → بيوصل D1 كـ bind ويرجّع خطأ غامض. الحراسة إلزامية.
function intParam(url, key, dflt, min, max) {
  const raw = parseInt(url.searchParams.get(key) || String(dflt), 10);
  if (!Number.isFinite(raw)) return dflt;
  return Math.min(Math.max(raw, min), max);
}

// ══════════════════════════════════════════════════════════════
// END SHARED BLOCK
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════════════

async function getAccessToken(env) {
  assertEnv(env, 'shopify');
  let res, text;
  try {
    res = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
      }),
    });
    text = await res.text();
  } catch (e) {
    throw new Error(`OAuth: فشل الاتصال بشوبيفاي — ${e.message}`);
  }
  if (!res.ok) throw new Error(`OAuth: شوبيفاي ردّت HTTP ${res.status} — ${text.slice(0, 180)}`);
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`OAuth: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }
  if (!data.access_token) throw new Error('OAuth: مفيش access_token في رد شوبيفاي — راجع CLIENT_ID/CLIENT_SECRET');
  return data.access_token;
}

// ─── §SHOPIFY::shopifyGQL — العقد الإلزامي (Step 5A ①) ───
// أي فشل بيترمي. مفيش رد بيعدّي وهو فاشل:
//   ① فشل شبكة  ② HTTP status  ③ رد مش JSON  ④ data.errors  ⑤ data فاضية
// ⚠️ ④ هو الخطير: لما ميوتيشن تترفض على مستوى الحقل شوبيفاي بترد
// {"errors":[…],"data":null} — و userErrors بتبقى [] لأن مفيش payload أصلاً.
let lastThrottleStatus = null;   // بيتعرض في ?action=diag — الاقتراب من السقف مابيبانش غير بانفجار دفعة
async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify') {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }

    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    if (data?.extensions?.cost?.throttleStatus) lastThrottleStatus = data.extensions.cost.throttleStatus;

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200 * attempt)); continue;
      }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);
    return data;
  }
  throw lastErr || new Error(`${opName}: فشل غير معروف`);
}

// استعلام التحليلات — transactions: list مباشر (ليس connection) — لا edges/nodes
// legacyResourceId إلزامي: من غيره الواجهة ماتقدرش تعمل لينك لشوبيفاي (Step 5 · Numeric Order ID)
const ANALYTICS_GQL_QUERY = `
  query GetOrdersAnalytics($cursor: String, $q: String!) {
    orders(first: 250, after: $cursor, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        legacyResourceId
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

// تصنيف نوع الأوردر من S2 + returnStatus
// لا علاقة لـ bosta_order_type — جزء من الأوردرات لا يشحن مع بوسطة
function classifyOrderType(s2, returnStatus) {
  if (s2) {
    const up = s2.toUpperCase();
    if (up.includes('EXCHANGE')) return 'استبدال';
    if (up.includes('RETURN') || s2 === 'In-Return' || s2 === 'Returned') return 'استرجاع';
    if (returnStatus === 'RETURNED' || returnStatus === 'IN_PROGRESS') return 'استرجاع';
    return 'استبدال';
  }
  if (returnStatus === 'RETURNED' || returnStatus === 'IN_PROGRESS') return 'استرجاع';
  return 'أساسي'; // NO_RETURN أو null
}

// تاريخ التحصيل من transactions — أحدث SALE ناجح على Cash on Delivery
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

// جلب أوردرات Shopify للتحليلات (pagination كاملة)
// ⚠️ بيرجّع `truncated` — القصّ الصامت عند السقف كان بيدّي قايمة معلّق ناقصة
//    والشاشة بتقول الرقم بثقة.
async function fetchShopifyOrdersForAnalytics(env, token, fromDate, toDate) {
  const allOrders = [];
  let truncated = false;

  for (const status of ['paid', 'partially_refunded']) {
    let cursor  = null;
    let hasNext = true;
    let pages   = 0;
    const q = `financial_status:${status} created_at:>=${fromDate} created_at:<=${toDate}`;

    while (hasNext && pages < ANALYTICS_MAX_PAGES) {
      const data = await shopifyGQL(env, token, ANALYTICS_GQL_QUERY, { cursor, q }, `analytics:${status}`);
      const conn = data?.data?.orders;
      if (!conn) break;

      for (const node of conn.nodes) allOrders.push(node);
      hasNext = conn.pageInfo.hasNextPage;
      cursor  = conn.pageInfo.endCursor;
      pages++;
    }
    if (hasNext) truncated = true;   // وقفنا على السقف مش على آخر صفحة
  }

  return { orders: allOrders, truncated, cap: ANALYTICS_MAX_PAGES * 250 };
}

// ══════════════════════════════════════════════════════════════
// §TREASURY — Core Logic
// ══════════════════════════════════════════════════════════════

// شرط «الصف ده كتابة مؤكَّدة» — يُستخدم في **كل** استعلام بيعدّ المُودَع.
//   ① الصف التعويضي نفسه (notes بتبدأ بـ SHOPIFY_WRITE_FAILED)
//   ② الصف الأصلي اللي اتوسم error بعد فشل الكتابة على شوبيفاي (من v2.4.0)
// الصفوف الأقدم من v2.4.0 `result` بتاعتها NULL — بتعدّي عادي عشان خط الأساس
// مايتغيّرش، والأصلي القديم لعملية فاشلة لسه محتاج مراجعة يدوية (السطر في CLAUDE.md).
const DEPOSIT_CONFIRMED_SQL = `
      AND (notes IS NULL OR notes NOT LIKE 'SHOPIFY_WRITE_FAILED%')
      AND (json_extract(extra,'$.result') IS NULL
           OR json_extract(extra,'$.result') NOT IN ('error','rejected'))`;

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
  const data   = await shopifyGQL(env, token, query, { q: `name:#${cleanName}` }, 'getOrderData');
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
  let data;
  try {
    // ① الفحص العلوي جوّه shopifyGQL — بترمي
    data = await shopifyGQL(env, token, mutation, {
      metafields: [
        { ownerId: owner, namespace: 'custom', key: 'treasury_amount',       type: 'number_integer', value: String(amount) },
        { ownerId: owner, namespace: 'custom', key: 'treasury_count',        type: 'number_integer', value: String(count)  },
        { ownerId: owner, namespace: 'custom', key: 'treasury_last_updated', type: 'date_time',      value: isoTs          },
      ],
    }, 'metafieldsSet');
  } catch (e) {
    return { success: false, error: e.message };
  }
  const payload = data?.data?.metafieldsSet;
  // ② userErrors
  if (payload?.userErrors?.length)
    return { success: false, error: payload.userErrors.map(e => e.message).join(', ') };
  // ③ تأكيد الـ payload — userErrors فاضية معناها «مفيش اعتراض» مش «اتنفّذت»
  if (payload?.metafields?.length === 3)
    return { success: true, written: payload.metafields.length };
  return {
    success: false,
    error: `شوبيفاي ما أكدتش الكتابة — رجّعت ${payload?.metafields?.length ?? 0} ميتافيلد من ٣`,
  };
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
      ${DEPOSIT_CONFIRMED_SQL}
  `).bind(orderName).first();
  if (row?.total == null) return null;
  return Number(row.total);
}

// وسم الصف الأصلي بعد فشل الكتابة على شوبيفاي — من غيره الصف بيفضل محسوب في
// كل استعلام مُودَع، فالمجموع بيطلع **أعلى من الحقيقة**.
async function markDepositFailed(db, orderName, isoTs, reason) {
  await db.prepare(`
    UPDATE logs
       SET extra = json_set(COALESCE(extra,'{}'), '$.result', 'error',
                            '$.shopifyError', ?),
           notes = COALESCE(notes || ' | ', '') || 'SHOPIFY_WRITE_FAILED (وسم لاحق)'
     WHERE tool = 'treasury' AND type = 'deposit'
       AND order_name = ? AND timestamp = ?
  `).bind(String(reason).slice(0, 300), orderName, isoTs).run();
}

function mkError(rawName, delta, error, d = null, status = 'rejected') {
  return {
    success:   false,
    status,                       // rejected = اتوقف قبل أي محاولة · error = حاولنا وفشلنا
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
      status:                (warningMessage || reconciliationWarning) ? 'warning' : 'success',
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
    // الاستعلام نفسه فشل — «تعذّر الاستعلام» ≠ «غير موجود»
    return { ...mkError(name, rawDelta, err.message, null, 'error'), queryFailed: true };
  }
}

async function registerEntry(env, token, rawName, rawDelta, employee, clientMeta = {}, overrideWarning = false) {
  const name = String(rawName).replace(/^#/, '').trim();
  try {
    const parsedDelta = parseInt(rawDelta, 10);
    if (isNaN(parsedDelta) || parsedDelta === 0)
      return mkError(name, rawDelta, 'مبلغ غير صالح (لا يمكن أن يكون صفراً)');

    // ⑩ ① كل تحقق ممكن يتعمل — يتعمل **قبل** أي كتابة
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
    const actions   = [];   // ⑤ بتتملي أول بأول — مش بترجع في الآخر

    // الترتيب مقصود: D1 الأول، بعدين Shopify. لو Shopify فشلت بيتكتب صف تعويضي
    // **والصف الأصلي بيتوسم** — الاتنين مع بعض، وإلا الأرقام بتطلع أعلى من الحقيقة.
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
          result:            notesArr.length ? 'warning' : 'success',
          operationCount:    newCount,
          totalPrice:        d.totalPrice,
          financialStatus:   d.financialStatus,
          overrideWarning:   overrideWarning || false,
          ip:                clientMeta.ip        || null,
          userAgent:         clientMeta.userAgent || null,
        },
      });
      actions.push('d1Write');
    } catch (d1Err) {
      return mkError(name, parsedDelta, `فشل تسجيل السجل (D1): ${d1Err.message}`, d, 'error');
    }

    const metaRes = await setTreasuryMetafields(env, token, d.numericId, newAmount, newCount, nowIso);
    if (!metaRes.success) {
      // ⑦ فشل D1 هنا لازم يبان — .catch(()=>{}) كان بيضيّع **بالظبط** أهم صف
      let logged = true, logError = null;
      try {
        await markDepositFailed(env.DB, d.orderName, nowIso, metaRes.error);
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
          extra:       { result: 'error', compensating: true, originalError: metaRes.error, ip: clientMeta.ip || null },
        });
      } catch (e) { logged = false; logError = e.message; }
      return {
        ...mkError(name, parsedDelta, `فشل الكتابة على Shopify: ${metaRes.error}`, d, 'error'),
        actions, logged, logError,
      };
    }
    actions.push('metafieldsSet×3');

    return {
      success:               true,
      status:                notesArr.length ? 'warning' : 'success',
      logged:                true,
      actions,
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
    return mkError(name, rawDelta, err.message, null, 'error');
  }
}

// موجات متوازية بدل Promise.all على الدفعة كلها — بتحافظ على **ترتيب المدخلات**
// (عقد ⑬ تحت) وبتحد التزامن على شوبيفاي.
async function runInWaves(items, size, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const res   = await Promise.all(slice.map((it, k) => fn(it, i + k)));
    res.forEach((r, k) => { out[i + k] = r; });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    // ALWAYS first: CORS preflight
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });

    // 🔴 حارس السر الغايب — قبل فحص الـ auth بالظبط.
    // من غيره القالب بينتج السلسلة الحرفية "Bearer undefined"، فأي طلب بالهيدر
    // ده **بيعدّي** — الحماية بتتشال بدل ما تتشدّد (سر اتضاف من غير Promote).
    if (typeof env.WORKER_SECRET !== 'string' || !env.WORKER_SECRET.trim())
      return json({ ok: false, error: 'WORKER_SECRET غير مضبوط على الـ Worker', step: 'env' }, 500, request);

    // ALWAYS second: WORKER_SECRET check
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: getCORS(request),
      });

    try {

      // ─── §CONFIG ──────────────────────────────────────────────
      // الواجهة بتقارن النسخة دي بـ MIN_WORKER_VERSION عندها — بيكشف Promote
      // ناقص أو rollback أو Worker شبح.
      if (action === 'get_config') {
        return json({
          ok: true,
          version:          WORKER_VERSION,
          tool:             TOOL_NAME,
          logExportCap:     LOG_EXPORT_MAX,
          maxBatch:         MAX_BATCH,
          pendingStartDate: PENDING_START_DATE,
          warningThreshold: WARNING_BLOCK_THRESHOLD,
        }, 200, request);
      }

      // ─── §DIAG — فحص ذاتي بدون أي كتابة ───────────────────────
      // ⚠️ ممنوع يعرض قيمة أي سر — الأسماء والأطوال بس.
      if (action === 'diag') {
        const checks = [];
        const push = (ok, label, detail) => checks.push({ ok, label, detail: String(detail ?? '') });

        // ① أسماء الـ bindings وأطوال الأسرار (بتكشف المسافة المخفية في الاسم)
        const envKeys = Object.keys(env).sort();
        push(true, 'env bindings', envKeys.join(' · '));
        for (const k of ['WORKER_SECRET', 'CLIENT_ID', 'CLIENT_SECRET']) {
          const v = env[k];
          push(typeof v === 'string' && v.trim().length > 0, `secret: ${k}`,
               typeof v === 'string' ? `موجود — الطول ${v.length}` : 'غايب');
        }
        push(!!env.SHOP_DOMAIN, 'var: SHOP_DOMAIN', env.SHOP_DOMAIN || 'غايبة — هترجّع "error code: 1003"');
        push(!!env.DB, 'binding: DB (D1)', env.DB ? 'موجود' : 'غايب');

        // ② D1
        try {
          const row = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM logs WHERE tool = ? AND type = 'deposit'`
          ).bind(TOOL_NAME).first();
          push(true, 'D1: قراءة', `صفوف deposit: ${row?.n ?? 0}`);
        } catch (e) { push(false, 'D1: قراءة', e.message); }

        // ③ Shopify OAuth + الصلاحيات + تكلفة الاستعلام
        let token = null;
        try {
          token = await getAccessToken(env);
          push(true, 'Shopify: OAuth', `توكن طوله ${token.length}`);
        } catch (e) { push(false, 'Shopify: OAuth', e.message); }

        if (token) {
          try {
            const d = await shopifyGQL(env, token,
              `{ currentAppInstallation { accessScopes { handle } } shop { name } }`, {}, 'diag');
            const scopes = (d?.data?.currentAppInstallation?.accessScopes || []).map(s => s.handle);
            push(true, 'Shopify: المتجر', d?.data?.shop?.name || '—');
            const needed = ['read_orders', 'write_orders'];
            const missing = needed.filter(s => !scopes.includes(s));
            push(missing.length === 0, 'Shopify: الصلاحيات',
                 missing.length ? `ناقصة: ${missing.join(' · ')} | الموجود: ${scopes.join(' · ')}`
                                : scopes.join(' · '));
          } catch (e) { push(false, 'Shopify: الصلاحيات', e.message); }
        }

        if (lastThrottleStatus) {
          push(true, 'Shopify: رصيد الاستعلام',
               `متاح ${lastThrottleStatus.currentlyAvailable} من ${lastThrottleStatus.maximumAvailable}` +
               ` · معدل الاسترجاع ${lastThrottleStatus.restoreRate}/ث`);
        }

        // ④ ثوابت ليها أثر تشغيلي مباشر
        push(true, 'حدود التشغيل',
             `MAX_BATCH=${MAX_BATCH} · ORDERS_PER_WAVE=${ORDERS_PER_WAVE} · ` +
             `LOG_EXPORT_MAX=${LOG_EXPORT_MAX} · تحذير>${WARNING_BLOCK_THRESHOLD * 100}%`);
        push(true, 'التوقيت',
             `القاهرة الآن ${cairoDate()} · الإزاحة ${cairoOffsetMinutes(new Date())} دقيقة (محسوبة بـ Intl)`);
        push(true, 'Origin', request.headers.get('Origin') || '— (نداء مباشر)');

        return json({ ok: checks.every(c => c.ok), version: WORKER_VERSION, checks }, 200, request);
      }

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

      // ─── §LOG-ENDPOINTS — D1 بس، مفيش توكن شوبيفاي ────────────
      // (كان الـ token بيتجاب قبلهم، فعطل شوبيفاي كان بيكسر تاب السجل كله)
      if (action === 'get_logs') {
        const p       = logParamsFrom(url, TOOL_NAME);
        const limit   = intParam(url, 'limit',  100, 1, 100);
        const offset  = intParam(url, 'offset', 0,   0, 10_000_000);
        const sortBy  = url.searchParams.get('sortBy');
        const sortDir = url.searchParams.get('sortDir');
        const entries = await getLogs(env.DB, { ...p, limit, offset, sortBy, sortDir });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total }, 200, request);
      }

      // 🔴 العقد: entries **مع** cap/total/truncated — من غيرهم الواجهة بتقول
      //    «تم تصدير ٢٠٠٠ عملية ✓» على ملف ناقص.
      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),          // نفس الفلاتر بالظبط
        ]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total,
                      truncated: total > LOG_EXPORT_MAX }, 200, request);
      }
      // ──────────────────────────────────────────────────────────

      // كل اللي تحت محتاج شوبيفاي
      const token = await getAccessToken(env);

      const clientMeta = {
        ip:        request.headers.get('CF-Connecting-IP') || null,
        userAgent: request.headers.get('User-Agent')       || null,
      };

      // ─── §TREASURY ────────────────────────────────────────────
      // 🔴 عقد الترتيب (Step 5A ⑬): نتيجة واحدة لكل عنصر في `entries`،
      //    **بنفس الترتيب**، في كل الفروع. الواجهة بتطابق **بالفهرس**.
      if (action === 'bulkPreview') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { entries } = await request.json().catch(() => ({}));
        if (!Array.isArray(entries) || !entries.length)
          return json({ error: 'entries array is required' }, 400, request);
        if (entries.length > MAX_BATCH)
          return json({ error: `الدفعة أكبر من الحد (${entries.length} من ${MAX_BATCH}) — قسّمها` }, 400, request);

        const results = await runInWaves(entries, ORDERS_PER_WAVE,
          e => previewEntry(env, token, e.orderName, e.delta));
        return json({ success: true, results }, 200, request);
      }

      if (action === 'bulkRegister') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { entries, employee, overrideWarning = false } = await request.json().catch(() => ({}));

        if (!Array.isArray(entries) || !entries.length)
          return json({ error: 'entries array is required' }, 400, request);
        if (entries.length > MAX_BATCH)
          return json({ error: `الدفعة أكبر من الحد (${entries.length} من ${MAX_BATCH}) — قسّمها` }, 400, request);

        if (!employee || !String(employee).trim())
          return json({ error: 'employee مطلوب لتسجيل الخزينة' }, 400, request);

        // ⑫ حارس التكرار بالكيان (الأوردر) — الواجهة بتنضّف كمان قبل التقسيم،
        //    لأن الحارس ده بيشتغل **لكل نداء** فمجموعتين = حارسين مستقلين.
        const names      = entries.map(e => String(e.orderName).replace(/^#/, '').trim().toUpperCase());
        const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
        if (duplicates.length)
          return json({
            error: `أوردرات مكررة في نفس الـ batch: ${[...new Set(duplicates)].join(', ')}`,
          }, 400, request);

        const results = await runInWaves(entries, ORDERS_PER_WAVE,
          e => registerEntry(env, token, e.orderName, e.delta, employee, clientMeta, overrideWarning));
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
        let shopifyError   = null;
        try {
          const d = await fetchOrderData(env, token, cleanName);
          if (d && !d.cancelled) {
            currentShopify = {
              orderId:         d.numericId,
              treasuryAmount:  d.treasuryAmount,
              treasuryCount:   d.treasuryCount,
              financialStatus: d.financialStatus,
              totalPrice:      d.totalPrice,
              lastUpdated:     d.treasuryLastUpdated,
            };
          }
        } catch (e) {
          // «تعذّر الاستعلام» ≠ «غير موجود» — الواجهة بتعرضه كبانر
          shopifyError = e.message;
        }

        if (!results?.length && !currentShopify && !shopifyError)
          return json({ success: false, notFound: true }, 200, request);

        const entries = (results || []).map(row => {
          let extra = {};
          try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
          return {
            registeredAt:      row.timestamp,
            employee:          row.employee,
            orderId:           row.order_id || null,
            delta:             row.delta,
            previousAmount:    row.value_before,
            newAmount:         row.value_after,
            result:            extra.result || null,   // null = صف أقدم من v2.4.0 (مش معناه فشل)
            operationCount:    extra.operationCount  || 0,
            totalPrice:        extra.totalPrice      || null,
            financialStatus:   extra.financialStatus || null,
            validationWarning: extra.compensating ? null : (row.notes || null),
            compensatingEntry: extra.compensating    || false,
            failedEntry:       extra.result === 'error',
            overrideWarning:   extra.overrideWarning || false,
            ip:                extra.ip              || null,
          };
        });

        // الصف الفاشل والتعويضي الاتنين بيتشالوا من المجموع — زي استعلامات D1 بالظبط
        const confirmedEntries     = entries.filter(e => !e.compensatingEntry && !e.failedEntry);
        const d1Sum                = confirmedEntries.reduce((acc, e) => acc + (e.delta || 0), 0);
        const shopifyAmount        = currentShopify?.treasuryAmount ?? null;
        const hasReconciliationGap = shopifyAmount !== null ? d1Sum !== shopifyAmount : false;

        return json({
          success:      true,
          orderName:    orderNameKey,
          orderId:      currentShopify?.orderId || entries.find(e => e.orderId)?.orderId || null,
          entries,
          currentShopify,
          shopifyError,
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
        // 1. الفترة — بتوقيت القاهرة، مش UTC
        const today     = cairoDate();
        const dateFrom  = (url.searchParams.get('dateFrom') || url.searchParams.get('date_from') || PENDING_START_DATE);
        const dateTo    = (url.searchParams.get('dateTo')   || url.searchParams.get('date_to')   || today);

        // pending: الحد الأدنى = max(dateFrom, PENDING_START_DATE)
        const pendingFrom = dateFrom > PENDING_START_DATE ? dateFrom : PENDING_START_DATE;
        const pendingTo   = dateTo;

        // 2. حدود الفترة بتوقيت القاهرة → UTC (الصفوف مخزّنة UTC)
        const d1From = cairoDayBoundsUTC(dateFrom).start;
        const d1To   = cairoDayBoundsUTC(dateTo).end;
        // معدِّل تحويل الـ timestamp ليوم القاهرة في التجميع اليومي
        const dayMod = cairoSQLModifier(dateTo);

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
              ${DEPOSIT_CONFIRMED_SQL}
              AND timestamp >= ? AND timestamp <= ?
          `).bind(d1From, d1To).first(),

          // Q2: Daily breakdown — اليوم بتوقيت القاهرة
          env.DB.prepare(`
            SELECT
              DATE(timestamp, ?)         AS day,
              SUM(delta)                 AS amount,
              COUNT(*)                   AS ops,
              COUNT(DISTINCT order_name) AS orders
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              ${DEPOSIT_CONFIRMED_SQL}
              AND timestamp >= ? AND timestamp <= ?
            GROUP BY DATE(timestamp, ?)
            ORDER BY day ASC
          `).bind(dayMod, d1From, d1To, dayMod).all(),

          // Q3: Validation Warnings (صف اتكتب وفيه تنبيه — مش فشل)
          env.DB.prepare(`
            SELECT order_name, order_id, employee, timestamp, delta, value_before, value_after, notes, extra
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND notes IS NOT NULL
              ${DEPOSIT_CONFIRMED_SQL}
              AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp DESC
          `).bind(d1From, d1To).all(),

          // Q4: Repeat Registrations (same order > 1 deposit)
          env.DB.prepare(`
            SELECT order_name, COUNT(*) AS cnt, SUM(delta) AS total
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              ${DEPOSIT_CONFIRMED_SQL}
              AND timestamp >= ? AND timestamp <= ?
            GROUP BY order_name
            HAVING cnt > 1
            ORDER BY cnt DESC
          `).bind(d1From, d1To).all(),

          // Q5: Override Approvals
          env.DB.prepare(`
            SELECT order_name, order_id, employee, timestamp, delta, notes, extra
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND extra LIKE '%"overrideWarning":true%'
              ${DEPOSIT_CONFIRMED_SQL}
              AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp DESC
          `).bind(d1From, d1To).all(),

          // Q6: Shopify Write Failures — الصف التعويضي (واحد لكل فشل)
          env.DB.prepare(`
            SELECT order_name, order_id, employee, timestamp, delta, notes
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              AND notes LIKE 'SHOPIFY_WRITE_FAILED%'
              AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp DESC
          `).bind(d1From, d1To).all(),

          // Q7: Per-order totals (for Shopify enrichment join)
          env.DB.prepare(`
            SELECT order_name, SUM(delta) AS total_deposited, COUNT(*) AS ops
            FROM logs
            WHERE tool = 'treasury' AND type = 'deposit'
              ${DEPOSIT_CONFIRMED_SQL}
              AND timestamp >= ? AND timestamp <= ?
            GROUP BY order_name
          `).bind(d1From, d1To).all(),
        ]);

        const orderTotals    = {};
        const depositedNames = new Set();
        for (const row of (orderTotalsRes.results || [])) {
          orderTotals[row.order_name] = row.total_deposited;
          depositedNames.add(row.order_name);
        }

        // 3. Shopify — القايمة دي مصدر «المعلّق» و«الإثراء»
        let shopifyOrders    = [];
        let shopifyError     = null;
        let shopifyTruncated = false;
        let shopifyCap       = null;
        try {
          const r = await fetchShopifyOrdersForAnalytics(env, token, pendingFrom, pendingTo);
          shopifyOrders    = r.orders;
          shopifyTruncated = r.truncated;
          shopifyCap       = r.cap;
        } catch (err) {
          shopifyError = err.message;
        }

        // 4. معالجة أوردرات شوبيفاي
        const pending  = [];
        const enriched = [];

        for (const o of shopifyOrders) {
          const tCount         = parseInt(o.treasury_count?.value || '0', 10);
          const totalPrice     = parseFloat(o.totalPriceSet?.shopMoney?.amount || '0');
          const collectionDate = extractCODPaymentDate(o.transactions, o.createdAt);
          const daysSince      = Math.max(0, Math.floor((Date.now() - new Date(collectionDate)) / 86400000));
          const orderType      = classifyOrderType(o.s2?.value, o.returnStatus);
          const courier        = o.courier?.value || 'غير محدد';

          const entry = {
            name:            o.name,
            orderId:         o.legacyResourceId || null,   // للـ hyperlink في الواجهة
            createdAt:       o.createdAt,
            collectionDate,
            daysSince,
            totalPrice,
            courier,
            orderType,
            financialStatus: o.displayFinancialStatus,
          };

          if (tCount === 0) pending.push(entry);
          if (depositedNames.has(o.name)) enriched.push(entry);
        }

        // 5. byCourier
        const courierMap       = {};
        const pendingByCourier = {};

        for (const o of enriched) {
          const deposited = orderTotals[o.name] || 0;
          if (!courierMap[o.courier]) courierMap[o.courier] = { deposited: 0, orders: 0 };
          courierMap[o.courier].deposited += deposited;
          courierMap[o.courier].orders++;
        }
        for (const o of pending) {
          if (!pendingByCourier[o.courier]) pendingByCourier[o.courier] = { count: 0, amount: 0 };
          pendingByCourier[o.courier].count++;
          pendingByCourier[o.courier].amount += o.totalPrice;
        }

        const allCouriers = new Set([...Object.keys(courierMap), ...Object.keys(pendingByCourier)]);
        const byCourier = Array.from(allCouriers).map(c => ({
          courier:         c,
          deposited:       courierMap[c]?.deposited || 0,
          depositedOrders: courierMap[c]?.orders    || 0,
          pendingCount:    pendingByCourier[c]?.count  || 0,
          pendingAmount:   pendingByCourier[c]?.amount || 0,
        })).sort((a, b) => b.deposited - a.deposited);

        // 6. byOrderType
        const typeMap       = {};
        const pendingByType = {};

        for (const o of enriched) {
          const deposited = orderTotals[o.name] || 0;
          if (!typeMap[o.orderType]) typeMap[o.orderType] = { deposited: 0, orders: 0 };
          typeMap[o.orderType].deposited += deposited;
          typeMap[o.orderType].orders++;
        }
        for (const o of pending) {
          if (!pendingByType[o.orderType]) pendingByType[o.orderType] = { count: 0, amount: 0 };
          pendingByType[o.orderType].count++;
          pendingByType[o.orderType].amount += o.totalPrice;
        }

        const allTypes = new Set([...Object.keys(typeMap), ...Object.keys(pendingByType)]);
        const byOrderType = Array.from(allTypes).map(t => ({
          orderType:       t,
          deposited:       typeMap[t]?.deposited || 0,
          depositedOrders: typeMap[t]?.orders    || 0,
          pendingCount:    pendingByType[t]?.count  || 0,
          pendingAmount:   pendingByType[t]?.amount || 0,
        })).sort((a, b) => b.deposited - a.deposited);

        const parseExtra = row => {
          let extra = {};
          try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
          return { ...row, extra };
        };

        return json({
          ok: true,
          generatedAt: new Date().toISOString(),
          dateRange: { from: dateFrom, to: dateTo, pendingFrom, pendingTo, timezone: CAIRO_TZ },
          summary: {
            totalDeposited:  summaryRow?.total  || 0,
            totalOrders:     summaryRow?.orders || 0,
            totalOperations: summaryRow?.ops    || 0,
            pendingCount:    pending.length,
            pendingAmount:   pending.reduce((s, o) => s + o.totalPrice, 0),
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
          shopifyTruncated,
          shopifyCap,
        }, 200, request);
      }
      // ──────────────────────────────────────────────────────────

      return json({ error: 'Unknown action' }, 404, request);

    } catch (err) {
      return json({ error: err.message }, 500, request);
    }
  },
};
