import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/server.js';
import { fixture } from './helpers.js';

test('HTTP: sessions, CSRF, role boundaries, privacy, loans and export',async()=>{
  const db=await openDatabase({path:':memory:'});const f=await fixture(db);
  const folder=await mkdtemp(join(tmpdir(),'library-api-'));
  const app=await createApp({db,origin:'http://localhost:3000',resultsPath:folder});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  async function request(path,{cookie='',body,method='GET',origin='http://localhost:3000',header=true}={}) {
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','Origin':origin,...(header ? {'X-Library-Request':'1'} : {}),...(cookie ? {Cookie:cookie} : {})},...(body ? {body:JSON.stringify(body)} : {})});
    return response;
  }
  async function login(user) {
    const response=await request('/api/auth/login',{method:'POST',body:{email:`${user.id}@example.com`,password:'test-password-123'}});
    assert.equal(response.status,200);const cookie=response.headers.get('set-cookie');assert.ok(cookie.includes('HttpOnly'));return cookie.split(';')[0];
  }
  try {
    assert.equal((await request('/api/users')).status,401);
    assert.equal((await request('/.env')).status,404);
    assert.equal((await request('/api/auth/login',{method:'POST',origin:'https://evil.example',body:{email:'x@example.com',password:'bad'}})).status,403);
    assert.equal((await request('/api/auth/login',{method:'POST',header:false,body:{email:'x@example.com',password:'bad'}})).status,403);
    const admin=await login(f.admin),member=await login(f.member),other=await login(f.other);
    assert.equal((await request('/api/users',{cookie:member})).status,403);
    assert.equal((await request('/api/benchmarks',{cookie:member})).status,403);
    assert.equal((await request('/api/reports',{cookie:member})).status,403);
    const created=await request('/api/loans',{cookie:admin,method:'POST',body:{book_id:f.book.id,member_id:f.member.id,days:14}});
    assert.equal(created.status,201);const loan=await created.json();
    const own=await (await request('/api/loans',{cookie:member})).json();assert.equal(own.loans.length,1);
    const others=await (await request('/api/loans',{cookie:other})).json();assert.equal(others.loans.length,0);
    assert.equal((await request(`/api/loans/${loan.id}/return`,{cookie:member,method:'POST',body:{}})).status,403);
    assert.equal((await request(`/api/loans/${loan.id}/return`,{cookie:admin,method:'POST',body:{}})).status,200);
    assert.equal((await request(`/api/loans/${loan.id}/return`,{cookie:admin,method:'POST',body:{}})).status,409);
    const exportResponse=await request('/api/reports?format=csv',{cookie:admin});assert.equal(exportResponse.status,200);assert.match(await exportResponse.text(),/Database Systems/);
    const userList=await (await request('/api/users',{cookie:admin})).json();assert.ok(userList.users.every(user=>!('password_hash' in user)));
    await request('/api/auth/logout',{cookie:member,method:'POST',body:{}});
    assert.equal((await request('/api/loans',{cookie:member})).status,401);
  } finally {await app.close();await rm(folder,{recursive:true,force:true});}
});
