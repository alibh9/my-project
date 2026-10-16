'use strict';

const { AC_TYPES, isRealDate, isValidSlot, addDays } = require('./domain');

const NAME_RE = /^[\p{L}\p{M}\s.'-]{2,80}$/u;
const COORD_PAIR_RE = /(-?\d{1,3}(?:\.\d+)?)\s*[,،]\s*(-?\d{1,3}(?:\.\d+)?)/;

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
}

// يقبل: "24.7136, 46.6753" أو رابط خرائط فيه "@lat,lng" أو "?q=lat,lng"
function parseLocation(raw) {
  const text = cleanText(raw);
  if (!text) return { latitude: null, longitude: null };

  const atMatch = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(text);
  const qMatch = /[?&](?:q|query|ll)=(-?\d{1,3}(?:\.\d+)?)(?:,|%2C)(-?\d{1,3}(?:\.\d+)?)/i.exec(text);
  const pair = atMatch || qMatch || COORD_PAIR_RE.exec(text);
  if (!pair) return { error: 'صيغة الإحداثيات غير صحيحة. مثال: 24.713600, 46.675300' };

  const latitude = Number(pair[1]);
  const longitude = Number(pair[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return { error: 'الإحداثيات خارج النطاق المسموح' };
  }
  return { latitude, longitude };
}

// يوحّد الرقم إلى صيغة دولية +XXXX بدون مسافات
function normalizePhone(raw, defaultCountryCode) {
  let digits = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.slice(1);
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

function validateBookingInput(body, { today, maxAdvanceDays, defaultCountryCode }) {
  const errors = {};
  const input = {};

  const name = cleanText(body.customerName);
  if (!NAME_RE.test(name)) errors.customerName = 'اكتب الاسم الكامل (حرفان على الأقل)';
  else input.customerName = name;

  const phone = normalizePhone(body.customerPhone, defaultCountryCode);
  if (!phone) errors.customerPhone = 'رقم الجوال غير صحيح';
  else input.customerPhone = phone;

  const acType = cleanText(body.acType);
  if (!AC_TYPES.some((t) => t.id === acType)) errors.acType = 'اختر نوع المكيف';
  else input.acType = acType;

  const address = cleanText(body.address);
  if (address.length < 5 || address.length > 300) errors.address = 'العنوان يجب أن يكون بين 5 و300 حرف';
  else input.address = address;

  const location = parseLocation(body.location);
  if (location.error) errors.location = location.error;
  else {
    input.latitude = location.latitude;
    input.longitude = location.longitude;
  }

  const notes = cleanText(body.notes);
  if (notes.length > 500) errors.notes = 'الملاحظات يجب ألا تتجاوز 500 حرف';
  else input.notes = notes;

  const date = typeof body.date === 'string' ? body.date : '';
  const latest = addDays(today, maxAdvanceDays);
  if (!isRealDate(date)) errors.date = 'اختر يوماً من التقويم';
  else if (date < today) errors.date = 'لا يمكن الحجز في يوم سابق';
  else if (date > latest) errors.date = `يمكن الحجز قبل ${maxAdvanceDays} يوماً فقط`;
  else input.date = date;

  const slot = typeof body.slot === 'string' ? body.slot : '';
  if (!isValidSlot(slot)) errors.slot = 'اختر أحد المواعيد المتاحة';
  else input.slot = slot;

  return { errors, input };
}

function validateStatusPatch(body, allowed) {
  if (!allowed.includes(body.status)) return 'حالة الحجز غير صحيحة';
  return null;
}

module.exports = {
  cleanText,
  parseLocation,
  normalizePhone,
  validateBookingInput,
  validateStatusPatch,
};
