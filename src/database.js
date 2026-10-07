import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export function isRetryable(error) {
  return error.code === '40001' || error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT';
}

export async function openDatabase({ engine = process.env.DB_ENGINE || 'sqlite', url, path = process.env.SQLITE_PATH || './data/library.sqlite', poolSize = Number(process.env.POOL_SIZE || 10) } = {}) {
  if (!['sqlite', 'mysql', 'cockroach'].includes(engine)) throw new Error('DB_ENGINE must be sqlite, mysql, or cockroach');
  let pool, sqlite;
  if (engine === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    sqlite = new DatabaseSync(path);
    sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  } else if (engine === 'mysql') {
    const mysql = await import('mysql2/promise');
    const connection = new URL(url || process.env.MYSQL_URL || '');
    pool = mysql.createPool({ host: connection.hostname, port: Number(connection.port || 3306), user: decodeURIComponent(connection.username), password: decodeURIComponent(connection.password), database: decodeURIComponent(connection.pathname.slice(1)), connectionLimit: poolSize, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: false, ...(connection.searchParams.get('ssl') === 'true' ? { ssl: { rejectUnauthorized: true } } : {}) });
  } else {
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(20, Number);
    pool = new pg.Pool({ connectionString: url || process.env.COCKROACH_URL, max: poolSize, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
    pool.on('error', () => {}); // Individual queries surface connection errors to callers.
  }
  const placeholders = (sql) => engine === 'cockroach' ? sql.replace(/\?/g, (() => { let i = 0; return () => `$${++i}`; })()) : sql;
  async function queryOn(connection, sql, params = []) {
    if (sqlite) {
      const stmt = sqlite.prepare(sql);
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) return { rows: stmt.all(...params), changes: 0 };
      const result = stmt.run(...params);
      return { rows: [], changes: Number(result.changes) };
    }
    if (engine === 'mysql') {
      const [result] = await connection.execute(sql, params);
      return { rows: Array.isArray(result) ? result : [], changes: Number(result.affectedRows || 0) };
    }
    const result = await connection.query(placeholders(sql), params);
    return { rows: result.rows, changes: Number(result.rowCount || 0) };
  }
  let queue = Promise.resolve();
  // SQLite has one connection: serialize whole async transactions, not individual statements.
  async function exclusive(fn) {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  async function transaction(fn, { onRetry = () => {}, attempts = 5 } = {}) {
    if (sqlite) return exclusive(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = await fn({ query: (sql, params) => queryOn(sqlite, sql, params), engine }); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    });
    for (let attempt = 0; attempt < attempts; attempt++) {
      const connection = engine === 'mysql' ? await pool.getConnection() : await pool.connect();
      try {
        if (engine === 'mysql') { await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'); await connection.beginTransaction(); }
        else await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await fn({ query: (sql, params) => queryOn(connection, sql, params), engine });
        if (engine === 'mysql') await connection.commit(); else await connection.query('COMMIT');
        return result;
      } catch (error) {
        try { if (engine === 'mysql') await connection.rollback(); else await connection.query('ROLLBACK'); } catch {}
        if (!isRetryable(error) || attempt === attempts - 1) throw error;
        onRetry(error);
        await pause(10 * 2 ** attempt + Math.floor(Math.random() * 10));
      } finally { connection.release(); }
    }
  }
  return {
    engine,
    query: (sql, params) => sqlite ? exclusive(() => queryOn(sqlite, sql, params)) : queryOn(pool, sql, params),
    transaction,
    close: async () => { if (sqlite) { await queue; sqlite.close(); } else await pool.end(); }
  };
}
