import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { circulationChecks } from './helpers.js';
// Opt-in real-engine tests; only use isolated databases with names ending _test.
for(const [engine,name] of [['mysql','TEST_MYSQL_URL'],['cockroach','TEST_COCKROACH_URL']]) {
  test(`${engine}: real-engine migration and circulation invariants`,{skip:!process.env[name]},async()=>{
    assert.ok(new URL(process.env[name]).pathname.endsWith('_test'),'Use a disposable _test database');
    const db=await openDatabase({engine,url:process.env[name]});
    try {await circulationChecks(db);}finally{await db.close();}
  });
}
