// ─── Scheduler Bridge ─────────────────────────────────────────────────────────
// Decouples rescheduleDailyCron between bot.js and telegram.js to avoid a
// circular require. bot.js calls registerReschedule() at startup; telegram.js
// calls rescheduleDailyCron() without ever importing bot.js.

let _rescheduleCallback = null;

function registerReschedule(fn) {
  _rescheduleCallback = fn;
}

async function rescheduleDailyCron(cronExpr) {
  if (!_rescheduleCallback) {
    console.warn("⚠️  rescheduleDailyCron called before registerReschedule");
    return false;
  }
  return _rescheduleCallback(cronExpr);
}

module.exports = { registerReschedule, rescheduleDailyCron };
