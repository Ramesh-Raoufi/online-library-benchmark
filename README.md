# Library Lab

**Performance Comparison of MySQL and CockroachDB in an Online Library Management System**

A working online library application and an isolated, reproducible database experiment runner. The interface supports English and Dari/Persian with right-to-left layout. No performance numbers are prefilled.

## What is included

- Books: create/edit catalogue entries, search by title/author/code, filter categories, track shelves and copies.
- Physical copies: a unique barcode and independent status per copy; choose a specific copy when issuing a loan. Reducing copy count withdraws available copies while preserving their historical records.
- Accounts: administrator, librarian and member roles; activate/deactivate users, assign roles and reset passwords.
- Circulation: issue loans to active members, record returns, review overdue books and loan history.
- Member portal: browse books, request a book, cancel a pending request and see only personal loans/requests.
- Requests: librarians issue a matching loan to fulfil a request.
- Reports: collection circulation counts, CSV export and administrator audit history.
- Experiments: MySQL and CockroachDB point reads, catalogue search, joins, inserts, updates and borrow/return transactions. Raw JSON, CSV, successful-operation latency percentiles, throughput, failures and retries.
- Security: scrypt password hashes, opaque HttpOnly session cookies, role checks on the server, exact-origin mutation protection, parameterized SQL, audit entries and login rate limiting.
- Development mode: a persistent SQLite database. **SQLite is never used as a substitute in the database comparison.**

## Run locally (Node.js 24 or newer)

```bash
npm ci
cp .env.example .env
```

Edit `.env` and set `ADMIN_EMAIL`, `ADMIN_NAME` and a unique `ADMIN_PASSWORD` of at least 10 characters. There is no default administrator password.

```bash
npm run setup
npm run seed
npm start
```

Open **http://localhost:3000** and sign in with the administrator account. Administrators create member and librarian accounts; librarians can register and manage members in **People & access / افراد و دسترسی‌ها**. `seed` adds sample book catalogue entries only; it does not invent users, loans or benchmark results. It can be run again safely without duplicating catalogue codes.

`setup` refuses to overwrite an existing administrator. Accounts are subsequently managed through the application.

## Use actual MySQL and CockroachDB

Install Docker Engine with Compose on your own machine. The supplied Compose configuration is for an isolated local experiment, with ports bound to loopback.

```bash
docker compose up -d --wait mysql cockroach
docker compose run --rm cockroach-init
```

For the library application, set one of these in `.env`:

```ini
DB_ENGINE=mysql
MYSQL_URL=mysql://library:local-library-password@127.0.0.1:3306/library
```

or:

```ini
DB_ENGINE=cockroach
COCKROACH_URL=postgresql://root@127.0.0.1:26257/library?sslmode=disable
```

Then run `npm run setup`, `npm run seed` and `npm start` against that engine. Each engine has its own database and account records; switching engines does not copy existing data.

The initial MySQL SQL file runs when its volume is first created. If you already have a MySQL volume, create `library_benchmark`/`library_test` and grant the library user access manually rather than deleting an existing volume.

## Run a measured experiment

The two `.env` variables below must point to **dedicated disposable experiment databases** whose names end in `_benchmark`. The runner refuses ordinary application database names. It modifies only `bench_books` and `bench_loans`.

```ini
BENCH_MYSQL_URL=mysql://library:local-library-password@127.0.0.1:3306/library_benchmark
BENCH_COCKROACH_URL=postgresql://root@127.0.0.1:26257/library_benchmark?sslmode=disable
BENCH_ROWS=1000
BENCH_OPERATIONS=300
BENCH_CONCURRENCY=5
BENCH_REPETITIONS=3
BENCH_WARMUP=30
POOL_SIZE=10
```

```bash
npm run benchmark
```

Or sign in as administrator and use **Database experiments / آزمایش دیتابیس**. Download raw JSON or CSV after the run. Results persist in `results/` and are intentionally ignored by Git to avoid publishing local environment information accidentally. Manually include reviewed results in your monograph research archive.

Begin with a small run. Every workload resets its complete baseline twice, which can take time with large datasets. Run **only one runner per pair of experiment databases**; concurrent experiments would invalidate the baseline.

Read [docs/benchmark-methodology.md](docs/benchmark-methodology.md) before interpreting measurements. The chart averages each repetition's median for a workload; the table and raw export retain each repetition separately.

## Chapter 3 normalized study preset

The additional `study` runner uses the **actual application schema and checkout/return transactions** with members, normalized categories, books, barcoded physical copies and loans. Its deterministic operation mix matches Chapter 3: 15% member lookup, 20% book lookup, 30% catalogue search, 12% checkout, 8% return, 10% administrative write and 5% due-loan queries.

