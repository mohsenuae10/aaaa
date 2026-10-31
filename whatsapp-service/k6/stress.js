// سكربت k6 مُعمَّم — يستخدمه /api/k6-test/start في index.js عبر spawn، بنفس استعلامات
// محرّكَي اللوحة (الخادم STRESS_QUERIES/STREAM_QUERIES والمتصفح CLIENT_*_PATHS) كي تبقى
// السيناريوهات متّسقة بين الأدوات الثلاث. الإعدادات كلّها عبر __ENV (لا تعديل يدوي للملف):
//   SB_URL, SB_KEY, SB_TOKEN (افتراضيًا = SB_KEY), SCENARIO, THINK, STAGES
// التزامن والمدّة يُمرَّران كوسيطَي سطر أوامر (--vus/--duration) من index.js لا من هنا،
// **إلا** في النمط التصاعدي: حينها تُمرَّر STAGES (JSON) وتُهمَل الوسيطتان (k6 يرفض الجمع).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const SB = __ENV.SB_URL;
const KEY = __ENV.SB_KEY;
const TOKEN = __ENV.SB_TOKEN || KEY;
const SCENARIO = __ENV.SCENARIO || 'products';
// زمن «تفكير» الزائر بين الشاشات (سيناريو visitor فقط) — هو ما يجعل «١٠٠٠ زائر» حِملًا واقعيًّا
// لا قرعًا بلا توقّف: زائر حقيقي يقرأ الشاشة ثوانٍ قبل الانتقال.
const THINK = Number(__ENV.THINK || 3);
// النمط التصاعدي: يُبنى **هنا** (مصدر واحد) لا في index.js — فيستعمله مُشغِّل اللوحة ومُشغِّل
// GitHub Actions (.github/workflows/load-test.yml) بلا تكرار منطق قابل للانحراف. في هذا النمط
// لا تُمرَّر --vus/--duration إطلاقًا (k6 يتجاهل stages إن مُرِّرتا) بل VUS/DUR عبر البيئة.
const RAMP = __ENV.RAMP === '1';
const UNTIL_STOP = __ENV.UNTIL_STOP === '1';
const VUS = Math.max(1, Number(__ENV.VUS || 10));
const DUR = Math.max(1, Number(__ENV.DUR || 180));
const RAMP_STEPS = [0.1, 0.25, 0.5, 1];
const UNTIL_STOP_SEC = 86400; // «حتى الإطفاء»: k6 يلزمه حدٌّ ما، والإنهاء بـkill من زرّ الإيقاف
function buildStages() {
  const UP = 15, DOWN = 10;
  const hold = UNTIL_STOP ? 30
    : Math.max(10, Math.round((DUR - RAMP_STEPS.length * UP - DOWN) / RAMP_STEPS.length));
  const st = [];
  for (let i = 0; i < RAMP_STEPS.length; i++) {
    const target = Math.max(1, Math.round(VUS * RAMP_STEPS[i]));
    const last = i === RAMP_STEPS.length - 1;
    st.push({ duration: `${UP}s`, target });
    st.push({ duration: `${UNTIL_STOP && last ? UNTIL_STOP_SEC : hold}s`, target });
  }
  if (!UNTIL_STOP) st.push({ duration: `${DOWN}s`, target: 0 });
  return st;
}
const STAGES = RAMP ? buildStages() : null;
// معرّف `profile.id` لصاحب الجلسة المُستنسخة (يحلّه index.js قبل التشغيل). حين يوجد، تضيف رحلة
// الزائر شاشتَي العميل المسجَّل (حسابي/محفظتي + إشعاراتي) — فيصير الحِمل حِمل زائر **داخل
// حسابه** لا زائر مجهول: استعلامات مفلترة بـRLS على صاحب الصف، وهي الأغلى فعليًّا.
const PID = __ENV.PID || '';
// قراءة تفاصيل الأصناف: بعد قائمة المتجر يفتح الزائر صنفًا فعليًّا — يُقرأ صفّ المنتج كاملًا
// (`select=*`) + صوره. هذا ما يجعل الاختبار يقرأ **المنتجات** لا قائمة مختصرة فقط.
const DETAIL = __ENV.DETAIL === '1';
// قراءة **جدول المنتجات كاملًا** (`select=*` حتى سقف PostgREST) — أثقل قراءة في القاعدة لأن
// سياسات RLS على `products` مكلفة (مُثبَت: count=exact عليه يتجاوز المهلة). ثلاثة أوضاع:
//   'each' = كل زائر يقرؤه في كل رحلة (الأقسى — يضاعف الحِمل) ·
//   'once' = يُقرأ مرّة واحدة في setup بالجلسة المُستنسخة (حِمل مرجعي بلا تضخيم) ·
//   'off'  = لا يُقرأ.
const TABLE = ['each', 'once'].indexOf(__ENV.TABLE) !== -1 ? __ENV.TABLE : 'off';
// قراءة **كل روابط صور المنتجات**: جدول products_image كاملًا (كل الصفحات) لكل زائر في كل رحلة.
// جدول منفصل كبير (~٨٠٠٠ صفّ) وقراءته كاملةً من أثقل القراءات الواقعية (التطبيق يعرض صور القوائم).
const IMAGES = __ENV.IMAGES === '1';
// الجدول «كاملًا» = ترقيم بالإزاحة حتى صفحة أقصر من الحجم (PostgREST يسقف كل طلب بـ١٠٠٠).
// سقف أمان ٢٠٠ صفحة. كل صفحة طلب مستقلّ. (كان قديمًا طلبًا واحدًا بـlimit=1000 فقط.)
const TABLE_PAGE = 1000;
const TABLE_MAX_PAGES = 200;
// base = مسار الجدول مع select (مثل 'products?select=*' أو 'products_image?select=*') فيُضاف إليه limit/offset.
function readFullTable(tag, base) {
  const b = base || 'products?select=*';
  for (let page = 0; page < TABLE_MAX_PAGES; page++) {
    const res = get(`${b}&limit=${TABLE_PAGE}&offset=${page * TABLE_PAGE}`, tag);
    let n = 0;
    try { const arr = res.json(); n = Array.isArray(arr) ? arr.length : 0; } catch (e) { n = 0; }
    if (n < TABLE_PAGE) break; // آخر صفحة أو فشل
  }
}

