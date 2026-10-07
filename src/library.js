import { randomUUID } from 'node:crypto';
import { HttpError, requireRole, text, integer, email, hashPassword } from './security.js';
const now = () => new Date().toISOString();
export async function audit(tx, actor, action, id) {
  await tx.query('INSERT INTO audit_events (id,actor_id,action,target_id,created_at) VALUES (?,?,?,?,?)', [randomUUID(), actor.id, action, id, now()]);
}
const bookFields = body => [text(body.title, 'Title'), text(body.author, 'Author', 150), text(body.isbn, 'ISBN / catalogue code', 40), text(body.category, 'Category', 80), text(body.shelf, 'Shelf', 40), integer(body.total_copies, 'Copies', 1, 10000)];
export async function saveBook(db, user, body, id) {
  requireRole(user, 'admin', 'librarian');
  const fields = bookFields(body);
  return db.transaction(async tx => {
    const stamp = now();
    let category = (await tx.query('SELECT id FROM categories WHERE name=?',[fields[3]])).rows[0];
    if(!category){category={id:randomUUID()};await tx.query('INSERT INTO categories (id,name) VALUES (?,?)',[category.id,fields[3]]);}
    let current = 0;
    if (id) {
      const old = (await tx.query('SELECT * FROM books WHERE id=?', [id])).rows[0];
      if (!old) throw new HttpError(404, 'Book not found.');
      const counts=(await tx.query("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN availability='borrowed' THEN 1 ELSE 0 END),0) AS borrowed FROM book_copies WHERE book_id=? AND availability<>'withdrawn'",[id])).rows[0];
      current=Number(counts.total);
      const borrowed=Number(counts.borrowed);
      if (fields[5] < borrowed) throw new HttpError(409, 'Copies cannot be fewer than the books currently on loan.');
      await tx.query('UPDATE books SET title=?,author=?,isbn=?,category_id=?,shelf=? WHERE id=?', [fields[0],fields[1],fields[2],category.id,fields[4],id]);
    } else {
      id = randomUUID();
      await tx.query('INSERT INTO books (id,title,author,isbn,category_id,shelf,created_at) VALUES (?,?,?,?,?,?,?)', [id,fields[0],fields[1],fields[2],category.id,fields[4],stamp]);
    }
    if(fields[5] > current){
      for(let i=current;i<fields[5];i++){const copyId=randomUUID();await tx.query('INSERT INTO book_copies (id,book_id,barcode,availability) VALUES (?,?,?,?)',[copyId,id,`LIB-${copyId.toUpperCase()}`,'available']);}
    }else if(fields[5] < current){
      const copies=(await tx.query("SELECT id FROM book_copies WHERE book_id=? AND availability='available' ORDER BY id",[id])).rows;
      for(const copy of copies.slice(0,current-fields[5]))await tx.query("UPDATE book_copies SET availability='withdrawn' WHERE id=? AND availability='available'",[copy.id]);
    }
    await audit(tx, user, 'book.saved', id);
    return { id };
  });
}
export async function issueLoan(db, user, body, transactionOptions) {
  requireRole(user, 'admin', 'librarian');
  const bookId = text(body.book_id, 'Book', 36), memberId = text(body.member_id, 'Member', 36);
  const days = integer(body.days ?? 14, 'Loan days', 1, 90);
  return db.transaction(async tx => {
    // The conditional update is atomic; rollback restores stock if any later step fails.
    const member = (await tx.query('SELECT id FROM users WHERE id=? AND role=? AND active=1', [memberId, 'member'])).rows[0];
    if (!member) throw new HttpError(400, 'Choose an active member.');
    const existing = (await tx.query('SELECT l.id FROM loans l JOIN book_copies c ON c.id=l.copy_id WHERE c.book_id=? AND l.member_id=? AND l.returned_at IS NULL', [bookId, memberId])).rows;
    if (existing.length) throw new HttpError(409, 'This member already has this book on loan.');
    const requestedCopy=body.copy_id ? text(body.copy_id,'Copy',36) : null;
    const copy=(await tx.query(`SELECT id FROM book_copies WHERE book_id=? AND availability=?${requestedCopy ? ' AND id=?' : ''} ORDER BY id LIMIT 1${tx.engine==='sqlite' ? '' : ' FOR UPDATE'}`,[bookId,'available',...(requestedCopy ? [requestedCopy] : [])])).rows[0];
    if(!copy)throw new HttpError(409,'No copy is available.');
    const changed = await tx.query('UPDATE book_copies SET availability=? WHERE id=? AND availability=?', ['borrowed',copy.id,'available']);
    if (!changed.changes) throw new HttpError(409, 'No copy is available.');
    const id = randomUUID(), borrowed = now(), due = new Date(Date.now() + days * 86400000).toISOString();
    await tx.query('INSERT INTO loans (id,copy_id,member_id,issued_by,borrowed_at,due_at) VALUES (?,?,?,?,?,?)', [id, copy.id, memberId, user.id, borrowed, due]);
    await tx.query('UPDATE reservations SET status=? WHERE book_id=? AND member_id=? AND status=?', ['fulfilled', bookId, memberId, 'pending']);
    await audit(tx, user, 'loan.issued', id);
    return { id, copy_id:copy.id, due_at: due };
  },transactionOptions);
}
export async function returnLoan(db, user, id, transactionOptions) {
  requireRole(user, 'admin', 'librarian');
  return db.transaction(async tx => {
    const loan = (await tx.query('SELECT * FROM loans WHERE id=?', [id])).rows[0];
    if (!loan) throw new HttpError(404, 'Loan not found.');
    const changed = await tx.query('UPDATE loans SET returned_at=?,returned_by=? WHERE id=? AND returned_at IS NULL', [now(), user.id, id]);
    if (!changed.changes) throw new HttpError(409, 'This loan has already been returned.');
    const restored=await tx.query('UPDATE book_copies SET availability=? WHERE id=? AND availability=?', ['available',loan.copy_id,'borrowed']);
    if(!restored.changes)throw new HttpError(409,'Copy status is inconsistent; contact the administrator.');
    await audit(tx, user, 'loan.returned', id);
    return { id };
  },transactionOptions);
}
export async function reserveBook(db, user, body) {
  requireRole(user, 'member');
  const bookId = text(body.book_id, 'Book', 36);
  return db.transaction(async tx => {
    // Lock a shared parent row to serialize duplicate reservations on all engines.
    const book = (await tx.query(`SELECT id FROM books WHERE id=?${tx.engine === 'sqlite' ? '' : ' FOR UPDATE'}`, [bookId])).rows[0];
    if (!book) throw new HttpError(404, 'Book not found.');
    if ((await tx.query('SELECT l.id FROM loans l JOIN book_copies c ON c.id=l.copy_id WHERE c.book_id=? AND l.member_id=? AND l.returned_at IS NULL', [bookId,user.id])).rows.length) throw new HttpError(409, 'You already have this book on loan.');
    if ((await tx.query('SELECT id FROM reservations WHERE book_id=? AND member_id=? AND status=?', [bookId,user.id,'pending'])).rows.length) throw new HttpError(409, 'You already requested this book.');
    const id = randomUUID();
    await tx.query('INSERT INTO reservations (id,book_id,member_id,status,created_at) VALUES (?,?,?,?,?)', [id,bookId,user.id,'pending',now()]);
    await audit(tx, user, 'reservation.created', id);
    return { id };
  });
}
export async function saveUser(db, actor, body, id) {
  requireRole(actor, 'admin','librarian');
  const name = text(body.name,'Name',120), mail = email(body.email), role = text(body.role,'Role',20);
  if (!['admin','librarian','member'].includes(role)) throw new HttpError(400, 'Unknown role.');
  if(actor.role==='librarian' && role!=='member')throw new HttpError(403,'Librarians can manage member accounts only.');
  const active = integer(body.active ?? 1,'Active',0,1);
  if (id === actor.id && (role !== 'admin' || !active)) throw new HttpError(409, 'You cannot remove your own administrator access.');
  let password;
  if (!id || body.password) password = await hashPassword(text(body.password,'Password',128,10));
  return db.transaction(async tx => {
    if (id) {
      const old=(await tx.query('SELECT id,role FROM users WHERE id=?',[id])).rows[0];
      if (!old) throw new HttpError(404,'User not found.');
      if(actor.role==='librarian' && old.role!=='member')throw new HttpError(403,'Librarians can manage member accounts only.');
      await tx.query('UPDATE users SET name=?,email=?,role=?,active=? WHERE id=?',[name,mail,role,active,id]);
      if (password) await tx.query('UPDATE users SET password_hash=? WHERE id=?',[password,id]);
      // Role/password changes revoke existing sessions.
      await tx.query('DELETE FROM sessions WHERE user_id=?',[id]);
    } else {
      id = randomUUID();
      await tx.query('INSERT INTO users (id,name,email,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)',[id,name,mail,password,role,active,now()]);
    }
    await audit(tx, actor, 'user.saved', id);
    return { id };
  });
}
