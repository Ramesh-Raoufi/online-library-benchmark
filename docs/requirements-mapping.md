# Monograph-to-system mapping

The implementation was based on the 58-page **Performance Comparison of MySQL and CockroachDB in an Online Library Management System**, specifically Chapter 3 (research methodology) and Appendix A. The attached AI-teaching monograph was a formatting reference.

| Monograph requirement | Implementation / evidence |
| --- | --- |
| Client → API → database adapter | Bilingual browser UI, shared HTTP API, MySQL/pg adapters |
| Members | Shared users table with member role, unique email and active membership |
| Categories / books | Normalized categories and bibliographic books |
| Physical copies | Independent `book_copies`, unique barcode, availability state |
| Checkout / return | Atomic copy-state transition and loan write, SERIALIZABLE transactions with retries |
| Equivalent schema / indexes | Same application migration and corresponding index definitions on both engines |
| 100k books / 180k copies / 50k members / 40 categories / 500k loans | `STUDY_SCALE=1` generates the proposed counts; smaller pilot is default |
| Fixed generated data | Stable IDs, reference date, fixed operation shuffle seed and cross-engine SHA-256 baseline checks |
| 15 / 20 / 30 / 12 / 8 / 10 / 5 operation mix | `npm run study`; exact proportions for multiples of 100 operations |
| Clients 1 / 10 / 25 / 50 / 100 | Study default concurrency sweep |
| At least five repetitions | Study default repetitions = 5 |
| Point/read/search/write micro-tests | Separate `npm run benchmark` microbenchmark runner |
| p50 / p95 / p99 / throughput / failures / retries | Both runners export measured summaries and raw per-operation samples |
| Three-node CockroachDB topology | Optional Compose override; topology has not been executed here |
| 5-minute warmup / 10-minute measured interval | Optional `STUDY_WARMUP_SECONDS=300` / `STUDY_DURATION_SECONDS=600`; default is a smaller count-bounded pilot |
| Database CPU/memory/storage monitoring | Optional separate Docker resource collector records CPU/memory/I/O; database disk footprint and failover need separate evidence |
| Failure recovery / distributed scalability | Not experimentally measured; no such result is supplied |
| Chapter 4 illustrative charts | Never imported as empirical results |

The first release supplies a functional system and count-bounded research pilot. It makes the optional timed and monitoring modes and the remaining failure protocol explicit so draft numbers are not mistaken for measured evidence.
