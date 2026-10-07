import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { migrate } from '../src/schema.js';
import { hashPassword, csv } from '../src/security.js';
import { saveBook, issueLoan, returnLoan, reserveBook, saveUser } from '../src/library.js';
import { validateBenchmarkURL, measure, summarize, resetDataset, datasetChecksum } from '../scripts/benchmark.js';

import { fixture, circulationChecks } from './helpers.js';

test('SQLite: concurrent stock, double returns, reservation fulfilment and role restrictions',async()=>{const db=await openDatabase({path:':memory:'});try{await circulationChecks(db);}finally{await db.close();}});
test('transaction rollback restores stock after failure',async()=>{const db=await openDatabase({path:':memory:'});try{const f=await fixture(db);await assert.rejects(()=>db.transaction(async tx=>{await tx.query("UPDATE book_copies SET availability='borrowed' WHERE book_id=?",[f.book.id]);throw new Error('intentional');}));assert.equal((await db.query("SELECT COUNT(*) AS available_copies FROM book_copies WHERE book_id=? AND availability='available'",[f.book.id])).rows[0].available_copies,1);}finally{await db.close();}});
test('foreign keys reject loans for nonexistent books',async()=>{const db=await openDatabase({path:':memory:'});try{const f=await fixture(db);await assert.rejects(()=>db.query('INSERT INTO loans (id,copy_id,member_id,issued_by,borrowed_at,due_at) VALUES (?,?,?,?,?,?)',[randomUUID(),randomUUID(),f.member.id,f.admin.id,'2026-01-01','2026-02-01']));}finally{await db.close();}});
test('benchmark refuses application database URLs',()=>{assert.throws(()=>validateBenchmarkURL('mysql://user:password@localhost/library','DB'),/_benchmark/);assert.equal(validateBenchmarkURL('mysql://user:password@localhost/library_benchmark','DB').pathname,'/library_benchmark');});
test('benchmark summary excludes failed latency and preserves errors',()=>{const result=summarize([{ok:true,latency_ms:1},{ok:true,latency_ms:3},{ok:false,latency_ms:999}],1000,2);assert.equal(result.mean_ms,2);assert.equal(result.p95_ms,3);assert.equal(result.failed,1);assert.equal(result.throughput_ops_s,2);assert.equal(result.retries,2);});
test('worker pool never exceeds requested concurrency; failed operations remain in samples',async()=>{let running=0,maximum=0;const result=await measure(async i=>{running++;maximum=Math.max(maximum,running);await new Promise(r=>setTimeout(r,2));running--;if(i===3)throw new Error('expected');},20,3);assert.equal(result.samples.length,20);assert.equal(result.failed,1);assert.ok(maximum<=3);assert.equal(result.successful,19);});
test('CSV neutralizes spreadsheet formula values',()=>{const content=csv([{title:'=HYPERLINK("bad")',amount:1}]);assert.ok(content.includes("'=HYPERLINK"));});
test('fixed-duration measurement streams all outcomes and respects a deadline',async()=>{
  const recorded=[];const result=await measure(async()=>{await new Promise(r=>setTimeout(r,2));},1,2,{durationSeconds:.03,keepSamples:false,onSample:sample=>recorded.push(sample)});
  assert.ok(result.elapsed_ms>=30);assert.ok(result.successful>1);assert.equal(recorded.length,result.successful);assert.equal(result.samples.length,0);
});
test('librarian can register members but cannot grant staff or alter administrators',async()=>{
  const db=await openDatabase({path:':memory:'});try{
    const f=await fixture(db);const created=await saveUser(db,f.admin,{name:'Librarian',email:'librarian@example.com',role:'librarian',password:'librarian-pass-123'});
    const librarian={id:created.id,role:'librarian'};
    const member=await saveUser(db,librarian,{name:'New Member',email:'newmember@example.com',role:'member',password:'member-pass-123'});assert.ok(member.id);
    await assert.rejects(()=>saveUser(db,librarian,{name:'Admin',email:'newadmin@example.com',role:'admin',password:'admin-pass-123'}),/member accounts only/);
    await assert.rejects(()=>saveUser(db,librarian,{name:'Admin',email:'admin@example.com',role:'member',active:1},f.admin.id),/member accounts only/);
  }finally{await db.close();}
});
