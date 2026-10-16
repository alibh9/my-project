'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMetaPayload,
  sanitizeTemplateValue,
  customerTemplateVariables,
  summarizeNotifications,
  createNotifier,
  notifyBookingConfirmed,
} = require('../server/notifications');
const { testConfig } = require('./helpers');

const booking = {
  reference: 'AC-ABCD2345',
  customerName: 'ريم القحطاني',
  customerPhone: '+966511111111',
  acType: 'ducted',
  address: 'حي الياسمين\nشارع 3',
  latitude: 24.7,
  longitude: 46.6,
  date: '2026-10-20',
  slot: '12:00',
  technicianPhone: null,
};

test('قالب Meta: يرسل type=template مع المتغيرات بالترتيب', () => {
  const payload = buildMetaPayload('+966 51 111 1111', 'نص', {
    name: 'booking_confirmed',
    language: 'ar',
    variables: customerTemplateVariables(booking),
  });
  assert.equal(payload.type, 'template');
  assert.equal(payload.to, '966511111111');
  assert.equal(payload.template.name, 'booking_confirmed');
  assert.equal(payload.template.language.code, 'ar');
  const params = payload.template.components[0].parameters.map((p) => p.text);
  assert.equal(params.length, 7);
  assert.equal(params[0], 'ريم القحطاني');
  assert.equal(params[1], 'AC-ABCD2345');
  assert.equal(params[3], '12:00 ظهراً');
  assert.equal(params[4], 'دكت');
  assert.equal(params[5], 'حي الياسمين شارع 3', 'الأسطر الجديدة تُستبدل بمسافة');
  assert.match(params[6], /maps\?q=24\.7,46\.6/);
});

test('بدون اسم قالب يرسل نصاً حراً', () => {
  const payload = buildMetaPayload('+966511111111', 'مرحبا', { name: '', variables: [] });
  assert.equal(payload.type, 'text');
  assert.equal(payload.text.body, 'مرحبا');
});

test('تعقيم قيم القالب: المسافات المتكررة والأسطر والطول', () => {
  assert.equal(sanitizeTemplateValue('a\n\n\tb    c'), 'a b c');
  assert.equal(sanitizeTemplateValue('x'.repeat(2000)).length, 1024);
  assert.equal(sanitizeTemplateValue(null), '');
});

test('ملخص الإشعارات: ok وfailed وskipped', () => {
  assert.equal(
    summarizeNotifications({ customer: true, owner: null, technician: false }),
    'customer=ok;owner=skipped;technician=failed',
  );
});

test('إشعار التأكيد يمرر القالب المُعد للعميل فقط', async () => {
  const calls = [];
  const notifier = {
    async send(to, text, template) {
      calls.push({ to, template });
      return true;
    },
  };
  const config = testConfig({
    config: { ownerPhone: '+966500000001' },
    env: { META_TEMPLATE_CUSTOMER_CONFIRMATION: 'booking_confirmed', META_TEMPLATE_LANGUAGE: 'ar' },
  });
  const result = await notifyBookingConfirmed(booking, { notifier, config });

  assert.equal(result.customer, true);
  assert.equal(result.owner, true);
  assert.equal(result.technician, null, 'لا فني مُسند');
  const customerCall = calls.find((c) => c.to === booking.customerPhone);
  assert.equal(customerCall.template.name, 'booking_confirmed');
  assert.equal(customerCall.template.variables.length, 7);
});

test('مزود Meta: يرسل الحمولة إلى Graph API ويُبلغ بالفشل دون رمي', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return new Response('{}', { status: requests.length === 1 ? 200 : 400 });
  };
  const errors = [];
  try {
    const notifier = createNotifier(
      {
        provider: 'meta',
        twilio: {},
        meta: { phoneNumberId: '123', token: 'tok', apiVersion: 'v21.0', templates: { customerConfirmation: 'booking_confirmed', language: 'ar' } },
      },
      { info() {}, error: (m) => errors.push(m) },
    );
    const ok = await notifier.send('+966511111111', 'نص', { name: 'booking_confirmed', language: 'ar', variables: ['a'] });
    const failed = await notifier.send('+966511111111', 'نص', { name: 'x', variables: [] });

    assert.equal(ok, true);
    assert.equal(failed, false);
    assert.equal(requests[0].url, 'https://graph.facebook.com/v21.0/123/messages');
    assert.equal(requests[0].auth, 'Bearer tok');
    assert.equal(requests[0].body.type, 'template');
    assert.equal(errors.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
