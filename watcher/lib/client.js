// Shared whatsapp-web.js client factory.
// One LocalAuth session shared across login / list / watcher.

const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const ROOT = path.resolve(__dirname, '..');
const SESSION_DIR = path.join(ROOT, '.wwebjs_auth');

function buildClient({ headless = true } = {}) {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: 'curtis',
      dataPath: SESSION_DIR,
    }),
    puppeteer: {
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
    // Conservative; avoid hammering WA Web.
    takeoverOnConflict: false,
    qrMaxRetries: 5,
  });
}

module.exports = { buildClient, ROOT, SESSION_DIR };
