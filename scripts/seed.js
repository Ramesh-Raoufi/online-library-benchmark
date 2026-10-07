import { openDatabase } from '../src/database.js';
import { migrate } from '../src/schema.js';
import { saveBook } from '../src/library.js';
const db = await openDatabase();
const books = [
  ['Database System Concepts','Abraham Silberschatz','9780073523323','Databases','DB-01',6],
  ['Designing Data-Intensive Applications','Martin Kleppmann','9781449373320','Databases','DB-02',4],
  ['Learning SQL','Alan Beaulieu','9781492057611','Databases','DB-03',5],
  ['Introduction to Algorithms','Thomas H. Cormen','9780262046305','Computer Science','CS-01',3],
  ['Clean Code','Robert C. Martin','9780132350884','Software Engineering','SE-01',5],
  ['Computer Networking: A Top-Down Approach','James F. Kurose','9780136681557','Networking','NW-01',4],
  ['The Pragmatic Programmer','David Thomas','9780135957059','Software Engineering','SE-02',3],
  ['Operating System Concepts','Abraham Silberschatz','9781119800361','Computer Science','CS-02',4],
  ['Python Crash Course','Eric Matthes','9781718502703','Programming','PG-01',6],
  ['JavaScript: The Definitive Guide','David Flanagan','9781491952023','Programming','PG-02',4],
  ['Artificial Intelligence: A Modern Approach','Stuart Russell','9780134610993','Computer Science','CS-03',3],
  ['بهارستان','عبدالرحمن جامی','CAT-FA-0001','Literature','LT-01',3]
];
try {
  await migrate(db);
  const admin = (await db.query('SELECT id,role FROM users WHERE role=? AND active=1 LIMIT 1',['admin'])).rows[0];
  if (!admin) throw new Error('Create the administrator with npm run setup first.');
  let added = 0;
  for (const [title,author,isbn,category,shelf,total_copies] of books) {
    if ((await db.query('SELECT id FROM books WHERE isbn=?',[isbn])).rows.length) continue;
    await saveBook(db,admin,{title,author,isbn,category,shelf,total_copies}); added++;
  }
  console.log(`${added} catalogue records added. These are sample catalogue entries; no loan history or benchmark results are fabricated.`);
} finally { await db.close(); }
