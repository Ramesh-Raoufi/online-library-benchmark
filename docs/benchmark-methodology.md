# Experiment methodology

## Research question

How do MySQL and CockroachDB differ in observed response time, throughput and retry behaviour for the same online-library-related operations under a specified environment?

The implementation provides repeatable experiments. It does not manufacture a winning engine or reproduce illustrative figures from a draft monograph.

## Controlled inputs

| Input | Behaviour |
| --- | --- |
| Dataset | Deterministic books and loan records with identical integer IDs and values |
| Integrity | SHA-256 checksum compared across engines for every workload and repetition |
| Schema | Equivalent books/loans fields, constraints and indexes |
| Connection pools | Same configured maximum on both drivers |
| Operations | Same SQL statement structure with driver-specific parameter placeholders |
| Workers | Same number of closed-loop concurrent workers |
| Warmup | Same operation count; excluded from measured output |
| Reset | Complete baseline restored before warmup and again before timing |
| Order | MySQL first on odd repetitions, CockroachDB first on even repetitions |
| Transactions | SERIALIZABLE isolation and a maximum of five client attempts on both engines |
| Failure | Failed operations counted; raw error code and duration retained |
| Hardware baseline | Compose gives each database 2 CPU and 2 GiB memory limits, with persistent local volumes |

Pool initialization, schema setup, dataset resets and checksums occur outside measured intervals. Rebuilding the baseline warms storage caches: these are **warm-cache experiments**, not cold-start measurements.

The Compose configuration creates a single MySQL server and a single-node CockroachDB server. Equal CPU and memory caps do not make their internal cache policies or implementations identical. MySQL collation, query plans, fsync behaviour, driver overhead and index implementation can influence results. Record configuration and explain those differences in the monograph.

## Workloads

| Workload | Statement / unit measured |
| --- | --- |
| Point read | Lookup book by primary key |
| Catalogue search | Category filter with ordered title results, limit 20 |
| Loan join | Join a loan with its book by book ID |
| Insert | Insert one new book record with a deterministic unique ID |
| Update | Increment one existing book's revision |
| Borrow/return transaction | Decrement stock, insert loan, delete that test loan, restore stock, commit |

The transaction workload models the database changes of borrowing and returning as one controlled unit. It does not represent a physical patron returning a book immediately, nor does it include authentication, auditing, the HTTP API or frontend rendering.

The library application's transactions separately enforce role checks, stock availability, duplicate-loan prevention, active-member validation and reservation fulfilment. The smaller benchmark transaction makes its measured database unit explicit.

Keys follow `((operationIndex * 7919) % rowCount) + 1`. If the dataset size shares factors with 7919, fewer keys are covered; report this when choosing sizes. The default 1,000-row dataset distributes keys across the full table.

## Metrics

- **Latency:** wall-clock milliseconds around a driver call, including waiting for a pooled connection and any transaction retries/backoff.
- **Mean, median, p95, p99:** calculated on successful operations only using nearest-rank percentiles. Failed durations remain in raw samples.
- **Throughput:** successful operations divided by total elapsed seconds for the measured worker pool.
- **Failures:** operations that ultimately fail, including after exhausting retries.
- **Retries:** client-side transaction retries after serialization conflicts, deadlocks or lock timeouts. Automatic server retries are not observable through this counter.

The plot shows the arithmetic mean of repetition-level median latencies for each workload/engine. It is not a pooled median. The table and exports retain every repetition; raw JSON retains each operation's duration and success status.

Do not compare a run with failures against a successful run without explaining errors and their effect. Low operation counts produce unstable tail percentiles. Use multiple repetitions, pre-specify settings and preserve all results rather than selecting favourable runs.

## Additional evidence to collect for a thesis

The output records database versions, client OS/CPU/memory, settings and dataset checksums. It deliberately does **not** claim to measure database CPU, server memory, network latency, failover or distributed scalability. For these questions collect separate evidence:

1. Exact image digests and database configuration, server CPU/memory/storage, node count and region.
2. Database resource monitoring sampled throughout each measured interval, including timestamps and instrumentation overhead.
3. Concurrency sweeps at fixed data size, then dataset-size sweeps at fixed concurrency.
4. Separate cold-cache protocols if relevant, carefully controlling restarts and cache state.
5. A separate multi-node CockroachDB protocol with documented replication, topology, failures and comparable MySQL architecture.
6. Confidence intervals or another justified variability analysis from the preserved repetitions.

GitHub Actions runs a small live-engine smoke experiment for compatibility; shared CI machines are not a controlled scientific environment. Do not present its figures as publication-ready evidence without qualifying the environment.

## References

- [CockroachDB transaction retry error reference](https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference)
- [MySQL2 driver documentation](https://sidorares.github.io/node-mysql2/docs)
- [node-postgres connection pooling](https://node-postgres.com/features/pooling)
- [MySQL 8.4.3 release notes](https://dev.mysql.com/doc/relnotes/mysql/8.4/en/news-8-4-3.html)

The runner handles CockroachDB SQLSTATE `40001` by restarting the whole transaction, as described in the provider's retry guidance. It also retries MySQL deadlocks/lock timeouts using the same bounded backoff policy.
