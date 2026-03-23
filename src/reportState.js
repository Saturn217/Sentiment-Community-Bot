/**
 * Shared report pause state.
 * Imported by bot.js, commands.js and telegram.js.
 */

const reportState = {
  dailyPaused:      false,
  weeklyPaused:     false,
  dailySkipCount:   0,
  weeklySkipCount:  0,
  dailyPausedUntil: null,
  weeklyPausedUntil: null,
};

function isReportPaused(type) {
  if (type === "daily") {
    if (!reportState.dailyPaused) return false;
    if (reportState.dailySkipCount > 0) return true;
    if (!reportState.dailyPausedUntil) return true;
    if (new Date() > reportState.dailyPausedUntil) {
      reportState.dailyPaused      = false;
      reportState.dailyPausedUntil = null;
      return false;
    }
    return true;
  }
  if (type === "weekly") {
    if (!reportState.weeklyPaused) return false;
    if (reportState.weeklySkipCount > 0) return true;
    if (!reportState.weeklyPausedUntil) return true;
    if (new Date() > reportState.weeklyPausedUntil) {
      reportState.weeklyPaused      = false;
      reportState.weeklyPausedUntil = null;
      return false;
    }
    return true;
  }
  return false;
}

function consumeSkip(type) {
  if (type === "daily" && reportState.dailySkipCount > 0) {
    reportState.dailySkipCount--;
    if (reportState.dailySkipCount === 0) {
      reportState.dailyPaused      = false;
      reportState.dailyPausedUntil = null;
      console.log("▶️  Daily report auto-resumed after skip.");
    }
  }
  if (type === "weekly" && reportState.weeklySkipCount > 0) {
    reportState.weeklySkipCount--;
    if (reportState.weeklySkipCount === 0) {
      reportState.weeklyPaused      = false;
      reportState.weeklyPausedUntil = null;
      console.log("▶️  Weekly digest auto-resumed after skip.");
    }
  }
}

module.exports = { reportState, isReportPaused, consumeSkip };