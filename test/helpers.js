import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/schema.js';
import { hashPassword } from '../src/security.js';
import { saveBook, issueLoan, returnLoan, reserveBook, saveUser } from '../src/library.js';

export async function fixture(db) {
  await migrate(db);
  const admin={id:randomUUID(),role:'admin'}, member={id:randomUUID(),role:'member'}, other={id:randomUUID(),role:'member'};
  for(const [user,name] of [[admin,'Admin'],[member,'Member'],[other,'Other']]) await db.query('INSERT INTO users (id,name,email,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)',[user.id,name,`${user.id}@example.com`,await hashPassword('test-password-123'),user.role,1,new Date().toISOString()]);
  const book=await saveBook(db,admin,{title:'Database Systems',author:'Test Author',isbn:randomUUID(),category:'Databases',shelf:'A-01',total_copies:1});
  return {admin,member,other,book};
}
export async function circulationChecks(db) {
  const f=await fixture(db);
  // Concurrent borrowers race for the only copy: exactly one can succeed.
  const loans=await Promise.allSettled([issueLoan(db,f.admin,{book_id:f.book.id,member_id:f.member.id}),issueLoan(db,f.admin,{book_id:f.book.id,member_id:f.other.id})]);
  assert.equal(loans.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(Number((await db.query("SELECT COUNT(*) AS available_copies FROM book_copies WHERE book_id=? AND availability='available'",[f.book.id])).rows[0].available_copies),0);
  const loan=loans.find(x=>x.status==='fulfilled').value;
  await assert.rejects(()=>saveBook(db,f.admin,{title:'Book',author:'Author',isbn:'code',category:'DB',shelf:'A',total_copies:0},f.book.id));
  await returnLoan(db,f.admin,loan.id);
  await assert.rejects(()=>returnLoan(db,f.admin,loan.id),/already been returned/);
  assert.equal(Number((await db.query("SELECT COUNT(*) AS available_copies FROM book_copies WHERE book_id=? AND availability='available'",[f.book.id])).rows[0].available_copies),1);
  const requests=await Promise.allSettled([reserveBook(db,f.member,{book_id:f.book.id}),reserveBook(db,f.member,{book_id:f.book.id})]);
  assert.equal(requests.filter(x=>x.status==='fulfilled').length,1);
  await issueLoan(db,f.admin,{book_id:f.book.id,member_id:f.member.id});
  assert.equal((await db.query('SELECT status FROM reservations WHERE member_id=?',[f.member.id])).rows[0].status,'fulfilled');
  await assert.rejects(()=>issueLoan(db,f.member,{book_id:f.book.id,member_id:f.other.id}),/permission/);
  await assert.rejects(()=>saveUser(db,f.member,{name:'x',email:'x@example.com',role:'admin',password:'password-123'}),/permission/);
  await assert.rejects(()=>saveUser(db,f.admin,{name:'Admin',email:'admin@example.com',role:'member',active:0},f.admin.id),/own administrator/);
}
