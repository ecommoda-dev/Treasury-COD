# Treasury-COD — تسجيل الخزنة

أداة داخلية لـ EcomModa: تسجيل مبالغ التحصيل (COD) على أوردرات Shopify،
مع سجل كامل في D1 ولوحة تحليلات للمُودَع والمعلّق.

| القطعة | الرابط |
|---|---|
| الواجهة | https://ecommoda-dev.github.io/Treasury-COD/ |
| الـ Worker | https://treasury-cod-worker.ecommoda-dev.workers.dev |

## البنية

```
index.js       ← كود الـ Worker (v2.3.0)
wrangler.toml  ← الاسم + D1 binding + vars
index.html     ← الواجهة (v2.4.0)
Index.html     ← صفحة تحويل فقط
CLAUDE.md      ← قواعد الأداة والفخاخ ومسائلها المفتوحة
```

النشر أوتوماتيك: أي `push` على `main` بيبني وينشر الـ Worker عبر Workers Builds،
وينشر الواجهة عبر GitHub Pages. **ممنوع اللصق في داشبورد Cloudflare بعد الربط.**
