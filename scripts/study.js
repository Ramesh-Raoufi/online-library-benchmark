// Chapter 3 preset: the actual normalized application schema and weighted library operations.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, open, unlink, writeFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import { openDatabase } from '../src/database.js';
import { migrate } from '../src/schema.js';
import { issueLoan, returnLoan } from '../src/library.js';
import { measure, validateBenchmarkURL } from './benchmark.js';
import { csv, integer } from '../src/security.js';

const id=(type,n)=>`${String(type).padStart(8,'0')}-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
const reference='2026-10-07T00:00:00.000Z';
const actor={id:id(1,0),role:'admin'};
export function studyCounts(scale){return {books:Math.max(100,Math.round(100000*scale)),copies:Math.max(180,Math.round(180000*scale)),members:Math.max(50,Math.round(50000*scale)),categories:40,loans:Math.max(500,Math.round(500000*scale))};}
async function bulk(db,table,columns,count,row){
  for(let start=1;start<=count;start+=500){const n=Math.min(500,count-start+1);const params=[];for(let i=start;i<start+n;i++)params.push(...row(i));await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${Array(n).fill('('+columns.map(()=>'?').join(',')+')').join(',')}`,params);}
}
export async function loadStudy(db,counts){
  for(const table of ['audit_events','sessions','reservations','loans','book_copies','books','categories','users'])await db.query(`DELETE FROM ${table}`);
  await bulk(db,'categories',['id','name'],counts.categories,i=>[id(2,i),`Category ${i}`]);
  await db.query('INSERT INTO users (id,name,email,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)',[actor.id,'Benchmark operator','benchmark-operator@example.invalid','not-a-login-hash','admin',1,reference]);
  await bulk(db,'users',['id','name','email','password_hash','role','active','created_at'],counts.members,i=>[id(1,i),`Member ${String(i).padStart(8,'0')}`,`member${i}@example.invalid`,'not-a-login-hash','member',1,reference]);
  await bulk(db,'books',['id','title','author','isbn','category_id','shelf','created_at'],counts.books,i=>[id(3,i),`Library Book ${String(i).padStart(8,'0')}`,'Synthetic research author',`STUDY-ISBN-${i}`,id(2,(i%10<6 ? i%4 : i%40)+1),`S-${i%200}`,reference]);
  const active=Math.min(counts.copies,Math.floor(counts.loans*.1),counts.members);
  await bulk(db,'book_copies',['id','book_id','barcode','availability'],counts.copies,i=>[id(4,i),id(3,((i-1)%counts.books)+1),`STUDY-BARCODE-${i}`,i<=active ? 'borrowed' : 'available']);
  await bulk(db,'loans',['id','copy_id','member_id','issued_by','borrowed_at','due_at','returned_at','returned_by'],counts.loans,i=>{
    const isActive=i>counts.loans-active,copy=isActive ? i-(counts.loans-active) : ((i-1)%counts.copies)+1;
    return [id(5,i),id(4,copy),id(1,((i-1)%counts.members)+1),actor.id,'2026-09-01T00:00:00.000Z',new Date(Date.parse(reference)+(i%15-7)*86400000).toISOString(),isActive ? null : '2026-09-15T00:00:00.000Z',isActive ? null : actor.id];
  });
  const actual={};
  for(const [key,table] of Object.entries({books:'books',copies:'book_copies',members:'users',categories:'categories',loans:'loans'}))actual[key]=Number((await db.query(`SELECT COUNT(*) AS count FROM ${table}${key==='members' ? " WHERE role='member'" : ''}`)).rows[0].count);
  if(JSON.stringify(actual)!==JSON.stringify(counts))throw new Error('Study row-count validation failed');
  const hash=createHash('sha256');
  for(const table of ['categories','users','books','book_copies','loans']){
    const rows=(await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    for(const row of rows)hash.update(JSON.stringify(Object.keys(row).sort().map(key=>[key,row[key]]))+'\n');
  }
  return {checksum:hash.digest('hex'),active};
}
// Exact 100-operation schedule; shuffle once with a fixed LCG seed before timing.
export function operationPlan(){
  const plan=[...Array(15).fill('member_lookup'),...Array(20).fill('book_lookup'),...Array(30).fill('catalog_search'),...Array(12).fill('checkout'),...Array(8).fill('return'),...Array(10).fill('admin_write'),...Array(5).fill('due_query')];
  let seed=20261007;for(let i=plan.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[plan[i],plan[j]]=[plan[j],plan[i]];}return plan;
}
export function mixedOperation(db,counts,active){
  const plan=operationPlan();
  const returns=Array.from({length:active},(_,i)=>id(5,counts.loans-active+i+1));let returnCursor=0;
  return async (index,onRetry)=>{
    const operation=plan[index%100],book=((index*7919)%counts.books)+1,member=((index*3571)%counts.members)+1;
    if(operation==='member_lookup')await db.query('SELECT id,name,active FROM users WHERE id=?',[id(1,member)]);
    if(operation==='book_lookup')await db.query('SELECT id,title,author FROM books WHERE isbn=?',[`STUDY-ISBN-${book}`]);
    if(operation==='catalog_search')await db.query('SELECT id,title,isbn FROM books WHERE category_id=? ORDER BY title LIMIT 20',[id(2,(index%40)+1)]);
    if(operation==='due_query')await db.query('SELECT id,member_id,copy_id,due_at FROM loans WHERE returned_at IS NULL AND due_at<? ORDER BY due_at LIMIT 20',[reference]);
    if(operation==='admin_write'){
      if(index%2)await db.query('UPDATE books SET author=? WHERE id=?',[`Updated synthetic author ${index}`,id(3,book)]);
      else await db.transaction(async tx=>{const bookId=id(6,index+1),copyId=id(7,index+1);await tx.query('INSERT INTO books (id,title,author,isbn,category_id,shelf,created_at) VALUES (?,?,?,?,?,?,?)',[bookId,`Inserted Book ${index}`,'Synthetic author',`INSERT-${index}`,id(2,1),'NEW',reference]);await tx.query('INSERT INTO book_copies (id,book_id,barcode,availability) VALUES (?,?,?,?)',[copyId,bookId,`INSERT-BARCODE-${index}`,'available']);},{onRetry});
    }
    if(operation==='checkout'){
      const loan=await issueLoan(db,actor,{book_id:id(3,book),member_id:id(1,member),days:14},{onRetry});returns.push(loan.id);
    }
    if(operation==='return'){
      const loanId=returns[returnCursor++];
      if(!loanId){const error=new Error('No pending return in generated workload');error.code='NO_PENDING_RETURN';throw error;}
      await returnLoan(db,actor,loanId,{onRetry});
    }
    return operation;
  };
}
export async function runStudy(){
  const scale=Number(process.env.STUDY_SCALE || '.01');if(!Number.isFinite(scale)||scale<.001||scale>1)throw new Error('STUDY_SCALE must be between .001 and 1');
  const counts=studyCounts(scale),operations=integer(process.env.STUDY_OPERATIONS || 1000,'Operations',100,100000),warmup=integer(process.env.STUDY_WARMUP || 100,'Warmup',0,10000),repetitions=integer(process.env.STUDY_REPETITIONS || 5,'Repetitions',1,10);
  const durationSeconds=integer(process.env.STUDY_DURATION_SECONDS || 0,'Measured seconds',0,3600),warmupSeconds=integer(process.env.STUDY_WARMUP_SECONDS || 0,'Warmup seconds',0,3600);
  const concurrency=(process.env.STUDY_CONCURRENCY || '1,10,25,50,100').split(',').map(x=>integer(x,'Concurrency',1,100));
  const output=resolve(import.meta.dirname,'../results');await mkdir(output,{recursive:true});let lock;const dbs=[];
  try{
    lock=await open(resolve(output,'.benchmark.lock'),'wx');await lock.writeFile(String(process.pid));
    for(const [engine,key] of [['mysql','BENCH_MYSQL_URL'],['cockroach','BENCH_COCKROACH_URL']]){const url=validateBenchmarkURL(process.env[key],key);const db=await openDatabase({engine,url:url.href,poolSize:Number(process.env.POOL_SIZE || 10)});dbs.push(db);await migrate(db);}
    const result={id:randomUUID(),created_at:new Date().toISOString(),profile:'chapter-3-normalized-mixed',status:'measured',settings:{scale,counts,operations,warmup,duration_seconds:durationSeconds,warmup_seconds:warmupSeconds,repetitions,concurrency,pool_size:Number(process.env.POOL_SIZE || 10),reference_date:reference,seed:20261007},host:{node:process.version,cpu:os.cpus()[0]?.model,memory_bytes:os.totalmem()},database_versions:{},baseline_checks:[],warmup_summaries:[],measurements:[],methodology:{scope:'Same application transactions and normalized physical-copy model. Count-bounded pilot by default, optional fixed-duration protocol.',mix:'15% member lookup; 20% book lookup; 30% catalogue search; 12% checkout; 8% return; 10% admin write; 5% due queries. Exact shares for multiples of 100; timed runs may end mid-cycle.',latency:'Direct driver or application transaction time, excluding HTTP and auth. Application transactions include audit writes. Measured failures include domain rejections such as out-of-stock or duplicate active loans.',instrumentation:'Timed-run raw samples stream to NDJSON. Recording happens outside individual latency timing but contributes to closed-loop elapsed time and therefore throughput.',limits:'No automatic database CPU/memory, failover or multi-region claims. Queue updates connect checkout and return operations. Long runs can exhaust stock; retain error codes.'}};
    for(const db of dbs)result.database_versions[db.engine]=(await db.query('SELECT version() AS version')).rows[0].version;
    for(let repetition=1;repetition<=repetitions;repetition++)for(const workers of concurrency){
      const checks={};for(const db of repetition%2 ? dbs : [...dbs].reverse()){
        console.log(`Study ${repetition}/${repetitions}, ${workers} workers, ${db.engine}: loading baseline`);
        let baseline=await loadStudy(db,counts);checks[db.engine]=baseline.checksum;
        if(warmup||warmupSeconds){const {samples,...warm}=await measure(mixedOperation(db,counts,baseline.active),warmup,workers,{durationSeconds:warmupSeconds,keepSamples:false});result.warmup_summaries.push({engine:db.engine,repetition,concurrency:workers,...warm});}
        baseline=await loadStudy(db,counts);
        let measurement;
        if(durationSeconds){
          const rawName=`study-${result.id}-${db.engine}-r${repetition}-c${workers}.ndjson`,stream=createWriteStream(resolve(output,rawName),{flags:'wx'});
          let writeError;stream.on('error',error=>{writeError=error;});
          try{
            measurement=await measure(mixedOperation(db,counts,baseline.active),operations,workers,{durationSeconds,keepSamples:false,onSample:async sample=>{if(writeError)throw writeError;if(!stream.write(JSON.stringify(sample)+'\n'))await once(stream,'drain');}});
            stream.end();await once(stream,'close');if(writeError)throw writeError;measurement.raw_samples_file=rawName;
          }finally{if(!stream.closed)stream.destroy();}
        }else measurement=await measure(mixedOperation(db,counts,baseline.active),operations,workers);
        result.measurements.push({engine:db.engine,workload:'normalized_library_mix',repetition,concurrency:workers,...measurement});
        await writeFile(resolve(output,`checkpoint-${result.id}.json`),JSON.stringify({...result,status:'partial'},null,2));
      }
      if(checks.mysql!==checks.cockroach)throw new Error('Normalized study baselines do not match');
      result.baseline_checks.push({repetition,concurrency:workers,checksum:checks.mysql});
    }
    result.completed_at=new Date().toISOString();if(result.measurements.some(m=>m.failed))result.status='measured_with_errors';
    const path=resolve(output,`study-${result.id}.json`);await writeFile(path+'.tmp',JSON.stringify(result,null,2));await rename(path+'.tmp',path);await writeFile(resolve(output,`study-${result.id}.csv`),csv(result.measurements.map(({samples,...row})=>row)));console.log(`Study results saved: ${path}`);return result;
  }finally{for(const db of dbs)await db.close();if(lock){await lock.close();await unlink(resolve(output,'.benchmark.lock'));}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await runStudy();}catch(error){console.error(error.code==='EEXIST' ? 'Another experiment holds results/.benchmark.lock.' : error.message);process.exitCode=1;}}
