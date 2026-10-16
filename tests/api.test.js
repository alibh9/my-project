'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { testConfig, memoryDb, addTechnician, FIXED_NOW, solveCaptcha } = require('./helpers');

const silentLogger = { info() {}, error() {}, log() {}, warn() {} };
const TECH_PHONE = '+966550000001';

async function startServer({ technicians = 1, config: overrides } = {}) {
  const db = memoryDb();
  for (let i = 0; i < technicians; i++) addTechnician(db, `فني ${i + 1}`, i === 0 ? TECH_PHONE : `+96655000010${i}`);
  const sent = [];
  const notifier = {
    async send(to, text) {
      sent.push({ to, text });
      return true;
    },
  };
  const config = testConfig({ config: overrides });
  const app = createApp({ db, config, notifier, logger: silentLogger, now: () => FIXED_NOW });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    db,
    sent,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

async function freshCaptcha(base) {
  const res = await fetch(`${base}/api/captcha`);
  const data = await res.json();
  return { id: data.id, answer: solveCaptcha(data.question) };
}

function bookingBody(captcha, overrides = {}) {
  return {
    customerName: 'محمد الشهري',
    customerPhone: '0500000001',
    acType: 'split',
    address: 'حي الروضة، شارع 10، فيلا 3',
    location: '21.543333, 39.172778',
    notes: '',
    date: '2026-10-20',
    slot: '09:00',
    captchaId: captcha.id,
    captchaAnswer: captcha.answer,
    website: '',
    ...overrides,
  };
}

async function postBooking(base, body) {
  const res = await fetch(`${base}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('الإعدادات والتوفر العام', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const cfg = await (await fetch(`${s.base}/api/config`)).json();
  assert.deepEqual(cfg.slots.map((x) => x.time), ['09:00', '12:00', '16:00']);
  assert.equal(cfg.acTypes.length, 4);
  assert.equal(cfg.today, '2026-10-16');

  const month = await (await fetch(`${s.base}/api/availability?month=2026-10`)).json();
  assert.equal(month.days['2026-10-20'].status, 'free');

  const bad = await fetch(`${s.base}/api/availability?month=2026-13`);
  assert.equal(bad.status, 400);
});

test('الحجز يُقبل بتحدٍّ صحيح ويرسل إشعارات العميل والفني', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const { status, data } = await postBooking(s.base, bookingBody(await freshCaptcha(s.base)));
  assert.equal(status, 201);
  assert.match(data.booking.reference, /^AC-[A-Z2-9]{8}$/);
  assert.equal(data.booking.slotLabel, '9:00 صباحاً');
  assert.match(data.booking.mapUrl, /maps\?q=21\.543333,39\.172778/);
  assert.equal(data.notifications.customer, true);
  assert.equal(data.notifications.technician, true);
  const stored = s.db.prepare('SELECT notify_status FROM bookings WHERE reference = ?').get(data.booking.reference);
  assert.equal(stored.notify_status, 'customer=ok;owner=ok;technician=ok');
  assert.ok(s.sent.some((m) => m.to === '+966500000001'), 'رسالة للعميل');
  assert.ok(s.sent.some((m) => m.to === TECH_PHONE), 'رسالة للفني');
});

test('تحدٍّ خاطئ أو مُعاد استخدامه يمنع الحجز', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const captcha = await freshCaptcha(s.base);
  const wrong = await postBooking(s.base, bookingBody({ ...captcha, answer: '999' }));
  assert.equal(wrong.status, 400);
  assert.ok(wrong.data.errors.captcha);

  // التحدي استُهلك: إعادة استخدامه ترفض
  const reused = await postBooking(s.base, bookingBody(captcha));
  assert.equal(reused.status, 400);
  assert.ok(reused.data.errors.captcha);
});

test('الأخطاء في الحقول لا تستهلك التحدي', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const captcha = await freshCaptcha(s.base);
  const invalid = await postBooking(s.base, bookingBody(captcha, { customerPhone: '12' }));
  assert.equal(invalid.status, 400);
  assert.ok(invalid.data.errors.customerPhone);
  assert.equal(invalid.data.errors.captcha, undefined);

  const ok = await postBooking(s.base, bookingBody(captcha));
  assert.equal(ok.status, 201, 'نفس التحدي ما زال صالحاً بعد خطأ في الحقول');
});

test('مصيدة الروبوتات: ملء الحقل المخفي يرفض الطلب', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const res = await postBooking(s.base, bookingBody(await freshCaptcha(s.base), { website: 'http://spam' }));
  assert.equal(res.status, 400);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
});

test('طلبان متزامنان لنفس الموعد مع فني واحد: واحد فقط ينجح', async (t) => {
  const s = await startServer({ technicians: 1 });
  t.after(() => s.close());

  const [c1, c2] = [await freshCaptcha(s.base), await freshCaptcha(s.base)];
  const [r1, r2] = await Promise.all([
    postBooking(s.base, bookingBody(c1, { customerName: 'عميل الأول' })),
    postBooking(s.base, bookingBody(c2, { customerName: 'عميل الثاني' })),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = r1.status === 409 ? r1 : r2;
  assert.equal(loser.data.code, 'SLOT_UNAVAILABLE');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed'").get().n, 1);
});

test('تحقق من الحقول: موعد الماضي يُرفض عبر API', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const res = await postBooking(s.base, bookingBody(await freshCaptcha(s.base), { date: '2026-10-01' }));
  assert.equal(res.status, 400);
  assert.ok(res.data.errors.date);
});

test('لوحة الإدارة: محمية بالمصادقة الأساسية', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const anon = await fetch(`${s.base}/api/admin/bookings`);
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /^Basic/);

  const page = await fetch(`${s.base}/admin/`);
  assert.equal(page.status, 401, 'صفحة الإدارة نفسها محمية');

  const wrong = await fetch(`${s.base}/api/admin/bookings`, {
    headers: { Authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` },
  });
  assert.equal(wrong.status, 401);

  const auth = { Authorization: `Basic ${Buffer.from('admin:secret-pass').toString('base64')}` };
  const ok = await fetch(`${s.base}/api/admin/bookings`, { headers: auth });
  assert.equal(ok.status, 200);
  const page2 = await fetch(`${s.base}/admin/`, { headers: auth });
  assert.equal(page2.status, 200);
});