```bash
npm run study
```

The default is a smaller pilot (`STUDY_SCALE=0.01`) with five repetitions and worker counts 1, 10, 25, 50 and 100. Set `STUDY_SCALE=1` to generate the monograph's proposed **100,000 books, 180,000 copies, 50,000 members, 40 categories and 500,000 loans**. Full-scale seeding and checksums need substantial time, disk and memory; begin with the small preset.

The default pilot is operation-count bounded. To use the draft's fixed-duration protocol, set `STUDY_WARMUP_SECONDS=300` and `STUDY_DURATION_SECONDS=600`. Each measured repetition runs until the deadline, then waits for in-flight operations to finish. Raw timed-run samples stream to `results/study-*.ndjson`; JSON/CSV retain aggregate measurements. Large timed runs require more memory for exact latency percentiles; use `NODE_OPTIONS=--max-old-space-size=4096` on a machine with sufficient RAM.

Optionally collect actual container CPU/memory/network/block-I/O observations in a **separate terminal** while the study runs:

```bash
RESOURCE_SECONDS=600 npm run resources -- mysql cockroach
```

For the three-node topology set `RESOURCE_CLUSTER=true` and pass `mysql cockroach cockroach2 cockroach3`. The collector saves timestamped Docker metrics as `results/resources-*.jsonl`. Align those timestamps with each run and document sampling overhead; Docker block-I/O counters are not database storage footprint. Failover is a separate experiment and has not been implemented or measured.

Study summaries are saved as `results/study-*.json` and `results/study-*.csv`; the web experiment page currently presents the separate microbenchmark results. Neither timing mode nor monitoring produces any result until real services run.

An optional three-node CockroachDB configuration is included:

```bash
docker compose -f docker-compose.yml -f docker-compose.cluster.yml up -d
docker compose -f docker-compose.yml -f docker-compose.cluster.yml run --rm cockroach-init
```

Use a separate experiment environment and the dedicated cluster volumes. This compares one MySQL node with three CockroachDB nodes: total hardware and resilience guarantees differ, so report it as a **topology comparison**, not equal-resource engine evidence. No failover measurements have been supplied.

## Checks

```bash
npm run check
npm test
```

Real database tests require separate disposable `_test` databases:

```bash
TEST_MYSQL_URL='mysql://library:local-library-password@127.0.0.1:3306/library_test' \
TEST_COCKROACH_URL='postgresql://root@127.0.0.1:26257/library_test?sslmode=disable' \
npm run test:databases
```

GitHub Actions includes application checks, live-engine circulation checks and a small measured database experiment. A workflow file's presence is not evidence that it has passed; inspect the actual run after pushing.

## Hosting

This project is a Node.js server, not a static frontend. Host it on a server that supports a long-running Node 24 process and connections to your chosen database. Use HTTPS, set `APP_ORIGIN` to the exact public origin, set `COOKIE_SECURE=true`, set `HOST=0.0.0.0` when required, use verified database TLS, protect database ports and configure durable storage/backups. MySQL TLS can be enabled with `?ssl=true`; CockroachDB uses the PostgreSQL connection string's TLS options. Do not expose the Compose `--insecure` CockroachDB instance to the internet.

One server process is the supported deployment model for the built-in rate limiter and experiment job state. Multiple application instances need a shared rate limiter, experiment job coordinator and shared result storage. Sessions and library records already reside in the selected database.

## Project structure

```text
src/          HTTP API, database adapters, schema, auth and library transactions
public/       Responsive bilingual application (no frontend build step)
scripts/      Admin setup, optional catalogue seed, experiment runner and checks
test/         Circulation, rollback, access-control, API and measurement tests
docs/         Installation, methodology, data model and API reference
results/      Actual experiment JSON/CSV output (not committed)
```

## Research scope

The generated 58-page MySQL/CockroachDB monograph was located and read during implementation, particularly Chapter 3 and Appendix A. Its core entities, physical-copy transaction model, proposed row counts and workload mix informed this project. Member accounts use the common users table with `role=member` rather than duplicating account data in another table. The attached AI-assisted-teaching PDF was a formatting reference, not the system specification. Illustrative Chapter 4 numbers have not been imported as evidence.

The local Compose baseline pins MySQL 8.4.3 and CockroachDB 24.3.0 to make the initial environment repeatable; they are **experiment baselines, not a claim about current recommended production versions**. Actual server versions are recorded in every result. CockroachDB licensing requirements depend on version and usage; check the provider's requirements before deployment.

No real MySQL-versus-CockroachDB results are supplied until both engines have actually been run. See [docs/verification.md](docs/verification.md) for the checks performed during creation.
