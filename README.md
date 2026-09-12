<div dir="rtl" style="text-align: right;">

# Treasury-COD — تسجيل الخزنة

![version](https://img.shields.io/badge/version-v2.0.0-blue)

أداة داخلية لـ EcomModa: تسجيل مبالغ التحصيل (COD) على أوردرات Shopify،
مع سجل كامل في D1 ولوحة تحليلات للمُودَع والمعلّق.

| القطعة | الرابط |
|---|---|
| الواجهة | https://ecommoda-dev.github.io/Treasury-COD/ |
| الـ Worker | https://treasury-cod-worker.ecommoda-dev.workers.dev |

| الملف | إيه هو |
|---|---|
| `index.js` | الـ Cloudflare Worker (v2.4.0) |
| `index.html` | الواجهة (v3.0.0) — ملف واحد، GitHub Pages |
| `wrangler.toml` | إعدادات الـ Worker (D1 binding + `[vars]`) |
| `CLAUDE.md` | مرجع الأداة الكامل: الفخاخ · خط الأساس · بصمة المهارات |

## الاستخدام السريع

1. افتح الواجهة، وحط الـ **Worker Secret** من زرار الإعدادات (الرابط ثابت في الكود).
2. سجّل دخولك بالـ PIN.
3. الزق الأوردرات والمبالغ (نص أو ملف Excel) → **معاينة** → **تسجيل**.

## النشر

النشر أوتوماتيك: أي `push` على `main` بيبني وينشر الـ Worker عبر Workers Builds،
وينشر الواجهة عبر GitHub Pages. **ممنوع اللصق في داشبورد Cloudflare بعد الربط.**

⚠️ أي تغيير في **Secrets** بيتعمل من الداشبورد، **ولازم Promote بعده** — من غيره
الـ Worker بيفضل شغّال على النسخة القديمة والقيمة `undefined`.

آخر تحديث: 12-09-2026 — 15:10

</div>
