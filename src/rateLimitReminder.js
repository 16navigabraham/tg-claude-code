// Schedules a one-off Telegram DM for when the Claude subscription's rate
// limit resets, so the user doesn't have to keep checking back.

let botRef = null;
let timer = null;
let scheduledFor = 0;

export function initReminder(bot) {
  botRef = bot;
}

// Best-effort fallback for when Claude only gives a free-text reset time
// ("resets 2:20pm", "resets at 2:20 PM") instead of the structured
// rate_limit_event. Assumes the time is already in the process's TZ (we set
// TZ on every spawn), takes the next occurrence of that time of day.
export function parseResetTimeFromText(text) {
  if (!text) return null;
  const m = String(text).match(/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([ap]m)?/i);
  if (!m) return null;
  let [, h, min, ap] = m;
  h = Number(h);
  min = Number(min);
  if (ap) {
    ap = ap.toLowerCase();
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  }
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(h, min, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

// resetsAtMs: epoch ms. No-ops if already scheduled for the same (or a later)
// time, so repeated rate-limit hits within one window don't spam reminders.
export function scheduleRateLimitReminder(resetsAtMs) {
  if (!botRef || !resetsAtMs) return;
  const chatId = process.env.ALLOWED_TELEGRAM_USER_ID;
  if (!chatId) return;

  const delay = resetsAtMs - Date.now();
  if (delay <= 0 || delay > 24 * 60 * 60 * 1000) return; // sanity bounds
  if (timer && scheduledFor >= resetsAtMs) return; // already covered

  clearTimeout(timer);
  scheduledFor = resetsAtMs;
  timer = setTimeout(() => {
    timer = null;
    scheduledFor = 0;
    botRef.telegram
      .sendMessage(chatId, '🟢 Claude subscription limit should be reset now — back to normal.')
      .catch(() => {});
  }, delay);
  // Don't hold the process open just for this timer.
  timer.unref?.();
}
