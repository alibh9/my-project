'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBooking, updateBooking, monthAvailability, dayAvailability, BookingError } = require('../server/bookings');
const { runReminders } = require('../server/reminders');
const { testConfig, memoryDb, addTechnician, FIXED_NOW } = require('./helpers');

const baseInput = (overrides = {}) => ({
  customerName: 'أحمد علي',
  customerPhone: '+966511111111',
  acType: 'split',
  address: 'حي النزهة، شارع 5، فيلا 12',
  latitude: 24.7136,
  longitude: 46.6753,
  notes: '',
  date: '2026-10-17',
  slot: '09:00',
  ...overrides,
});

function fakeNotifier() {
  const sent = [];
  return {
    sent,
    async send(to, text) {
      sent.push({ to, text });
      return true;
    },
  };
}

test('يحجز موعداً واحداً فقط عندما يوجد فني واحد', () => {
  const db = memoryDb();
  addTechnician(db, 'خالد', '+966522222222');
  const config = testConfig();

  const first = createBooking(db, baseInput(), { now: FIXED_NOW, config });
  assert.equal(first.technicianName, 'خالد');

  assert.throws(
    () => createBooking(db, baseInput({ customerName: 'سارة محمد' }), { now: FIXED_NOW, config }),
    (err) => err instanceof BookingError && err.code === 'SLOT_UNAVAILABLE',
  );
});

test('الحجز المتزامن يحتاج فنيين إضافيين وإلا يُرفض', () => {
  const db = memoryDb();
  addTechnician(db, 'خالد', '+966522222222');
  addTechnician(db, 'ماجد', '+966533333333');
  const config = testConfig();

  const a = createBooking(db, baseInput(), { now: FIXED_NOW, config });
  const b = createBooking(db, baseInput({ customerName: 'سارة محمد' }), { now: FIXED_NOW, config });
  assert.notEqual(a.technicianId, b.technicianId, 'كل حجز يذهب لفني مختلف');

  assert.throws(
    () => createBooking(db, baseInput({ customerName: 'منى سالم' }), { now: FIXED_NOW, config }),
    BookingError,
  );
});

test('المواعيد الثابتة فقط: موعد غير معروف يُرفض', () => {
  const db = memoryDb();
  const config = testConfig();
  assert.throws(
    () => createBooking(db, baseInput({ slot: '10:30' }), { now: FIXED_NOW, config }),
    (err) => err.code === 'INVALID_SLOT',
  );
});

test('لا يمكن الحجز في موعد مضى حتى اليوم نفسه', () => {
  const db = memoryDb();
  const config = testConfig();
  // الساعة الآن 8:00 صباحاً، موعد 9:00 لم يمض بعد لكن 4:00 مساءً متاح
  assert.doesNotThrow(() => createBooking(db, baseInput({ date: '2026-10-16', slot: '09:00' }), { now: FIXED_NOW, config }));
  assert.throws(
    () => createBooking(db, baseInput({ date: '2026-10-15', slot: '16:00' }), { now: FIXED_NOW, config }),
    (err) => err.code === 'PAST_SLOT',
  );
  const late = new Date('2026-10-16T14:00:00Z'); // 5:00 مساءً بتوقيت المحل
  assert.throws(
    () => createBooking(db, baseInput({ date: '2026-10-16', slot: '16:00', customerName: 'تأخر' }), { now: late, config }),
    (err) => err.code === 'PAST_SLOT',
  );
});

test('يرفض الحجز أبعد من الحد المسموح', () => {
  const db = memoryDb();
  const config = testConfig({ config: { maxAdvanceDays: 10 } });
  assert.throws(
    () => createBooking(db, baseInput({ date: '2026-12-31' }), { now: FIXED_NOW, config }),
    (err) => err.code === 'TOO_FAR',
  );
});

test('التقويم الشهري: يوم ممتلئ وآخر جزئي وآخر فارغ', () => {
  const db = memoryDb();
  addTechnician(db, 'خالد', '+966522222222');
  const config = testConfig();

  // فني واحد: نحجز كل المواعيد في 17 أكتوبر ونحجز موعداً واحداً في 18 أكتوبر
  for (const slot of ['09:00', '12:00', '16:00']) {
    createBooking(db, baseInput({ slot, customerName: `عميل ${slot}`, date: '2026-10-17' }), { now: FIXED_NOW, config });
  }
  createBooking(db, baseInput({ date: '2026-10-18', slot: '12:00', customerName: 'عميل جزئي' }), { now: FIXED_NOW, config });

  const days = monthAvailability(db, '2026-10', { now: FIXED_NOW, config });
  assert.equal(days['2026-10-15'].status, 'past');
  assert.equal(days['2026-10-16'].status, 'free', 'الساعة 8 صباحاً ولم يمض أي موعد بعد');
  assert.equal(days['2026-10-17'].status, 'full');
  assert.equal(days['2026-10-18'].status, 'partial');
  assert.equal(days['2026-10-19'].status, 'free');
});

