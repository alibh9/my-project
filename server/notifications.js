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

// ملاحظة: خارج نافذة الـ 24 ساعة يتطلب واتساب قالباً معتمداً (template)
function createMetaProvider({ phoneNumberId, token, apiVersion }) {
  return {
    name: 'meta',
    async send(to, text) {
      await postJson(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        body: {
          messaging_product: 'whatsapp',
          to: to.replace(/\D/g, ''),
          type: 'text',
          text: { body: text, preview_url: true },
        },
      });
    },
  };
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
    async send(to, text) {
      if (!to) return false;
      try {
        await impl.send(to, text);
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
  const [customer, owner, technician] = await Promise.all([
    notifier.send(booking.customerPhone, customerMessage(booking, config.shop.name)),
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

module.exports = {
  mapLink,
  customerMessage,
  ownerMessage,
  technicianMessage,
  reminderMessage,
  createNotifier,
  notifyBookingConfirmed,
};
