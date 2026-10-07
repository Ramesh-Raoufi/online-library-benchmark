import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { migrate } from '../src/schema.js';
import { loadStudy,studyCounts,operationPlan,mixedOperation } from '../scripts/study.js';
import { measure } from '../scripts/benchmark.js';
test('study full-scale counts and exact operation mix match Chapter 3',()=>{
  assert.deepEqual(studyCounts(1),{books:100000,copies:180000,members:50000,categories:40,loans:500000});
  const counts={};for(const name of operationPlan())counts[name]=(counts[name] || 0)+1;
  assert.deepEqual(counts,Object.fromEntries(Object.entries({member_lookup:15,book_lookup:20,catalog_search:30,checkout:12,return:8,admin_write:10,due_query:5}).map(([key,value])=>[key,value])));
});
test('normalized mixed workload preserves physical-copy/active-loan consistency',async()=>{
  const db=await openDatabase({path:':memory:'});try{
    await migrate(db);const counts=studyCounts(.001);const baseline=await loadStudy(db,counts);
    const result=await measure(mixedOperation(db,counts,baseline.active),200,3);
    assert.equal(result.samples.length,200);assert.ok(result.successful>150);
    const duplicates=(await db.query('SELECT copy_id FROM loans WHERE returned_at IS NULL GROUP BY copy_id HAVING COUNT(*)>1')).rows;assert.equal(duplicates.length,0);
    const invalid=(await db.query("SELECT COUNT(*) AS bad FROM loans l JOIN book_copies c ON c.id=l.copy_id WHERE l.returned_at IS NULL AND c.availability<>'borrowed'")).rows[0].bad;assert.equal(invalid,0);
  }finally{await db.close();}
});
test('normalized study generation is reproducible and all active loans match borrowed copies',async()=>{
  const db=await openDatabase({path:':memory:'});try{
    await migrate(db);const counts=studyCounts(.001);const first=await loadStudy(db,counts);const second=await loadStudy(db,counts);assert.equal(first.checksum,second.checksum);
    const invalid=(await db.query("SELECT COUNT(*) AS bad FROM loans l JOIN book_copies c ON c.id=l.copy_id WHERE l.returned_at IS NULL AND c.availability<>'borrowed'")).rows[0].bad;assert.equal(invalid,0);
    const active=(await db.query('SELECT COUNT(*) AS count FROM loans WHERE returned_at IS NULL')).rows[0].count;assert.equal(active,first.active);
  }finally{await db.close();}
});