test('لوحة الإدارة معطّلة إذا لم تُضبط كلمة المرور', async (t) => {
  const s = await startServer({ config: { admin: { user: 'admin', password: '' } } });
  t.after(() => s.close());
  const res = await fetch(`${s.base}/api/admin/bookings`, {
    headers: { Authorization: `Basic ${Buffer.from('admin:').toString('base64')}` },
  });
  assert.equal(res.status, 503);
});

test('الإدارة: تعديل الحجز وإضافة فني وتصدير CSV', async (t) => {
  const s = await startServer({ technicians: 0 });
  t.after(() => s.close());
  const auth = { Authorization: `Basic ${Buffer.from('admin:secret-pass').toString('base64')}`, 'Content-Type': 'application/json' };

  const created = await postBooking(s.base, bookingBody(await freshCaptcha(s.base), { notes: '=cmd' }));
  assert.equal(created.status, 201);
  const bookingId = s.db.prepare('SELECT id FROM bookings WHERE reference = ?').get(created.data.booking.reference).id;

  const tech = await fetch(`${s.base}/api/admin/technicians`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'عبدالله', phone: '0512345678' }),
  });
  assert.equal(tech.status, 201);
  const techData = await tech.json();
  assert.equal(techData.technician.phone, '+966512345678');

  const patch = await fetch(`${s.base}/api/admin/bookings/${bookingId}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ status: 'completed', technicianId: techData.technician.id }),
  });
  assert.equal(patch.status, 200);
  const patched = await patch.json();
  assert.equal(patched.booking.status, 'completed');
  assert.equal(patched.booking.technicianName, 'عبدالله');

  const badStatus = await fetch(`${s.base}/api/admin/bookings/${bookingId}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ status: 'weird' }),
  });
  assert.equal(badStatus.status, 400);

  const csv = await fetch(`${s.base}/api/admin/export.csv?from=2026-10-01&to=2026-10-31`, { headers: auth });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  const text = await csv.text();
  assert.ok(text.includes("'=cmd"), 'قيمة تبدأ بـ = تُحصَّن من حقن الصيغ');

  const report = await (await fetch(`${s.base}/api/admin/report?date=2026-10-20`, { headers: auth })).json();
  assert.equal(report.total, 1);
  assert.equal(report.byStatus.completed, 1);
});

test('الصفحة الرئيسية والملفات الثابتة تعمل، والـ service worker لا يُخزَّن', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const home = await fetch(`${s.base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<html lang="ar" dir="rtl">/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);

  const sw = await fetch(`${s.base}/sw.js`);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');

  const missing = await fetch(`${s.base}/api/unknown`);
  assert.equal(missing.status, 404);
});
