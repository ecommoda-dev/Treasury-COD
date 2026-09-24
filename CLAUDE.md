<div dir="rtl" style="text-align: right;">

# تسجيل الخزنة — COD (`Treasury-COD`)

![version](https://img.shields.io/badge/version-v2.0.0-blue)

**بتعمل إيه:** الموظف بيسجّل مبالغ التحصيل (COD) على الأوردرات، فتتكتب على
ميتافيلدات Shopify وتتسجّل في D1، مع لوحة تحليلات للمُودَع والمعلّق.
**مين بيستخدمها:** حسابات · إدارة
**الإصدار:** Worker `v2.4.0` · الواجهة `v3.0.0`   ← الاتنين مستقلين، طبيعي يختلفوا

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
| `get_logs` / `get_logs_count` / `get_logs_export` | سجل العمليات (فلاتر قوايم + ترتيب + `cap/total/truncated`) |
| `get_config` | نسخة الـ Worker — الواجهة بتقارنها بـ `MIN_WORKER_VERSION` |
| `diag` | فحص ذاتي بدون أي كتابة (bindings · صلاحيات · D1 · التوقيت · الحدود) |

## D1

```
tool  : treasury
type  : deposit · login · logout
extra.result : success · warning · error      ← من Worker v2.4.0 (constants §12)
```

⚠️ الصفوف الأقدم من Worker v2.4.0 `extra.result` بتاعتها `NULL` — **مش معناها فشل**،
معناها إن الأداة وقتها مكانتش بتسجّل النتيجة. الواجهة بتعرضها «—» مش «✓».

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
| Var بيرمي/بيفشل لو غاب | `SHOP_DOMAIN` (بيتفحص في `assertEnv` من v2.4.0، ورسالة الخطأ بتسمّيه) |
| 🔴 Var ليه fallback | **لا شيء** — الأداة دي مالهاش أي `env.X \|\| default`، فمفيش خطر «أرقام غلط بصمت» |

## CORS

`ALLOWED_ORIGINS` صارمة (`https://ecommoda-dev.github.io` بس) — لأن الأداة
**مالية وكتابة**، مش قراءة. أي origin تاني بيترد عليه بأول قيمة في القائمة.

## خط الأساس

> من D1 يوم 06-09-2026 (أحمد ماداش خط أساس، فاتّخذ من السجل — §0-ب).

```sql
SELECT type, json_extract(extra,'$.result') AS result, COUNT(*) AS n, COUNT(DISTINCT order_name) AS orders, COALESCE(SUM(delta),0) AS total FROM logs WHERE tool='treasury' GROUP BY type, result ORDER BY n DESC;
```

```
deposit : 874 عملية · 844 أوردر · مجموع 2,166,097 · آخر صف 2026-05-23T16:46Z
login   : 17 صف · آخر صف 2026-08-01T07:26Z
```

🔴 **الاستعلام اللي بيعدّ `type` لوحده بيقيس المحاولات مش الكتابة المؤكَّدة**
(`ecommoda-worker-builder` Step 5A ⑭). أرقام المُودَع الصحيحة لازم تستثني
الصفوف الفاشلة والتعويضية:

```sql
SELECT COUNT(*) AS ops, COUNT(DISTINCT order_name) AS orders, COALESCE(SUM(delta),0) AS total FROM logs WHERE tool='treasury' AND type='deposit' AND (notes IS NULL OR notes NOT LIKE 'SHOPIFY_WRITE_FAILED%') AND (json_extract(extra,'$.result') IS NULL OR json_extract(extra,'$.result') NOT IN ('error','rejected'));
```

⚠️ **بند ١٠ في قائمة التحقق مفتوح بوعي:** مفيش خط أساس من داخل الأداة نفسها
(أرقام شاشة) — المقارنة على الاستعلامات دي بس.

## فخاخ الأداة دي

- **الواجهة اللي كانت اسمها `Index.html` كانت v2.0.0 — نسخة قديمة مالهاش تاب
  التحليلات أصلاً.** أحدث واجهة كانت في `2.4.html`. النقل خد **`2.4.html`**
  كواجهة رسمية، مش `Index.html`. (خالف الافتراض الحرفي في سكيل النقل §4-ح.)
- **الترتيب في `bulkRegister` مقصود:** D1 بيتكتب **قبل** Shopify. ولو كتابة
  Shopify فشلت بيحصل حاجتين مع بعض من v2.4.0: صف تعويضي بـ `notes` بيبدأ بـ
  `SHOPIFY_WRITE_FAILED`، **والصف الأصلي بيتوسم** `extra.result='error'`.
  🔴 **قبل v2.4.0 الصف الأصلي مكانش بيتوسم**، فاستثناء الصف التعويضي لوحده كان
  بيخلّي المجموع **أعلى من الحقيقة** بمقدار كل عملية فشلت. الصفوف القديمة دي
  محتاجة مراجعة يدوية:

  ```sql
  SELECT a.timestamp, a.order_name, a.delta, a.employee FROM logs a WHERE a.tool='treasury' AND a.type='deposit' AND json_extract(a.extra,'$.result') IS NULL AND (a.notes IS NULL OR a.notes NOT LIKE 'SHOPIFY_WRITE_FAILED%') AND EXISTS (SELECT 1 FROM logs c WHERE c.tool='treasury' AND c.order_name=a.order_name AND c.notes LIKE 'SHOPIFY_WRITE_FAILED%' AND c.delta = -a.delta AND c.timestamp >= a.timestamp) ORDER BY a.timestamp DESC;
  ```

- **`PENDING_START_DATE = '2026-05-01'`** حد أدنى صلب للأوردرات المعلّقة — أي
  أوردر أقدم من كده مش بيتحسب معلّق مهما كان.
- **`WARNING_BLOCK_THRESHOLD = 0.10`** — فرق أكبر من ١٠٪ بيوقف التسجيل لحد ما
  يتبعت `overrideWarning: true`.
- **سلسلة السقوف التلاتة:** الواجهة `CHUNK = 10` (وقت) · الـ Worker
  `MAX_BATCH = 200` (حارس لصق) · `ORDERS_PER_WAVE = 10` (تزامن). ولا رقم منهم
  يتغيّر لوحده.
- **سحب أوردرات التحليلات بيقف عند ٢٠ صفحة** لكل حالة مالية (٥٠٠٠ أوردر) —
  وبيرجّع `shopifyTruncated` والواجهة بتعرض تحذير. قبل v2.4.0 كان بيقص في صمت.

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
| ecommoda-worker-builder | v3.7.0 |
| ecommoda-html-builder | v7.1.0 |
| ecommoda-constants | v3.1.0 |
| ecommoda-order-lifecycle | v1.3.0 |
| shopify-graphql-helper | v1.0.0 |

آخر مطابقة: 24-09-2026 · `index.js` v2.4.1 · `index.html` v3.0.0
🔴 معلّقة: — لا شيء

## مسائل مفتوحة

- **صفوف الرفض مش بتتسجّل في D1.** أي عنصر بيتوقف **قبل** أي محاولة على شوبيفاي
  (أوردر مش موجود · ملغي · حالة مالية غير مؤهلة · تجاوز حد التحذير) بيرجع
  `status='rejected'` للواجهة **ومابيسيبش صف في D1**. تنفيذ
  `ecommoda-worker-builder` Step 5A ⑭ بالكامل («صف واحد بالظبط لكل عنصر»)
  محتاج `type='rejected'` يتسجّل لأداة الخزنة في `ecommoda-constants §7`
  **قبل** ما الكود يكتبه — Rule 7 بتمنع الكتابة قبل التسجيل.
- **Build watch paths لسه `*`** — أي تعديل في الواجهة لوحده هينشر الـ Worker
  تاني بنفس الكود. التضييق لـ `index.js` + `wrangler.toml` مؤجَّل لحد ما النقل
  يستقر (§13-ب — وامتحانه لازم يكون في الاتجاهين).
- **فلتر التاريخ في السجل بيقارن بيوم UTC المخزّن** (`substr(timestamp,1,10)`)،
  والعرض بتوقيت القاهرة. فرق الساعتين/التلاتة ممكن يحط عملية بالليل في يوم UTC
  اللي بعده — مقبول لفلتر بالأيام، ومكتوب هنا عشان مايتكتشفش كباج بعدين.


آخر تحديث: 12-09-2026 — 15:10

</div>
