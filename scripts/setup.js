import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { migrate } from '../src/schema.js';
import { email, text, hashPassword } from '../src/security.js';
const db = await openDatabase();
try {
  await migrate(db);
  const mail = email(process.env.ADMIN_EMAIL), name = text(process.env.ADMIN_NAME || 'Library Administrator','Name',120);
  const password = text(process.env.ADMIN_PASSWORD,'ADMIN_PASSWORD',128,10);
  if ((await db.query('SELECT id FROM users WHERE role=?',['admin'])).rows.length) throw new Error('An administrator already exists. Manage accounts in the application; setup does not overwrite them.');
  await db.query('INSERT INTO users (id,name,email,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)',[randomUUID(),name,mail,await hashPassword(password),'admin',1,new Date().toISOString()]);
  console.log(`Administrator created: ${mail}. Run npm start to sign in.`);
} finally { await db.close(); }
