'use strict';

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { createNotifier } = require('./notifications');
const { createApp } = require('./app');
const { startReminderScheduler } = require('./reminders');
const { normalizePhone } = require('./validation');

function start(env = process.env) {
  const config = loadConfig(env);
  config.ownerPhone = normalizePhone(config.ownerPhone, config.defaultCountryCode) || '';

  if (!config.admin.password) {
    console.warn('[تنبيه] ADMIN_PASSWORD غير مضبوط: لوحة الإدارة معطّلة حتى تضبطه.');
  }

  const db = openDatabase(config.databasePath);
  const notifier = createNotifier(config.whatsapp);
  const logger = console;
  const app = createApp({ db, config, notifier, logger });

  const server = app.listen(config.port, () => {
    logger.log(`[server] ${config.shop.name} يعمل على http://localhost:${config.port}`);
    logger.log(`[server] واتساب: ${notifier.provider} | التذكيرات: ${config.reminders.enabled ? 'مفعلة' : 'معطلة'}`);
  });

  const stopScheduler = startReminderScheduler(db, { config, notifier, logger });

  const shutdown = () => {
    stopScheduler();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server, db, config };
}

if (require.main === module) {
  start();
}

module.exports = { start };
