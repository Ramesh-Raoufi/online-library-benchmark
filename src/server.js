import http from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database.js';
import { migrate } from './schema.js';
import { HttpError, requireRole, text, email, hashToken, token, verifyPassword, csv, integer } from './security.js';
import { issueLoan, returnLoan, saveBook, saveUser, reserveBook, audit } from './library.js';

const root = resolve(import.meta.dirname, '..');
const publicRoot = resolve(root, 'public');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml' };
export async function createApp({ db, origin = process.env.APP_ORIGIN || 'http://localhost:3000', secure = process.env.COOKIE_SECURE === 'true', resultsPath = resolve(root,'results') } = {}) {
  db ||= await openDatabase();
  await migrate(db);
  await mkdir(resultsPath, { recursive:true });
  const loginAttempts = new Map();
  let benchmarkJob = null;
  const json = (res, status, payload) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(payload)); };
  const cookie = (value, age) => `library_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415,'Send application/json.');
    let data = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new HttpError(413,'Request is too large.'); data += chunk; }
    try { const result = JSON.parse(data || '{}'); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; }
    catch { throw new HttpError(400,'Invalid JSON body.'); }
  }
  async function currentUser(req) {
    const session = /(?:^|;\s*)library_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!session) return null;
    return (await db.query('SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1',[hashToken(session),new Date().toISOString()])).rows[0] || null;
  }
  async function getResults() {
    const files = (await readdir(resultsPath)).filter(name => /^benchmark-[a-f0-9-]+\.json$/.test(name));
    return (await Promise.all(files.map(async name => JSON.parse(await readFile(resolve(resultsPath,name),'utf8'))))).sort((a,b) => b.created_at.localeCompare(a.created_at));
  }
  const server = http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url,origin), path = url.pathname, method = req.method;
      if (path.startsWith('/api/')) res.setHeader('Cache-Control','no-store');
      if (path.startsWith('/api/') && !['GET','HEAD'].includes(method)) {
        // JSON + custom header blocks simple cross-site requests; exact Origin protects browser mutations.
        if (req.headers['x-library-request'] !== '1' || (req.headers.origin && req.headers.origin !== origin)) throw new HttpError(403,'Request origin is not allowed.');
      }
      if (path === '/api/health' && method === 'GET') { await db.query('SELECT 1 AS ok'); return json(res,200,{ok:true}); }
      if (path === '/api/auth/login' && method === 'POST') {
        const data = await body(req), mail = email(data.email), password = text(data.password,'Password',128);
        const key = `${req.socket.remoteAddress}:${mail}`, stamp = Date.now();
        // Bound memory and rate-limit without trusting spoofable forwarding headers.
        for (const [k,v] of loginAttempts) if (v.until < stamp) loginAttempts.delete(k);
        if (loginAttempts.size > 10000) throw new HttpError(429,'Too many login attempts. Try again later.');
        const attempts = loginAttempts.get(key) || { count:0, until:stamp+900000 };
        if (attempts.count >= 10) throw new HttpError(429,'Too many login attempts. Try again in 15 minutes.');
        attempts.count++; loginAttempts.set(key,attempts);
        const user = (await db.query('SELECT * FROM users WHERE email=? AND active=1',[mail])).rows[0];
        if (!user || !await verifyPassword(password,user.password_hash)) throw new HttpError(401,'Email or password is incorrect.');
        loginAttempts.delete(key);
        const value = token();
        await db.query('DELETE FROM sessions WHERE expires_at<?',[new Date().toISOString()]);
        await db.query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',[hashToken(value),user.id,new Date(stamp+86400000).toISOString()]);
        res.setHeader('Set-Cookie',cookie(value,86400));
        return json(res,200,{user:{id:user.id,name:user.name,email:user.email,role:user.role}});
      }
      if (path === '/api/auth/me' && method === 'GET') {
        const user = await currentUser(req);
        const initialized = !!(await db.query('SELECT id FROM users LIMIT 1')).rows.length;
        return json(res,200,{user,initialized,engine:user ? db.engine : undefined});
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        const value = /library_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
        if (value) await db.query('DELETE FROM sessions WHERE token_hash=?',[hashToken(value)]);
        res.setHeader('Set-Cookie',cookie('',0)); return json(res,200,{ok:true});
      }
      if (path.startsWith('/api/')) {
        const user = await currentUser(req);
        if (!user) throw new HttpError(401,'Sign in to continue.');
        if (path === '/api/dashboard' && method === 'GET') {
          const [stock, active, overdue, requests] = await Promise.all([
            db.query("SELECT (SELECT COUNT(*) FROM books) AS titles,COUNT(*) AS copies,COALESCE(SUM(CASE WHEN availability='available' THEN 1 ELSE 0 END),0) AS available FROM book_copies WHERE availability<>'withdrawn'"),
            db.query(`SELECT COUNT(*) AS count FROM loans WHERE returned_at IS NULL${user.role === 'member' ? ' AND member_id=?' : ''}`,user.role === 'member' ? [user.id] : []),
            db.query(`SELECT COUNT(*) AS count FROM loans WHERE returned_at IS NULL AND due_at<?${user.role === 'member' ? ' AND member_id=?' : ''}`,[new Date().toISOString(),...(user.role === 'member' ? [user.id] : [])]),
            db.query(`SELECT COUNT(*) AS count FROM reservations WHERE status=?${user.role === 'member' ? ' AND member_id=?' : ''}`,['pending',...(user.role === 'member' ? [user.id] : [])])
          ]);
          return json(res,200,{...stock.rows[0],active_loans:active.rows[0].count,overdue:overdue.rows[0].count,pending_requests:requests.rows[0].count,engine:db.engine});
        }
        if (path === '/api/books' && method === 'GET') {
          const q = (url.searchParams.get('q') || '').slice(0,100), category = url.searchParams.get('category');
          const params = [`%${q}%`,`%${q}%`,`%${q}%`];
          let sql = `SELECT b.*,cat.name AS category,(SELECT COUNT(*) FROM book_copies c WHERE c.book_id=b.id AND c.availability<>'withdrawn') AS total_copies,(SELECT COUNT(*) FROM book_copies c WHERE c.book_id=b.id AND c.availability='available') AS available_copies FROM books b JOIN categories cat ON cat.id=b.category_id WHERE (LOWER(b.title) LIKE LOWER(?) OR LOWER(b.author) LIKE LOWER(?) OR LOWER(b.isbn) LIKE LOWER(?))`;
          if (category) { sql += ' AND cat.name=?'; params.push(category); }
          sql += ' ORDER BY b.title LIMIT 500';
          const books = (await db.query(sql,params)).rows;
          const categories = (await db.query('SELECT name FROM categories ORDER BY name')).rows.map(row => row.name);
          return json(res,200,{books,categories,limit:500});
        }
        if (path === '/api/books' && method === 'POST') return json(res,201,await saveBook(db,user,await body(req)));
        const bookMatch = /^\/api\/books\/([a-f0-9-]{36})$/.exec(path);
        const copyMatch = /^\/api\/books\/([a-f0-9-]{36})\/copies$/.exec(path);
        if(copyMatch && method==='GET'){
          const copies=(await db.query('SELECT id,barcode,availability FROM book_copies WHERE book_id=? ORDER BY barcode',[copyMatch[1]])).rows;
          return json(res,200,{copies});
        }
        if (bookMatch && method === 'PUT') return json(res,200,await saveBook(db,user,await body(req),bookMatch[1]));
        if (bookMatch && method === 'DELETE') {
          requireRole(user,'admin','librarian');
          await db.transaction(async tx => {
            if ((await tx.query('SELECT l.id FROM loans l JOIN book_copies c ON c.id=l.copy_id WHERE c.book_id=? LIMIT 1',[bookMatch[1]])).rows.length || (await tx.query('SELECT id FROM reservations WHERE book_id=? LIMIT 1',[bookMatch[1]])).rows.length) throw new HttpError(409,'A book with loan or request history cannot be deleted.');
            await tx.query('DELETE FROM book_copies WHERE book_id=?',[bookMatch[1]]);
            if (!(await tx.query('DELETE FROM books WHERE id=?',[bookMatch[1]])).changes) throw new HttpError(404,'Book not found.');
            await audit(tx,user,'book.deleted',bookMatch[1]);
          }); return json(res,200,{ok:true});
        }
        if (path === '/api/users' && method === 'GET') {
          requireRole(user,'admin','librarian');
          const users = (await db.query(`SELECT id,name,email,role,active,created_at FROM users${user.role === 'librarian' ? " WHERE role='member'" : ''} ORDER BY name LIMIT 1000`)).rows;
          return json(res,200,{users});
        }
        if (path === '/api/users' && method === 'POST') return json(res,201,await saveUser(db,user,await body(req)));
        const userMatch = /^\/api\/users\/([a-f0-9-]{36})$/.exec(path);
        if (userMatch && method === 'PUT') return json(res,200,await saveUser(db,user,await body(req),userMatch[1]));
        if (path === '/api/loans' && method === 'GET') {
          const params = [], filters = [];
          if (user.role === 'member') { filters.push('l.member_id=?'); params.push(user.id); }
          const status = url.searchParams.get('status');
          if (status === 'active') filters.push('l.returned_at IS NULL');
          if (status === 'returned') filters.push('l.returned_at IS NOT NULL');
          if (status === 'overdue') { filters.push('l.returned_at IS NULL AND l.due_at<?'); params.push(new Date().toISOString()); }
          const loans = (await db.query(`SELECT l.*,c.barcode,b.id AS book_id,b.title,b.isbn,u.name AS member_name,u.email AS member_email FROM loans l JOIN book_copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id JOIN users u ON u.id=l.member_id${filters.length ? ' WHERE '+filters.join(' AND ') : ''} ORDER BY l.borrowed_at DESC LIMIT 1000`,params)).rows;
          return json(res,200,{loans});
        }
        if (path === '/api/loans' && method === 'POST') return json(res,201,await issueLoan(db,user,await body(req)));
        const returnMatch = /^\/api\/loans\/([a-f0-9-]{36})\/return$/.exec(path);
        if (returnMatch && method === 'POST') return json(res,200,await returnLoan(db,user,returnMatch[1]));
        if (path === '/api/reservations' && method === 'GET') {
          const rows = (await db.query(`SELECT r.*,b.title,(SELECT COUNT(*) FROM book_copies c WHERE c.book_id=b.id AND c.availability='available') AS available_copies,u.name AS member_name FROM reservations r JOIN books b ON b.id=r.book_id JOIN users u ON u.id=r.member_id${user.role === 'member' ? ' WHERE r.member_id=?' : ''} ORDER BY r.created_at DESC LIMIT 1000`,user.role === 'member' ? [user.id] : [])).rows;
          return json(res,200,{reservations:rows});
        }
        if (path === '/api/reservations' && method === 'POST') return json(res,201,await reserveBook(db,user,await body(req)));
        const cancelMatch = /^\/api\/reservations\/([a-f0-9-]{36})\/cancel$/.exec(path);
        if (cancelMatch && method === 'POST') {
          await db.transaction(async tx => {
            const row = (await tx.query('SELECT * FROM reservations WHERE id=?',[cancelMatch[1]])).rows[0];
            if (!row) throw new HttpError(404,'Request not found.');
            if (user.role === 'member' && row.member_id !== user.id) throw new HttpError(403,'This request belongs to another member.');
            if (!(await tx.query('UPDATE reservations SET status=? WHERE id=? AND status=?',['cancelled',row.id,'pending'])).changes) throw new HttpError(409,'This request is no longer pending.');
            await audit(tx,user,'reservation.cancelled',row.id);
          }); return json(res,200,{ok:true});
        }
        if (path === '/api/reports' && method === 'GET') {
          requireRole(user,'admin','librarian');
          const circulation = (await db.query(`SELECT b.id,b.title,cat.name AS category,(SELECT COUNT(*) FROM book_copies c WHERE c.book_id=b.id AND c.availability<>'withdrawn') AS total_copies,(SELECT COUNT(*) FROM book_copies c WHERE c.book_id=b.id AND c.availability='available') AS available_copies,(SELECT COUNT(*) FROM loans l JOIN book_copies c ON c.id=l.copy_id WHERE c.book_id=b.id) AS total_loans FROM books b JOIN categories cat ON cat.id=b.category_id ORDER BY total_loans DESC,b.title`)).rows;
          if (url.searchParams.get('format') === 'csv') { res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="library-report.csv"'}); return res.end(csv(circulation)); }
          const auditRows = user.role === 'admin' ? (await db.query('SELECT a.action,a.target_id,a.created_at,u.name AS actor FROM audit_events a JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100')).rows : [];
          return json(res,200,{circulation,audit:auditRows});
        }
        if (path === '/api/benchmarks' && method === 'GET') { requireRole(user,'admin'); return json(res,200,{results:await getResults(),job:benchmarkJob,configured:!!(process.env.BENCH_MYSQL_URL && process.env.BENCH_COCKROACH_URL)}); }
        if (path === '/api/benchmarks' && method === 'POST') {
          requireRole(user,'admin');
          if (benchmarkJob?.status === 'running') throw new HttpError(409,'An experiment is already running.');
          if (!process.env.BENCH_MYSQL_URL || !process.env.BENCH_COCKROACH_URL) throw new HttpError(400,'Configure both benchmark database URLs in .env first.');
          const data = await body(req);
          const options = { rows:integer(data.rows ?? 1000,'Dataset rows',100,100000), operations:integer(data.operations ?? 300,'Operations',10,10000), concurrency:integer(data.concurrency ?? 5,'Concurrency',1,50), repetitions:integer(data.repetitions ?? 3,'Repetitions',1,10), warmup:30, output:resultsPath };
          benchmarkJob = {id:randomUUID(),status:'running',started_at:new Date().toISOString(),progress:'Connecting to databases'};
          const job = benchmarkJob;
          const { runBenchmark } = await import('../scripts/benchmark.js');
          runBenchmark({...options,onProgress:message => {job.progress=message;}}).then(result => {job.status='completed';job.result_id=result.id;}).catch(error => {job.status='failed';job.error=error.publicMessage || 'Experiment failed. Check the server log and database configuration.';console.error('Benchmark failed:',error.code || error.name);});
          return json(res,202,{job});
        }
        const exportMatch = /^\/api\/benchmarks\/([a-f0-9-]{36})\/(json|csv)$/.exec(path);
        if (exportMatch && method === 'GET') {
          requireRole(user,'admin');
          const result = (await getResults()).find(item => item.id === exportMatch[1]);
          if (!result) throw new HttpError(404,'Experiment not found.');
          res.writeHead(200,{'Content-Type':exportMatch[2] === 'json' ? 'application/json' : 'text/csv','Content-Disposition':`attachment; filename="benchmark-${result.id}.${exportMatch[2]}"`});
          return res.end(exportMatch[2] === 'json' ? JSON.stringify(result,null,2) : csv(result.measurements.map(({samples,...row})=>row)));
        }
        throw new HttpError(404,'Endpoint not found.');
      }
      if (!['GET','HEAD'].includes(method)) throw new HttpError(405,'Method not allowed.');
      const file = path === '/' ? 'index.html' : path.slice(1);
      // Serve only a small allowlist: no source, environment, or data files.
      if (!['index.html','app.js','style.css','favicon.svg'].includes(file)) throw new HttpError(404,'Page not found.');
      const data = await readFile(resolve(publicRoot,file));
      res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-cache'});
      res.end(method === 'HEAD' ? undefined : data);
    } catch (error) {
      const conflict = ['ER_DUP_ENTRY','23505','SQLITE_CONSTRAINT_UNIQUE'].includes(error.code) || /UNIQUE constraint failed/.test(error.message);
      const status = error.status || (conflict ? 409 : 500);
      if (status === 500) console.error('Request failed:',error.code || error.name);
      if (!res.headersSent) json(res,status,{error:conflict ? 'That email or catalogue code is already in use.' : error.status ? error.message : 'The request could not be completed.'}); else res.end();
    }
  });
  server.requestTimeout = 30000;
  return {server,db,close:async () => { await new Promise(resolve => server.close(resolve)); await db.close(); }};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createApp();
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  app.server.listen(port,host,() => console.log(`Library running at http://${host}:${port} (${app.db.engine})`));
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
}
