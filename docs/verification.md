# Verification performed during creation

Date: 2026-10-07.

## User story

An administrator or librarian creates a catalogue and member account; a selected physical copy is issued and returned through the browser/API/database flow. Members can view their own records and create/cancel personal book requests. Research runners compare two configured real databases without importing illustrative numbers.

## Verified

- JavaScript syntax checks across application, browser, scripts and tests.
- Final automated suite: 13 passed, 2 live-engine tests skipped, 0 failures.
- Compose and CI YAML parsed successfully.
- SQLite-backed HTTP flow: login/session/logout, origin protection, role restrictions, own-loan privacy, circulation and CSV export.
- Concurrent checkout of the only copy: one success, one rejection.
- Double return rejection and correct physical-copy state restoration.
- Transaction rollback after an intentional failure.
- Foreign-key enforcement for nonexistent physical copies.
- Duplicate request prevention and fulfilment when its book is issued.
- CSV formula-value escaping.
- Measurement worker limit, failure retention and percentile calculations.
- Normalized Chapter 3 row counts, exact operation mix, deterministic checksums and copy/loan consistency.
- Headless Chromium browser journey: add book → inspect two barcoded copies → add member → choose a copy → issue → return → sign in as member → request → cancel.
- English/Dari switching, desktop screenshots and 390px mobile layout with no document overflow.
- Browser journey completed with no page or console errors after fixing the starting view when switching from an administrator to a member account.

## Not verified here

- MySQL and CockroachDB services were not available in this execution environment. Their live-engine tests are present but skipped locally; their adapters, SQL and Compose startup still require an actual run.
- GitHub Actions execution is pending a push. The workflow contains real-engine circulation checks, a measured microbenchmark and a normalized study pilot; its presence does not establish that it passed.
- The measurement deadline/streaming logic was locally tested, but the timed study with real engines, optional Docker resource collector, three-node topology and failover behaviour have not been executed or measured.
- No production deployment or external database credentials were supplied.

Development review accounts, SQLite databases, screenshots, browser binaries and temporary files are excluded from the deliverable. The application asks the operator to create their own administrator account.
