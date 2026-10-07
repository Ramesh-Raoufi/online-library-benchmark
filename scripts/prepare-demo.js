// Demo-only bootstrap for ephemeral SQLite hosting. Existing accounts are preserved.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database.js';
import { migrate } from '../src/schema.js';
import { email, text, hashPassword } from '../src/security.js';

if ((process.env.DB_ENGINE || 'sqlite') !== 'sqlite') {
  throw new Error('start:demo is only for SQLite previews. Use npm run setup and npm start for persistent databases.');
}
const db = await openDatabase();
let created = false;
try {
  await migrate(db);
  const admins = (await db.query('SELECT id FROM users WHERE role=?', ['admin'])).rows;
  if (!admins.length) {
    const mail = email(process.env.ADMIN_EMAIL);
    const name = text(process.env.ADMIN_NAME || 'Library Administrator', 'Name', 120);
    const password = text(process.env.ADMIN_PASSWORD, 'ADMIN_PASSWORD', 128, 10);
    await db.query('INSERT INTO users (id,name,email,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)',
      [randomUUID(), name, mail, await hashPassword(password), 'admin', 1, new Date().toISOString()]);
    created = true;
    console.log('Demo administrator created from hosting environment settings.');
  } else {
    console.log('Existing demo administrator preserved.');
  }
} finally {
  await db.close();
}
if (created) execFileSync(process.execPath, [fileURLToPath(new URL('./seed.js', import.meta.url))], { stdio: 'inherit', env: process.env });
