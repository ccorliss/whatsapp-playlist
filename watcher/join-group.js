const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

const INVITE_CODE = 'ItCMGl2dLxA0JOcBmDoYvL';

client.on('ready', async () => {
  console.log('Client ready, joining group...');
  try {
    const gid = await client.acceptInvite(INVITE_CODE);
    console.log('Joined! Group ID:', gid);
    // Wait a moment then get group info
    await new Promise(r => setTimeout(r, 2000));
    const chat = await client.getChatById(gid);
    console.log('Group name:', chat.name);
    console.log('Group ID:', chat.id._serialized);
  } catch (e) {
    console.error('Error:', e.message);
  }
  await client.destroy();
  process.exit(0);
});

client.on('auth_failure', (m) => { console.error('Auth failure:', m); process.exit(1); });
client.on('authenticated', () => console.log('Authenticated'));
client.initialize();
