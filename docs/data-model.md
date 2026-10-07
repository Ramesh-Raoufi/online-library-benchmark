# Data model and API

## Library tables

| Table | Purpose | Important constraints |
| --- | --- | --- |
| users | Accounts and roles | Unique email, role enumeration, active flag |
| categories | Normalized subject categories | Unique category name |
| books | Bibliographic catalogue | Unique ISBN/catalogue code and category foreign key |
| book_copies | Physical items | Unique barcode, book foreign key, available/borrowed/withdrawn status |
| loans | Borrow/return history | Physical copy, member, issuer and returner foreign keys |
| reservations | Member book requests | Book/member foreign keys and explicit request status |
| sessions | Authenticated sessions | Hashed random tokens, expiry and user foreign key |
| audit_events | Recorded mutations | Actor foreign key, action and target ID |

IDs are application-generated UUID strings on every engine. Dates are UTC ISO-8601 strings of a consistent format, so comparisons preserve temporal order. Password hashes and raw session tokens are never returned by account endpoints.

Stock counts are derived from physical-copy records. Checkout conditionally marks one available copy borrowed; creating its loan, fulfilling the request and auditing the action belong to the same transaction. Returns update only an unreturned loan and restore that exact copy. Database SERIALIZABLE isolation and bounded transaction retry handling protect concurrent circulation. SQLite development uses a single serialized transaction queue with `BEGIN IMMEDIATE`. Reducing a title's copy count withdraws available copies, preserving historic loan references.

## API

All mutations require JSON plus `X-Library-Request: 1`. A browser Origin, when present, must equal `APP_ORIGIN`. Authentication uses the `library_session` HttpOnly cookie.

| Method | Route | Access / purpose |
| --- | --- | --- |
| GET | /api/health | Database connectivity without account details |
| GET | /api/auth/me | Current user / setup state |
| POST | /api/auth/login | Email/password sign-in |
| POST | /api/auth/logout | Revoke session |
| GET | /api/dashboard | Collection counts and role-scoped loans/requests |
| GET | /api/books?q=&category= | Authenticated catalogue search, limit 500 |
| POST / PUT | /api/books / /api/books/:id | Admin/librarian catalogue changes |
| GET | /api/books/:id/copies | Authenticated copy barcodes and statuses |
| DELETE | /api/books/:id | Admin/librarian; only without history |
| GET | /api/users | Admin: all accounts; librarian: members; limit 1,000 |
| POST / PUT | /api/users / /api/users/:id | Administrator: all roles; librarian: members only |
| GET | /api/loans?status=active | Own loans for members; all for staff; latest 1,000 |
| POST | /api/loans | Admin/librarian issue a loan |
| POST | /api/loans/:id/return | Admin/librarian return an unreturned loan |
| GET | /api/reservations | Own requests for members; all for staff; latest 1,000 |
| POST | /api/reservations | Member request a book |
| POST | /api/reservations/:id/cancel | Own pending request or staff cancellation |
| GET | /api/reports?format=csv | Staff circulation report; admin also sees audit |
| GET / POST | /api/benchmarks | Administrator result history / experiment start |
| GET | /api/benchmarks/:id/json | Administrator raw experiment download |
| GET | /api/benchmarks/:id/csv | Administrator summary download |

Loan create body: `{ "book_id": "uuid", "member_id": "uuid", "days": 14 }`. Optional `copy_id` chooses a specific available physical copy.

Book body: `title`, `author`, `isbn`, `category`, `shelf`, `total_copies`.

User body: `name`, `email`, `role`, `active`, `password`. Password is required for creation and optional for edits. Editing an account revokes its existing sessions. The administrator cannot remove their own administrator access.

Experiment start body: `rows`, `operations`, `concurrency`, `repetitions`. Connection secrets come exclusively from server configuration.

The initial release bounds list sizes for small institutional catalogues. For a large deployment add server pagination and searchable member/book pickers before exceeding these limits. Renewals, payments, fine collection, e-book file hosting and public self-registration are outside this release's defined scope.
