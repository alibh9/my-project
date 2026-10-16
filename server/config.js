'use strict';

const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadConfig(env = process.env) {
  const offset = env.SHOP_UTC_OFFSET || '+03:00';
  if (!/^[+-]\d{2}:\d{2}$/.test(offset)) {
    throw new Error('SHOP_UTC_OFFSET يجب أن يكون بالصيغة +03:00');
  }

  return {
    rootDir: ROOT,
    publicDir: path.join(ROOT, 'public'),
    adminDir: path.join(ROOT, 'admin'),
    port: Number(env.PORT) || 3000,
    shop: {
      name: env.SHOP_NAME || 'مركز المكيفات',
      phone: env.SHOP_PHONE || '',
    },
    timezoneOffset: offset,
    defaultCountryCode: (env.DEFAULT_COUNTRY_CODE || '966').replace(/\D/g, ''),
    databasePath: env.DATABASE_PATH || path.join(ROOT, 'data', 'bookings.db'),
    trustProxy: env.TRUST_PROXY === 'true',
    maxAdvanceDays: Number(env.MAX_ADVANCE_DAYS) || 60,
    admin: {
      user: env.ADMIN_USER || 'admin',
      password: env.ADMIN_PASSWORD || '',
    },
    reminders: {
      enabled: env.REMINDERS_ENABLED !== 'false',
      minutesBefore: Number(env.REMINDER_MINUTES) || 60,
    },
    ownerPhone: env.OWNER_PHONE || '',
    whatsapp: {
      provider: (env.WHATSAPP_PROVIDER || 'log').toLowerCase(),
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID || '',
        authToken: env.TWILIO_AUTH_TOKEN || '',
        from: env.TWILIO_WHATSAPP_FROM || '',
      },
      meta: {
        phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID || '',
        token: env.META_WHATSAPP_TOKEN || '',
        apiVersion: env.META_GRAPH_API_VERSION || 'v21.0',
        // قالب معتمد لرسالة تأكيد الحجز. إن لم يُضبط يُرسل نص حر (يعمل داخل نافذة 24 ساعة فقط)
        templates: {
          customerConfirmation: env.META_TEMPLATE_CUSTOMER_CONFIRMATION || '',
          language: env.META_TEMPLATE_LANGUAGE || 'ar',
        },
      },
    },
  };
}

module.exports = { loadConfig };
