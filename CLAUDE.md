# تسجيل الخزنة — COD (`Treasury-COD`)

**بتعمل إيه:** الموظف بيسجّل مبالغ التحصيل (COD) على الأوردرات، فتتكتب على
ميتافيلدات Shopify وتتسجّل في D1، مع لوحة تحليلات للمُودَع والمعلّق.
**مين بيستخدمها:** حسابات · إدارة
**الإصدار:** Worker `v2.3.0` · الواجهة `v2.4.0`   ← الاتنين مستقلين، طبيعي يختلفوا

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Treasury-COD/
الـ Worker : https://treasury-cod-worker.ecommoda-dev.workers.dev
اسم الـ Worker في الداشبورد: treasury-cod-worker     ← لازم يطابق name في wrangler.toml
```

## الـ Endpoints

| `?action=` | بيعمل إيه |
|---|---|
| `check_employee` / `register_pin` / `verify_employee` / `log_logout` / `get_employees` | بوابة الدخول المشتركة |
| `bulkPreview` | معاينة دفعة قبل التسجيل — من غير أي كتابة |
| `bulkRegister` | تسجيل الدفعة: D1 الأول، بعدين ميتافيلدات Shopify |
| `getLog` | سجل أوردر واحد + مطابقته مع Shopify |
| `get_analytics` | لوحة التحليلات (D1 مجمّع + إثراء من Shopify) |
| `get_logs` / `get_logs_count` / `get_logs_export` | سجل العمليات |

## D1

```
tool  : treasury
type  : deposit · login · logout
```

## المضبوط فعليًا في الداشبورد

> اللي **متظبط بالفعل** — مش اللي المفروض يكون.

```
Bindings : DB → ecommoda-dev-logs
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET   ← قيمهم مستحيلة القراءة، يدوية دايمًا
Vars     : SHOP_DOMAIN                                 ← من [vars] في wrangler.toml
Build watch paths : * (الافتراضي) — لسه ما اتضيّقتش (§13-ب في سكيل النقل)
```

### تصنيف الـ `env.*` (§4-أ-٢)

| النوع | المتغيّرات |
|---|---|
| Secret — قيمته مستحيلة القراءة | `WORKER_SECRET` · `CLIENT_ID` · `CLIENT_SECRET` |
| Var بيرمي/بيفشل لو غاب | `SHOP_DOMAIN` (بيتحط مباشرة في الـ URL بلا حارس) |
| 🔴 Var ليه fallback | **لا شيء** — الأداة دي مالهاش أي `env.X \|\| default`، فمفيش خطر «أرقام غلط بصمت» |

## CORS

`ALLOWED_ORIGINS` صارمة (`https://ecommoda-dev.github.io` بس) — لأن الأداة
**مالية وكتابة**، مش قراءة. أي origin تاني بيترد عليه بأول قيمة في القائمة.

## خط الأساس قبل النقل

> من D1 يوم 06-09-2026 (أحمد ماداش خط أساس، فاتّخذ من السجل — §0-ب).
> الاستعلام نفسه بعد النقل لازم يدّي نفس الأرقام أو أكبر.

```sql
SELECT type, COUNT(*), COUNT(DISTINCT order_name), COALESCE(SUM(delta),0)
FROM logs WHERE tool='treasury' GROUP BY type;
```

```
deposit : 874 عملية · 844 أوردر · مجموع 2,166,097 · آخر صف 2026-05-23T16:46Z
login   : 17 صف · آخر صف 2026-08-01T07:26Z
```

⚠️ **بند ١٠ في قائمة التحقق مفتوح بوعي:** مفيش خط أساس من داخل الأداة نفسها
(أرقام شاشة) — المقارنة على الاستعلام ده بس.

## فخاخ الأداة دي

- **الواجهة اللي كانت اسمها `Index.html` كانت v2.0.0 — نسخة قديمة مالهاش تاب
  التحليلات أصلاً.** أحدث واجهة كانت في `2.4.html`. النقل خد **`2.4.html`**
  كواجهة رسمية، مش `Index.html`. (خالف الافتراض الحرفي في سكيل النقل §4-ح.)
- **الترتيب في `bulkRegister` مقصود:** D1 بيتكتب **قبل** Shopify، ولو كتابة
  Shopify فشلت بيتكتب صف تعويضي بـ `notes` بيبدأ بـ `SHOPIFY_WRITE_FAILED`.
  أي استعلام على المُودَع لازم يستثني الصفوف دي، وإلا الأرقام بتطلع أعلى من الحقيقة.
- **`PENDING_START_DATE = '2026-05-01'`** حد أدنى صلب للأوردرات المعلّقة — أي
  أوردر أقدم من كده مش بيتحسب معلّق مهما كان.
- **`WARNING_BLOCK_THRESHOLD = 0.10`** — فرق أكبر من ١٠٪ بيوقف التسجيل لحد ما
  يتبعت `overrideWarning: true`.

## استرجاع النسخ القديمة

> ده بديل الـ tags — دفع الـ tags ممنوع من جلسات Claude Code السحابية.

```
النسخ المرقّمة القديمة (Index.html v2.0.0 · 2.3.html · 2.4.html) محفوظة في commit: 973aa70
git show 973aa70:2.4.html
git show 973aa70:2.3.html
git show 973aa70:Index.html
```

**إثبات إن نقل الـ Worker نضيف:** `index.js` اتسحب من Cloudflare بالظبط،
و md5 بتاعه وقت النقل = `2edaf16ce342325a1d4d33ea127f60e7`
(النسخة دي محفوظة في أول commit للنقل، قبل ما تتضاف بصمة المهارات).

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-tool-migration-playbook | v2.5.0 |
| ecommoda-worker-builder | v2.1.0 |
| ecommoda-html-builder | v6.6.0 |
| ecommoda-constants | v1.8.0 |
| ecommoda-order-lifecycle | v1.3.0 |
| shopify-graphql-helper | v1.0.0 |

آخر مطابقة: 06-09-2026 · `index.js` v2.3.0 · `index.html` v2.4.0
🔴 معلّقة: — لا شيء

## مسائل مفتوحة

- **Build watch paths لسه `*`** — أي تعديل في الواجهة لوحده هينشر الـ Worker
  تاني بنفس الكود. التضييق لـ `index.js` + `wrangler.toml` مؤجَّل لحد ما النقل
  يستقر (§13-ب — وامتحانه لازم يكون في الاتجاهين).
- **مفيش `MIN_WORKER_VERSION` في الواجهة** — مفيش حارس توافق بين v2.4.0
  والـ Worker v2.3.0. مش كاسر دلوقتي، بس يتضاف لو الاتنين افترقوا أكتر.
