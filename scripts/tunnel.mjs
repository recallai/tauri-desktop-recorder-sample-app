import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const webhookPort = Number(process.env.WEBHOOK_PORT ?? 3000);
if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
  throw new Error('WEBHOOK_PORT must be an integer from 1 to 65535');
}
const args = ['http', String(webhookPort)];
const configuredUrl = process.env.PUBLIC_API_BASE_URL?.trim();
if (configuredUrl) {
  let parsed;
  try { parsed = new URL(configuredUrl); }
  catch { throw new Error('PUBLIC_API_BASE_URL must be a valid HTTPS URL'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('PUBLIC_API_BASE_URL must be an HTTPS origin, such as https://your-domain.ngrok.app');
  }
  args.push('--url', parsed.origin);
}

const child = spawn('ngrok', args, { stdio: 'inherit' });
child.on('error', (error) => { console.error(`Could not start ngrok: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
