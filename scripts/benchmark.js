import { performance } from 'node:perf_hooks';
import { mkdir, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import { openDatabase } from '../src/database.js';
import { csv, integer } from '../src/security.js';

export function validateBenchmarkURL(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} is required and must be a valid connection URL.`); }
  if (!decodeURIComponent(url.pathname.slice(1)).endsWith('_benchmark')) throw new Error(`${label} database name must end with _benchmark. Library data must never be benchmarked destructively.`);
  return url;
}
export function summarize(samples, elapsedMs, retries) {
  const good = samples.filter(x => x.ok).map(x => x.latency_ms).sort((a,b) => a-b);
  return summarizeLatencies(good,samples.length,elapsedMs,retries);
}
function summarizeLatencies(good,total,elapsedMs,retries){
  const percentile = p => good.length ? good[Math.max(0,Math.ceil(good.length*p)-1)] : null;
  return { successful:good.length, failed:total-good.length, retries, elapsed_ms:elapsedMs,
    throughput_ops_s:good.length/(elapsedMs/1000), mean_ms:good.length ? good.reduce((a,b)=>a+b,0)/good.length : null,
    median_ms:percentile(0.5), p95_ms:percentile(0.95), p99_ms:percentile(0.99) };
}
export async function measure(operation, count, concurrency, {durationSeconds=0,keepSamples=true,onSample}={}) {
  let next = 0, retries = 0;
  const samples = [],latencies=[];
  const started = performance.now();
  const deadline=started+durationSeconds*1000;
  await Promise.all(Array.from({length:concurrency},async () => {
    while (durationSeconds ? performance.now()<deadline : next < count) {
      const index = next++, before = performance.now();
      let sample;
      try { const outcome=await operation(index,()=>retries++); sample={index,ok:true,latency_ms:performance.now()-before,...(typeof outcome==='string' ? {operation:outcome} : {})};latencies.push(sample.latency_ms); }
      catch (error) { sample={index,ok:false,latency_ms:performance.now()-before,error_code:error.code || (error.status ? `DOMAIN_${error.status}` : error.name)}; }
      if(keepSamples)samples.push(sample);
      if(onSample)await onSample(sample);
    }
  }));
  const elapsed=performance.now()-started;
  latencies.sort((a,b)=>a-b);
  return { ...summarizeLatencies(latencies,next,elapsed,retries), samples:samples.sort((a,b)=>a.index-b.index) };
}
async function schema(db) {
  await db.query('CREATE TABLE IF NOT EXISTS bench_books (id INTEGER PRIMARY KEY,title VARCHAR(120) NOT NULL,category VARCHAR(40) NOT NULL,available INTEGER NOT NULL CHECK(available>=0),revision INTEGER NOT NULL)');
  await db.query('CREATE TABLE IF NOT EXISTS bench_loans (id INTEGER PRIMARY KEY,book_id INTEGER NOT NULL,member_id INTEGER NOT NULL,FOREIGN KEY(book_id) REFERENCES bench_books(id))');
  for (const [name,table,column] of [['idx_bench_title','bench_books','title'],['idx_bench_category','bench_books','category'],['idx_bench_book','bench_loans','book_id']]) {
    try { await db.query(`CREATE INDEX ${db.engine === 'mysql' ? '' : 'IF NOT EXISTS '}${name} ON ${table} (${column})`); }
    catch(error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
  }
}
export async function resetDataset(db, rows) {
  await db.query('DELETE FROM bench_loans'); await db.query('DELETE FROM bench_books');
  // Identical deterministic records, in equally sized transactions on both engines.
  for (let start = 1; start <= rows; start += 100) await db.transaction(async tx => {
    for (let id = start; id < Math.min(start+100,rows+1); id++) {
      await tx.query('INSERT INTO bench_books (id,title,category,available,revision) VALUES (?,?,?,?,?)',[id,`Book ${String(id).padStart(8,'0')}`,`Category ${id%10}`,10,0]);
      await tx.query('INSERT INTO bench_loans (id,book_id,member_id) VALUES (?,?,?)',[id,id,(id%100)+1]);
    }
  });
}
export async function datasetChecksum(db) {
  const books = (await db.query('SELECT id,title,category,available,revision FROM bench_books ORDER BY id')).rows;
  const loans = (await db.query('SELECT id,book_id,member_id FROM bench_loans ORDER BY id')).rows;
  // Avoid driver object/prototype/key-order differences.
  return createHash('sha256').update(JSON.stringify({books:books.map(b=>[Number(b.id),b.title,b.category,Number(b.available),Number(b.revision)]),loans:loans.map(l=>[Number(l.id),Number(l.book_id),Number(l.member_id)])})).digest('hex');
}
export function workload(db, name, rows) {
  const key = i => ((i*7919)%rows)+1;
  if (name === 'point_read') return i => db.query('SELECT id,title,category,available FROM bench_books WHERE id=?',[key(i)]);
  if (name === 'catalog_search') return i => db.query('SELECT id,title,available FROM bench_books WHERE category=? ORDER BY title LIMIT 20',[`Category ${i%10}`]);
  if (name === 'loan_join') return i => db.query('SELECT l.id,l.member_id,b.title FROM bench_loans l JOIN bench_books b ON b.id=l.book_id WHERE l.book_id=?',[key(i)]);
  if (name === 'insert') return i => db.query('INSERT INTO bench_books (id,title,category,available,revision) VALUES (?,?,?,?,?)',[rows+i+1,`New Book ${i}`,'New',10,0]);
  if (name === 'update') return i => db.query('UPDATE bench_books SET revision=revision+1 WHERE id=?',[key(i)]);
  if (name === 'borrow_return_transaction') return (i,onRetry) => db.transaction(async tx => {
    const id = key(i);
    const changed = await tx.query('UPDATE bench_books SET available=available-1 WHERE id=? AND available>0',[id]);
    if (!changed.changes) throw new Error('Dataset stock invariant failed');
    const loanId = rows+i+1;
    await tx.query('INSERT INTO bench_loans (id,book_id,member_id) VALUES (?,?,?)',[loanId,id,(i%100)+1]);
    await tx.query('DELETE FROM bench_loans WHERE id=?',[loanId]);
    await tx.query('UPDATE bench_books SET available=available+1 WHERE id=?',[id]);
  },{onRetry});
  throw new Error('Unknown workload');
}
export async function runBenchmark(options = {}) {
  const settings = {
    rows:integer(options.rows ?? process.env.BENCH_ROWS ?? 1000,'Rows',100,100000),
    operations:integer(options.operations ?? process.env.BENCH_OPERATIONS ?? 300,'Operations',10,10000),
    concurrency:integer(options.concurrency ?? process.env.BENCH_CONCURRENCY ?? 5,'Concurrency',1,50),
    repetitions:integer(options.repetitions ?? process.env.BENCH_REPETITIONS ?? 3,'Repetitions',1,10),
    warmup:integer(options.warmup ?? process.env.BENCH_WARMUP ?? 30,'Warmup',0,1000),
    pool_size:integer(process.env.POOL_SIZE ?? 10,'Pool size',1,100)
  };
  const mysqlURL = validateBenchmarkURL(options.mysqlURL || process.env.BENCH_MYSQL_URL,'BENCH_MYSQL_URL');
  const cockroachURL = validateBenchmarkURL(options.cockroachURL || process.env.BENCH_COCKROACH_URL,'BENCH_COCKROACH_URL');
  const output = options.output || resolve(import.meta.dirname,'../results'), progress = options.onProgress || console.log;
  const dbs = [];
  await mkdir(output,{recursive:true});
  const lockPath=resolve(output,'.benchmark.lock');
  let lock;
  try {
    try { lock=await open(lockPath,'wx'); await lock.writeFile(String(process.pid)); }
    catch(error) { if(error.code==='EEXIST')throw new Error('A runner already holds results/.benchmark.lock. If it crashed, confirm it is stopped before removing the lock.');throw error; }
    const mysql = await openDatabase({engine:'mysql',url:mysqlURL.href,poolSize:settings.pool_size}); dbs.push(mysql);
    const cockroach = await openDatabase({engine:'cockroach',url:cockroachURL.href,poolSize:settings.pool_size}); dbs.push(cockroach);
    const result = { id:randomUUID(),created_at:new Date().toISOString(),status:'measured',settings,
      methodology:{ scope:'Direct database-driver closed-loop measurements. HTTP, authentication and page rendering are excluded.', isolation:'SERIALIZABLE for multi-statement transactions on both engines; reads/writes otherwise use autocommit.', engines_run:'Sequentially; engine order alternates per repetition.', reset:'Both engines reset to the same baseline before every warmup and measured workload.', latency:'Successful end-to-end driver operation time, including pool waits and transaction retries. Failed-operation times remain in raw samples.', topology:'Not inferred. Record server node counts, resources, network distance, storage and versions separately before citing results.', limits:'Closed-loop throughput is not maximum sustainable throughput. A single-node experiment cannot establish distributed scalability, availability or failover performance.' },
      host:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,cpu_count:os.cpus().length,total_memory_bytes:os.totalmem(),client_hostname:os.hostname()},
      database_versions:{},dataset_checksums:[],measurements:[] };
    for (const db of dbs) { await schema(db); result.database_versions[db.engine]=(await db.query('SELECT version() AS version')).rows[0].version; }
    // Open the same number of connections and warm all pools before timing.
    for (const db of dbs) await Promise.all(Array.from({length:settings.pool_size},()=>db.query('SELECT 1 AS ready')));
    const names = ['point_read','catalog_search','loan_join','insert','update','borrow_return_transaction'];
    for (let repetition=1;repetition<=settings.repetitions;repetition++) {
      const order = repetition%2 ? dbs : [...dbs].reverse();
      for (const name of names) {
        const checks = {};
        for (const db of order) {
          progress(`Repetition ${repetition}/${settings.repetitions}: ${db.engine} / ${name}`);
          await resetDataset(db,settings.rows);
          checks[db.engine]=await datasetChecksum(db);
          if (settings.warmup) {
            const warmup = await measure(workload(db,name,settings.rows),settings.warmup,settings.concurrency);
            if (warmup.failed) throw new Error(`Warmup failed for ${db.engine}/${name}. No result was saved.`);
          }
          // Warmup writes must not change the measured baseline.
          await resetDataset(db,settings.rows);
          const measurement = await measure(workload(db,name,settings.rows),settings.operations,settings.concurrency);
          result.measurements.push({engine:db.engine,workload:name,repetition,...measurement});
          const invariants=(await db.query('SELECT COUNT(*) AS bad FROM bench_books WHERE available<>10')).rows[0];
          if (Number(invariants.bad)!==0) throw new Error('Stock invariant failed after measurement');
        }
        if (checks.mysql !== checks.cockroach) throw new Error('Benchmark datasets do not match');
        result.dataset_checksums.push({repetition,workload:name,checksum:checks.mysql});
      }
    }
    result.completed_at=new Date().toISOString();
    result.status=result.measurements.some(m=>m.failed) ? 'measured_with_errors' : 'measured';
    await mkdir(output,{recursive:true});
    const filename=resolve(output,`benchmark-${result.id}.json`);
    await writeFile(`${filename}.tmp`,JSON.stringify(result,null,2)); await rename(`${filename}.tmp`,filename);
    await writeFile(resolve(output,`benchmark-${result.id}.csv`),csv(result.measurements.map(({samples,...row})=>row)));
    progress(`Saved measured results: ${filename}`);
    return result;
  } finally {
    for (const db of dbs) await db.close();
    if(lock){await lock.close();await unlink(lockPath);}
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runBenchmark(); }
  catch(error) { console.error(error.message); process.exitCode=1; }
}
