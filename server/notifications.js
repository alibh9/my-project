'use strict';

const { acTypeLabel, slotLabel } = require('./domain');

// ---------- نصوص الرسائل ----------

function mapLink(booking) {
  if (booking.latitude != null && booking.longitude != null) {
    return `https://www.google.com/maps?q=${booking.latitude},${booking.longitude}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(booking.address)}`;
}

function bookingLines(booking) {
  return [
    `رقم الحجز: ${booking.reference}`,
    `التاريخ: ${booking.date}`,
    `الموعد: ${slotLabel(booking.slot)}`,
    `نوع المكيف: ${acTypeLabel(booking.acType)}`,
    `العنوان: ${booking.address}`,
    `الموقع: ${mapLink(booking)}`,
  ];
}

function customerMessage(booking, shopName) {
  return [
    `مرحباً ${booking.customerName}،`,
    `تم تأكيد حجزك لدى ${shopName}.`,
    '',
    ...bookingLines(booking),
    '',
    'نتطلع لخدمتك. لتعديل الموعد تواصل معنا.',
  ].join('\n');
}

function ownerMessage(booking) {
  return [
    'حجز جديد تم تأكيده:',
    `العميل: ${booking.customerName} - ${booking.customerPhone}`,
    ...bookingLines(booking),
    booking.technicianName ? `الفني: ${booking.technicianName}` : 'الفني: لم يُعيَّن بعد',
  ].join('\n');
}

function technicianMessage(booking) {
  return [
    `موعد جديد مُسنَد لك:`,
    `العميل: ${booking.customerName} - ${booking.customerPhone}`,
    ...bookingLines(booking),
  ].join('\n');
}

function reminderMessage(booking, { forTechnician }) {
  const head = forTechnician
    ? 'تذكير: لديك موعد صيانة بعد قليل'
    : `تذكير: موعدك مع المحل بعد قليل`;
  return [head, ...bookingLines(booking)].join('\n');
}

// ---------- مزودو واتساب ----------

async function postJson(url, { headers, body }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

function createLogProvider(logger) {
  return {
    name: 'log',
    async send(to, text) {
      logger.info(`[whatsapp:log] إلى ${to}\n${text}`);
    },
  };
}

function createTwilioProvider({ accountSid, authToken, from }) {
  return {
    name: 'twilio',
    async send(to, text) {
      const body = new URLSearchParams({
        From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
        To: `whatsapp:${to}`,
        Body: text,
      });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Twilio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

// قيم القالب لا تقبل أسطراً أو تبويبات أو أكثر من مسافتين متتاليتين في واتساب
function sanitizeTemplateValue(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 1024);
}

// ملاحظة: خارج نافذة الـ 24 ساعة لا يُرسل واتساب إلا قالباً معتمداً، لذلك نفضّل القالب متى ضُبط اسمه
function buildMetaPayload(to, text, template) {
  const base = { messaging_product: 'whatsapp', to: to.replace(/\D/g, '') };
  if (template?.name) {
    return {
      ...base,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language || 'ar' },
        components: [
          {
            type: 'body',
            parameters: template.variables.map((v) => ({ type: 'text', text: sanitizeTemplateValue(v) })),
          },
        ],
      },
    };
  }
  return { ...base, type: 'text', text: { body: text, preview_url: true } };
}

function createMetaProvider({ phoneNumberId, token, apiVersion }) {
  return {
    name: 'meta',
    async send(to, text, template) {
      await postJson(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        body: buildMetaPayload(to, text, template),
      });
    },
  };
}

// متغيرات قالب تأكيد الحجز بالترتيب: {{1}} الاسم، {{2}} الرقم، {{3}} التاريخ، {{4}} الموعد،
// {{5}} نوع المكيف، {{6}} العنوان، {{7}} رابط الخريطة
function customerTemplateVariables(booking) {
  return [
    booking.customerName,
    booking.reference,
    booking.date,
    slotLabel(booking.slot),
    acTypeLabel(booking.acType),
    booking.address,
    mapLink(booking),
  ];
}

function createNotifier(whatsappConfig, logger = console) {
  const { provider, twilio, meta } = whatsappConfig;
  let impl;
  if (provider === 'twilio') {
    if (!twilio.accountSid || !twilio.authToken || !twilio.from) {
      throw new Error('إعدادات Twilio ناقصة (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM)');
    }
    impl = createTwilioProvider(twilio);
  } else if (provider === 'meta') {
    if (!meta.phoneNumberId || !meta.token) {
      throw new Error('إعدادات Meta ناقصة (META_WHATSAPP_PHONE_NUMBER_ID / META_WHATSAPP_TOKEN)');
    }
    impl = createMetaProvider(meta);
  } else {
    impl = createLogProvider(logger);
  }

  // يعيد true/false ولا يرمي: فشل الرسالة لا يجب أن يُفشل الحجز نفسه
  return {
    provider: impl.name,
    async send(to, text, template) {
      if (!to) return false;
      try {
        await impl.send(to, text, template);
        return true;
      } catch (error) {
        logger.error(`[whatsapp:${impl.name}] فشل الإرسال إلى ${to}: ${error.message}`);
        return false;
      }
    },
  };
}

// يرسل إشعارات إتمام الحجز: العميل + صاحب المحل + الفني المعني
async function notifyBookingConfirmed(booking, { notifier, config }) {
  const template = {
    name: config.whatsapp.meta.templates?.customerConfirmation || '',
    language: config.whatsapp.meta.templates?.language,
    variables: customerTemplateVariables(booking),
  };
  const [customer, owner, technician] = await Promise.all([
    notifier.send(booking.customerPhone, customerMessage(booking, config.shop.name), template),
    notifier.send(config.ownerPhone, ownerMessage(booking)),
    booking.technicianPhone
      ? notifier.send(booking.technicianPhone, technicianMessage(booking))
      : Promise.resolve(null),
  ]);
  return {
    customer,
    owner: config.ownerPhone ? owner : null,
    technician: booking.technicianPhone ? technician : null,
  };
}

// نص قصير يُحفظ في الحجز ويُعرض في اللوحة: customer=ok;owner=skipped;technician=failed
function summarizeNotifications(result) {
  const label = (v) => (v === null || v === undefined ? 'skipped' : v ? 'ok' : 'failed');
  return ['customer', 'owner', 'technician'].map((k) => `${k}=${label(result[k])}`).join(';');
}

module.exports = {
  mapLink,
  customerMessage,
  ownerMessage,
  technicianMessage,
  reminderMessage,
  customerTemplateVariables,
  buildMetaPayload,
  sanitizeTemplateValue,
  createNotifier,
  notifyBookingConfirmed,
  summarizeNotifications,
};