export const options = STAGES
  ? {
      stages: STAGES,
      // حكم مبدئي يظهر في مخرجات k6 الخام؛ الحكم المعروض في اللوحة يُحسب من المقاييس نفسها
      // (threshold فاشل يُخرج k6 برمز 99 — يعالجه index.js كانتهاء طبيعي لا خطأ).
      thresholds: { http_req_failed: ['rate<0.05'], http_req_duration: ['p(95)<2000'] },
    }
  : {};

const baseHeaders = { apikey: KEY, Authorization: `Bearer ${TOKEN}` };
// count=planned لعدّ الطلبات: رخيص على الأصل (بعكس count=exact) — راجع
// docs memory: products-query-perf-and-concurrency.
const headers = SCENARIO === 'orders_total' ? { ...baseHeaders, Prefer: 'count=planned' } : baseHeaders;

// ===== تصنيف أسباب الفشل =====
// بلا هذا التصنيف يبدو حجب جدار Cloudflare الناري على IP الخادم (403 FW_BLOCKED) كأنّه «القاعدة
// لا تتحمّل» — وهو العكس تمامًا: القاعدة لم تُستفسَر إطلاقًا. راجع ذاكرة
// stress-gb-mode-and-usage-measurement (ثالثة الحواجز).
const rOk = new Counter('r_ok');       // 2xx/3xx
const rWaf = new Counter('r_waf');     // 403 FW_BLOCKED — حجب جدار ناري على IP المُصدِر
const rRate = new Counter('r_rate');   // 429 — حدّ معدّل
const rSrv = new Counter('r_srv');     // 5xx — الأصل متعثّر (هذا وحده «القاعدة لا تتحمّل»)
const rAuth = new Counter('r_auth');   // 4xx أخرى (توثيق/صلاحية/استعلام)
const rNet = new Counter('r_net');     // status 0 — انقطاع/مهلة

