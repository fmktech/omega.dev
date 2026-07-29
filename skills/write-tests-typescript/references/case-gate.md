# TypeScript test case gate

Mark every row `apply` with named cases or `N/A` with a reason before writing tests.

| Area | Examine |
| --- | --- |
| Empty, nullish, missing | Empty strings/collections, omitted optional properties, `null`/`undefined`, zero-length input |
| Boundaries | Zero, one, min/max, max+1, off-by-one, first/last element, exact threshold |
| Invalid input | Wrong shape, malformed encoding, out-of-range values, duplicates, impossible state |
| Dependency failure | Rejection, timeout, empty/partial response, retry exhaustion |
| Concurrency and ordering | Out-of-order completion, shared-state race, deterministic result ordering |
| Idempotency and duplicates | Repeated call/delivery, duplicate keys/items, replay |
| Unicode, encoding, timezone | Non-ASCII, normalization, DST/offset, locale, serialization boundary |
| Runtime/configuration | Environment variables, module format, DOM/Node/edge behavior, composition wiring |

For each planned assertion, name a defect that would make it fail. Favor mutations such as inverted comparisons, deleted validation, off-by-one thresholds, removed state writes, wrong error mapping, duplicate side effects, and omitted cleanup.
