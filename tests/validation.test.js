'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLocation, normalizePhone, validateBookingInput } = require('../server/validation');
const { isRealDate, shopDateOf, slotInstant, addDays } = require('../server/domain');
const { escapeCell, bookingsToCsv } = require('../server/csv');

const validBody = (overrides = {}) => ({
  customerName: 'نورة الحربي',
  customerPhone: '0555555555',
  acType: 'window',
  address: 'حي الملز، شارع الأمير، عمارة 4',
  location: '24.713600, 46.675300',
  notes: '',
  date: '2026-10-20',
  slot: '12:00',
  ...overrides,
});

const ctx = { today: '2026-10-16', maxAdvanceDays: 60, defaultCountryCode: '966' };

test('الإحداثيات: صيغة عادية ورابط خرائط وقيم خارج النطاق', () => {
  assert.deepEqual(parseLocation('24.7136, 46.6753'), { latitude: 24.7136, longitude: 46.6753 });
  assert.deepEqual(parseLocation('24.7136،46.6753'), { latitude: 24.7136, longitude: 46.6753 });
  assert.deepEqual(
    parseLocation('https://www.google.com/maps/@24.7136,46.6753,17z'),
    { latitude: 24.7136, longitude: 46.6753 },
  );
  assert.deepEqual(
    parseLocation('https://maps.google.com/?q=24.7136,46.6753'),
    { latitude: 24.7136, longitude: 46.6753 },
  );
  assert.deepEqual(parseLocation(''), { latitude: null, longitude: null });
  assert.ok(parseLocation('95.0, 46.0').error);
  assert.ok(parseLocation('hello').error);
});

test('توحيد أرقام الجوال', () => {
  assert.equal(normalizePhone('0555 555 555', '966'), '+966555555555');
  assert.equal(normalizePhone('+966 55-555-5555', '966'), '+966555555555');
  assert.equal(normalizePhone('00966555555555', '966'), '+966555555555');
  assert.equal(normalizePhone('12', '966'), null);
  assert.equal(normalizePhone('abc', '966'), null);
  assert.equal(normalizePhone('', '966'), null);
});

test('تحقق كامل من الحجز: يقبل المدخلات الصحيحة', () => {
  const { errors, input } = validateBookingInput(validBody(), ctx);
  assert.deepEqual(errors, {});
  assert.equal(input.customerPhone, '+966555555555');
  assert.equal(input.latitude, 24.7136);
});

test('تحقق كامل من الحجز: يرفض كل حقل خاطئ بخطأ مفصّل', () => {
  const { errors } = validateBookingInput(
    validBody({
      customerName: '1',
      customerPhone: '123',
      acType: 'fridge',
      address: 'abc',
      location: 'xyz',
      date: '2026-02-30',
      slot: '10:00',
    }),
    ctx,
  );
  assert.deepEqual(Object.keys(errors).sort(), ['acType', 'address', 'customerName', 'customerPhone', 'date', 'location', 'slot']);
});

test('تحقق كامل من الحجز: يرفض الأيام الماضية والبعيدة', () => {
  assert.ok(validateBookingInput(validBody({ date: '2026-10-15' }), ctx).errors.date);
  assert.ok(validateBookingInput(validBody({ date: '2027-06-01' }), ctx).errors.date);
});

test('التواريخ الحقيقية وتوقيت المحل', () => {
  assert.equal(isRealDate('2026-10-16'), true);
  assert.equal(isRealDate('2026-13-01'), false);
  assert.equal(isRealDate('16-10-2026'), false);
  // 23:30 بتوقيت UTC يعني 02:30 صباحاً يوم جديد في +03:00
  assert.equal(shopDateOf(new Date('2026-10-15T20:30:00Z'), '+03:00'), '2026-10-15');
  assert.equal(shopDateOf(new Date('2026-10-15T21:30:00Z'), '+03:00'), '2026-10-16');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(slotInstant('2026-10-16', '16:00', '+03:00').toISOString(), '2026-10-16T13:00:00.000Z');
});

test('CSV: حماية من حقن الصيغ والاقتباس الصحيح', () => {
  assert.equal(escapeCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(escapeCell('+966'), `'+966`);
  assert.equal(escapeCell('a,b'), '"a,b"');
  assert.equal(escapeCell('سطر\nثاني'), '"سطر\nثاني"');
});

test('CSV: يبدأ بـ BOM ويحتوي على الترويسة', () => {
  const csv = bookingsToCsv([]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('رقم الحجز'));
});