function classify(res) {
  const s = res.status;
  const ok = s >= 200 && s < 400;
  if (ok) rOk.add(1);
  else if (s === 0) rNet.add(1);
  else if (s === 403 && String(res.body || '').indexOf('FW_BLOCKED') !== -1) rWaf.add(1);
  else if (s === 429) rRate.add(1);
  else if (s >= 500) rSrv.add(1);
  else rAuth.add(1);
  check(res, { 'status 2xx/3xx': () => ok });
  return ok;
}

function get(path, name, extra) {
  const res = http.get(`${SB}/rest/v1/${path}`, {
    headers: extra ? { ...baseHeaders, ...extra } : baseHeaders,
    tags: { name },
  });
  classify(res);
  return res;
}

function pathFor(scenario) {
  const off = Math.floor(Math.random() * 1500);
  const offBig = Math.floor(Math.random() * 50000);
  switch (scenario) {
    case 'products': return `products?select=id,name_ar,price&limit=5&offset=${off}`;
    case 'products_image': return `products_image?select=product_id,image&limit=5&offset=${off}`;
    case 'stores': return `profile?select=id,name&type=eq.STORE&limit=5&offset=${off}`;
    case 'product_count': return `products?select=id&limit=1`;
    // إجمالي عدد الطلبات: orders محجوب عن غير الأدمن، فالبديل المقروء quick_order.
    case 'orders_total': return `quick_order?select=id&limit=1`;
    // الطلبات النشطة: نفس مسار شاشة «الطلبات النشطة» الاحتياطي بالمفتاح العام.
    case 'active_orders': return `notification?select=*&order=created_at.desc&limit=100&offset=${off}`;
    // أنماط «حجم الجلب» الثقيلة (select=* لتوليد egress حقيقي)
    case 'order_products_gb': return `order_products?select=*&limit=1000&offset=${offBig}`;
    case 'captain_assign_gb': return `captain_assign?select=*&limit=1000&offset=${offBig}`;
    case 'notification_gb': return `notification?select=*&limit=1000&offset=${offBig}`;
    default: return `products?select=id&limit=5&offset=${off}`;
  }
}

// ===== سيناريو «زائر حقيقي» =====
// يُحاكي جلسة زائر واحد في التطبيق بدل قرع استعلام واحد: الشاشة الرئيسية → فتح متجر → السلّة/
// الإشعارات، بزمن تفكير بينها. فـ«١٠٠٠ زائر» هنا = ١٠٠٠ جلسة متزامنة واقعية (≈٥ طلبات لكل
// جلسة على ~3×THINK ثانية)، لا ١٠٠٠ عامل يقرعون بلا توقّف (وهو حِمل أعلى بمئات الأضعاف من
// أي واقع). قائمة المتاجر تُجلب مرة واحدة في setup ويتشاركها كل الزوّار — كما يفعل التطبيق.
export function setup() {
  if (SCENARIO !== 'visitor') return { stores: [] };
  // وضع 'once': قراءة جدول المنتجات مرّة واحدة هنا بالجلسة المُستنسخة نفسها، قبل انطلاق الزوّار
  if (TABLE === 'once') readFullTable('products_table_once');
  try {
    const r = http.get(`${SB}/rest/v1/profile?select=id&type=eq.STORE&limit=40`, { headers: baseHeaders });
    const arr = r.json();
    return { stores: Array.isArray(arr) ? arr.map((x) => x.id).filter(Boolean) : [] };
  } catch (e) {
    return { stores: [] }; // محجوب/متعثّر — الرحلة تسقط إلى استعلام بلا فلتر متجر
  }
}

function think() { sleep(THINK * (0.5 + Math.random())); } // تبعثُر طبيعي حول THINK

