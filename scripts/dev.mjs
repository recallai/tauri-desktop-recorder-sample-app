import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('.env')) {
  console.error('Copy .sample.env to .env and fill in your Recall values first.');
  process.exit(1);
}
process.loadEnvFile('.env');
const child = spawn('npm', ['run', 'tauri', 'dev'], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 1));
