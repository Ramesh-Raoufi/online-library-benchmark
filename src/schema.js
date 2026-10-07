export async function migrate(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL CHECK (role IN ('admin','librarian','member')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at VARCHAR(30) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id VARCHAR(36) PRIMARY KEY, name VARCHAR(80) NOT NULL UNIQUE
    )`,
    `CREATE TABLE IF NOT EXISTS books (
      id VARCHAR(36) PRIMARY KEY, title VARCHAR(200) NOT NULL, author VARCHAR(150) NOT NULL,
      isbn VARCHAR(40) NOT NULL UNIQUE, category_id VARCHAR(36) NOT NULL, shelf VARCHAR(40) NOT NULL,
      created_at VARCHAR(30) NOT NULL, FOREIGN KEY(category_id) REFERENCES categories(id)
    )`,
    `CREATE TABLE IF NOT EXISTS book_copies (
      id VARCHAR(36) PRIMARY KEY, book_id VARCHAR(36) NOT NULL, barcode VARCHAR(64) NOT NULL UNIQUE,
      availability VARCHAR(20) NOT NULL CHECK(availability IN ('available','borrowed','withdrawn')),
      FOREIGN KEY(book_id) REFERENCES books(id)
    )`,
    `CREATE TABLE IF NOT EXISTS loans (
      id VARCHAR(36) PRIMARY KEY, copy_id VARCHAR(36) NOT NULL,
      member_id VARCHAR(36) NOT NULL, issued_by VARCHAR(36) NOT NULL,
      borrowed_at VARCHAR(30) NOT NULL, due_at VARCHAR(30) NOT NULL, returned_at VARCHAR(30),
      returned_by VARCHAR(36), FOREIGN KEY(copy_id) REFERENCES book_copies(id),
      FOREIGN KEY(member_id) REFERENCES users(id), FOREIGN KEY(issued_by) REFERENCES users(id), FOREIGN KEY(returned_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS reservations (
      id VARCHAR(36) PRIMARY KEY, book_id VARCHAR(36) NOT NULL,
      member_id VARCHAR(36) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','fulfilled','cancelled')), created_at VARCHAR(30) NOT NULL,
      FOREIGN KEY(book_id) REFERENCES books(id), FOREIGN KEY(member_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, expires_at VARCHAR(30) NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS audit_events (
      id VARCHAR(36) PRIMARY KEY, actor_id VARCHAR(36) NOT NULL,
      action VARCHAR(60) NOT NULL, target_id VARCHAR(36) NOT NULL, created_at VARCHAR(30) NOT NULL,
      FOREIGN KEY(actor_id) REFERENCES users(id)
    )`
  ];
  for (const sql of statements) await db.query(sql);
  for (const [table, name, columns] of [
    ['books','idx_books_title','title'], ['books','idx_books_category','category_id'],
    ['book_copies','idx_copies_book_status','book_id, availability'],
    ['loans','idx_loans_copy','copy_id, returned_at'],
    ['loans','idx_loans_member','member_id, returned_at'], ['loans','idx_loans_due','returned_at, due_at'],
    ['reservations','idx_reservations_member','member_id, status'], ['sessions','idx_sessions_expiry','expires_at']
  ]) {
    // MySQL lacks CREATE INDEX IF NOT EXISTS. Ignore only the exact duplicate-index condition.
    try { await db.query(`CREATE INDEX ${db.engine === 'mysql' ? '' : 'IF NOT EXISTS '}${name} ON ${table} (${columns})`); }
    catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
  }
}