function visitorJourney(data) {
  const stores = (data && data.stores) || [];

  // ٠) وضع 'each': هذا الزائر يقرأ جدول المنتجات كاملًا في كل رحلة
  if (TABLE === 'each') { readFullTable('products_table'); think(); }

  // ٠ب) قراءة كل روابط صور المنتجات: جدول products_image كاملًا (أثقل قراءة منفصلة)
  if (IMAGES) { readFullTable('product_images_table', 'products_image?select=*'); think(); }

  // ١) فتح التطبيق: الشاشة الرئيسية — قائمة المتاجر
  get(`profile?select=id,name,image&type=eq.STORE&limit=20&offset=${Math.floor(Math.random() * 300)}`, 'home_stores');
  think();

  // ٢) فتح متجر: قائمة المنتجات مع صورها (التطبيق يجلبها معًا عبر embed)
  const sid = stores.length ? stores[Math.floor(Math.random() * stores.length)] : null;
  const menu = get(sid
    ? `products?select=id,name_ar,price,available,products_image(image)&store_id=eq.${sid}&limit=50`
    : `products?select=id,name_ar,price&limit=50&offset=${Math.floor(Math.random() * 1500)}`, 'store_menu');
  think();

  // ٢ب) فتح صنف من القائمة: صفّ المنتج كاملًا + صوره — قراءة منتجات حقيقية لا قائمة مختصرة
  if (DETAIL) {
    let pidProd = null;
    try {
      const arr = menu.json();
      if (Array.isArray(arr) && arr.length) pidProd = arr[Math.floor(Math.random() * arr.length)].id;
    } catch (e) { /* القائمة محجوبة/فارغة — تُتخطّى شاشة الصنف */ }
    if (pidProd) {
      const det = http.batch([
        { method: 'GET', url: `${SB}/rest/v1/products?select=*&id=eq.${pidProd}`, params: { headers: baseHeaders, tags: { name: 'product_row' } } },
        { method: 'GET', url: `${SB}/rest/v1/products_image?select=*&product_id=eq.${pidProd}`, params: { headers: baseHeaders, tags: { name: 'product_images' } } },
      ]);
      for (let i = 0; i < det.length; i++) classify(det[i]);
      think();
    }
  }

  // ٣) شاشة السلّة/الإشعارات: مراجع الدفع + إشعارات الزائر — بالتوازي كما يفعل التطبيق
  const batched = http.batch([
    { method: 'GET', url: `${SB}/rest/v1/bank_accounts?select=id&limit=20`, params: { headers: baseHeaders, tags: { name: 'bank' } } },
    { method: 'GET', url: `${SB}/rest/v1/promoCode?select=id&limit=20`, params: { headers: baseHeaders, tags: { name: 'promo' } } },
    { method: 'GET', url: `${SB}/rest/v1/notification?select=*&order=created_at.desc&limit=20`, params: { headers: baseHeaders, tags: { name: 'notifications' } } },
  ]);
  for (let i = 0; i < batched.length; i++) classify(batched[i]);
  think();

  // ٤) شاشتا العميل المسجَّل (فقط بجلسة مُستنسخة): حسابي/محفظتي + إشعاراتي — استعلامات
  // مفلترة بالمالك تمرّ على سياسات RLS، وهي الأثقل على الأصل من القراءة المرجعية العامة.
  if (PID) {
    const mine = http.batch([
      { method: 'GET', url: `${SB}/rest/v1/profile?select=id,name,wallet&id=eq.${PID}`, params: { headers: baseHeaders, tags: { name: 'my_profile' } } },
      { method: 'GET', url: `${SB}/rest/v1/notification_users?select=notif_id,seen&user_id=eq.${PID}&limit=20`, params: { headers: baseHeaders, tags: { name: 'my_notifications' } } },
    ]);
    for (let i = 0; i < mine.length; i++) classify(mine[i]);
    think();
  }
}

export default function (data) {
  if (SCENARIO === 'visitor') { visitorJourney(data); return; }
  const res = http.get(`${SB}/rest/v1/${pathFor(SCENARIO)}`, { headers });
  classify(res);
}
