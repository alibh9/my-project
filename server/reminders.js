'use strict';

const { slotInstant, shopDateOf, addDays } = require('./domain');
const { confirmedBookingsBetween, markReminderSent } = require('./bookings');
const { reminderMessage } = require('./notifications');

// يرسل التذكيرات للحجوزات التي يبدأ موعدها خلال النافذة المحددة ولم يُذكَّر بعد.
// تُشغَّل كل دقيقة من المجدول، ويمكن استدعاؤها يدوياً من لوحة الإدارة.
async function runReminders(db, { notifier, config, now = new Date(), logger = console }) {
  if (!config.reminders.enabled) return { checked: 0, sent: 0, skipped: 'disabled' };

  const today = shopDateOf(now, config.timezoneOffset);
  const windowEnd = now.getTime() + config.reminders.minutesBefore * 60000;
  const candidates = confirmedBookingsBetween(db, today, addDays(today, 1)).filter((b) => !b.reminderSent);

  let sent = 0;
  for (const booking of candidates) {
    const start = slotInstant(booking.date, booking.slot, config.timezoneOffset).getTime();
    if (start <= now.getTime() || start > windowEnd) continue;

    // نعلّم الحجز قبل الإرسال لتفادي تكرار التذكير لو تأخر الإرسال عن الدورة التالية
    markReminderSent(db, booking.id);

    const [customerOk, technicianOk] = await Promise.all([
      notifier.send(booking.customerPhone, reminderMessage(booking, { forTechnician: false })),
      booking.technicianPhone
        ? notifier.send(booking.technicianPhone, reminderMessage(booking, { forTechnician: true }))
        : Promise.resolve(false),
    ]);
    if (customerOk || technicianOk) sent++;
    logger.info(`[reminder] ${booking.reference} العميل=${customerOk} الفني=${technicianOk}`);
  }
  return { checked: candidates.length, sent };
}

function startReminderScheduler(db, deps) {
  if (!deps.config.reminders.enabled) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // لا تتداخل دورتان
    running = true;
    try {
      await runReminders(db, deps);
    } catch (error) {
      deps.logger.error(`[reminder] فشل المجدول: ${error.message}`);
    } finally {
      running = false;
    }
  }, 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { runReminders, startReminderScheduler };
