import 'dotenv/config';
import { createBot, notifyInterrupted } from './bot.js';
import { shutdownAllPersistent } from './persistentClaude.js';
import { stopAllTunnels } from './tunnel.js';

const required = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_TELEGRAM_USER_ID'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key} (see .env.example)`);
    process.exit(1);
  }
}

const bot = createBot();

bot.launch();
console.log('tg-claude-agent bot started.');

// Tell affected chats about any task killed mid-run by the previous shutdown.
notifyInterrupted(bot).catch((e) => console.error('notifyInterrupted failed:', e.message));

function shutdown(sig) {
  shutdownAllPersistent();
  stopAllTunnels();
  bot.stop(sig);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Keep the bot alive through unexpected async errors; log everything.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  // Unknown state — let systemd restart us cleanly; notifyInterrupted runs next boot.
  process.exit(1);
});
