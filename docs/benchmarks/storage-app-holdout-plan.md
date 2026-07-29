# Storage app continual-learning holdout plan

## Behavioral contract

The evaluator—not the candidate implementation—defines these externally visible promises:

1. A developer can create, list, and delete locations without authentication.
2. A developer can create, list, and delete lots attached to an existing location.
3. User-controlled names are trimmed; empty, missing, and non-string names are rejected.
4. A lot cannot reference a missing location.
5. Deleting a location with lots is rejected as a conflict and preserves both records.
6. Unknown records and routes have stable not-found responses.
7. Malformed JSON and oversized bodies fail without crashing the server.
8. Domain/use-case code remains independent of HTTP and browser concerns.
9. The application and tests run with Node built-ins in the network-disabled workspace.

## Risk order

1. Destructive location deletion and referential integrity.
2. HTTP input/error mapping and server survival after malformed requests.
3. Domain validation and repository state preservation after rejected commands.
4. Happy-path CRUD and static UI delivery.
5. Maintainable module boundaries and offline verification.

## Edge-case taxonomy gate

| Row | Applicability | Planned cases |
| --- | --- | --- |
| Empty / null / missing | Apply | empty, whitespace, null, missing name/location id; empty collections |
| Boundary values | Apply | first record; deleting final lot; request-body size boundary |
| Invalid input | Apply | number/object names, malformed JSON, unknown route/id, traversal-shaped static path |
| Dependency failure | Apply | repository rejects/returns missing parent; static file absent; request stream aborted where practical |
| Concurrency / ordering | Apply | two independent creates; rejected location deletion leaves ordering/state intact |
| Idempotency / duplicate delivery | Apply | repeat delete and duplicate names receive explicit stable behavior |
| Unicode / encoding / timezone | Apply | trimmed Unicode/emoji name round-trips; timezone N/A because contract has no time values |

## Holdout design

- Exercise the public domain/use-case API with the real in-memory repository; no mocks of owned modules.
- Exercise the real HTTP server on an ephemeral local port using Node's built-in `fetch`.
- Keep evaluator files outside the candidate repository and copy them into a temporary checkout only after the candidate session is terminal.
- Each assertion names a mutation it must kill: bypass trim, accept empty input, skip parent lookup, cascade on location deletion, map domain conflict to 200/500, accept malformed JSON, or return the wrong route/status.
- Holdout results are evaluation-only. They are converted into developer feedback for a correction episode but are never exposed to a later blind evaluation run.