test('توفر اليوم يعرض المواعيد المحجوزة والماضية', () => {
  const db = memoryDb();
  addTechnician(db, 'خالد', '+966522222222');
  const config = testConfig();
  createBooking(db, baseInput({ slot: '12:00' }), { now: FIXED_NOW, config });

  const day = dayAvailability(db, '2026-10-17', { now: FIXED_NOW, config });
  assert.deepEqual(
    day.slots.map((s) => [s.time, s.available]),
    [['09:00', true], ['12:00', false], ['16:00', true]],
  );
});

test('تعديل الحجز إلى موعد محجوز يُرفض، ومع الاحتفاظ بنفس الموعد لا يُحسب الحجز ضد نفسه', () => {
  const db = memoryDb();
  addTechnician(db, 'خالد', '+966522222222');
  const config = testConfig();
  const a = createBooking(db, baseInput({ slot: '09:00' }), { now: FIXED_NOW, config });
  createBooking(db, baseInput({ slot: '12:00', customerName: 'آخر' }), { now: FIXED_NOW, config });

  assert.throws(
    () => updateBooking(db, a.id, { slot: '12:00' }, { now: FIXED_NOW, config }),
    (err) => err.code === 'SLOT_UNAVAILABLE',
  );
  const same = updateBooking(db, a.id, { notes: 'ملاحظة جديدة' }, { now: FIXED_NOW, config });
  assert.equal(same.notes, 'ملاحظة جديدة');
});

test('لا يُسنَد فني مرتبط بحجز آخر في نفس الموعد', () => {
  const db = memoryDb();
  const khaled = addTechnician(db, 'خالد', '+966522222222');
  addTechnician(db, 'ماجد', '+966533333333');
  const config = testConfig();
  createBooking(db, baseInput({ slot: '09:00' }), { now: FIXED_NOW, config });
  const b = createBooking(db, baseInput({ slot: '09:00', customerName: 'ثاني' }), { now: FIXED_NOW, config });
  assert.notEqual(b.technicianId, khaled);

  assert.throws(
    () => updateBooking(db, b.id, { technicianId: khaled }, { now: FIXED_NOW, config }),
    (err) => err.code === 'TECHNICIAN_BUSY',
  );
});

test('إلغاء الحجز يحرر الموعد للحجز التالي', () => {
  const db = memoryDb();
  addTechnician(db, 'خالد', '+966522222222');
  const config = testConfig();
  const a = createBooking(db, baseInput(), { now: FIXED_NOW, config });
  updateBooking(db, a.id, { status: 'cancelled' }, { now: FIXED_NOW, config });
  assert.doesNotThrow(() => createBooking(db, baseInput({ customerName: 'بديل' }), { now: FIXED_NOW, config }));
});

test('التذكير يُرسل مرة واحدة للعميل والفني ضمن النافذة فقط', async () => {
  const db = memoryDb();
  addTechnician(db, 'خالد', '+966522222222');
  const config = testConfig();
  createBooking(db, baseInput({ date: '2026-10-16', slot: '16:00' }), { now: FIXED_NOW, config });

  const notifier = fakeNotifier();
  const logger = { info() {}, error() {} };

  // 8:00 صباحاً والموعد 4:00 مساءً: خارج النافذة (60 دقيقة)
  let result = await runReminders(db, { notifier, config, now: FIXED_NOW, logger });
  assert.equal(result.sent, 0);

  // 3:10 مساءً بتوقيت المحل (الموعد 4:00): قبل ساعة من الموعد بخمسين دقيقة
  const nearNow = new Date('2026-10-16T12:10:00Z');
  result = await runReminders(db, { notifier, config, now: nearNow, logger });
  assert.equal(result.sent, 1);
  assert.equal(notifier.sent.length, 2, 'العميل والفني');
  assert.ok(notifier.sent.some((m) => m.to === '+966522222222'));

  // دورة أخرى لا ترسل مكرراً
  result = await runReminders(db, { notifier, config, now: nearNow, logger });
  assert.equal(result.sent, 0);
  assert.equal(notifier.sent.length, 2);
});

test('تعديل موعد الحجز يعيد ضبط التذكير ليصل للموعد الجديد', () => {
  const db = memoryDb();
  addTechnician(db, 'خالد', '+966522222222');
  const config = testConfig();
  const a = createBooking(db, baseInput({ date: '2026-10-16', slot: '16:00' }), { now: FIXED_NOW, config });
  db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(a.id);

  const moved = updateBooking(db, a.id, { slot: '12:00' }, { now: FIXED_NOW, config });
  assert.equal(moved.reminderSent, false);
});
