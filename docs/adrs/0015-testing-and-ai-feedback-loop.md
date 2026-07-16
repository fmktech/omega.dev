# ADR-0015: Testing and the AI feedback loop

- Status: Accepted
- Date: 2026-07-16

## Context

Omega contains deterministic software infrastructure and a stochastic AI agent. Treating both as one test suite would either make ordinary CI slow and flaky or reduce agent evaluation to implementation-shaped unit tests. The central product claim is also unusual: a project-owned harness should learn to make an economical model more effective, especially when the project's environment contradicts the harness's familiar assumptions.

Benchmark results are meaningless when runs from different models, providers, reasoning modes, or budgets are combined as if they were equivalent. The initial feedback loop must be small enough to run often under a free OpenRouter route while still exposing consequential harness weaknesses.

## Decision

Omega uses two connected but separate testing loops.

### Deterministic product loop

Normal development uses model-free tests wherever behavior can be specified deterministically:

- unit and contract tests for schemas, content addressing, policy precedence, SHA interlocks, score calculation, and state transitions;
- integration tests for daemon/runner JSONL, HTTP/SSE clients, process streaming, object storage, activation, and rollback;
- end-to-end tests with deterministic scripted model doubles for complete session, child-session, resume, evolution, and recovery flows;
- adversarial and fault-injection tests for stale writes, partial JSONL records, duplicate events, process crashes, policy bypass, prompt injection, and concurrent activation.

Tests assert public behavior and durable invariants rather than private call order. Fixtures use known expected outcomes or hidden verifiers rather than reproducing production algorithms. High-risk tests must be mutation-checked by deliberately breaking the protected behavior and observing the test fail.

Live-model benchmarks do not gate ordinary unit-test CI.

### AI feedback loop

The live-model loop is:

1. Start a versioned benchmark task from a frozen, isolated workspace fixture.
2. Bind the run to an exact model-route signature, harness manifest, policy, and resource budget.
3. Give the runner the task objective but not the hidden verifier or capability labels.
4. Determine success using deterministic hidden tests and explicit side-effect invariants, never an LLM judge alone.
5. Persist the complete semantic trace, artifacts, aggregate model usage, and process streams.
6. Diagnose failed runs and expensive successful grinds for missing or inefficient harness behavior.
7. Produce a content-addressed candidate harness.
8. Run incumbent and candidate on identical benchmark conditions through Promotion Eval.
9. Feed the paired scorecard back into promotion, rejection, crystallization, and future marketplace evidence.

The same benchmark cases can therefore test both current agent capability and whether Omega's evolution loop learns a reusable improvement.

## OmegaBench-10

The first development corpus is a tiny suite of approximately ten difficult, hermetic repository tasks. Difficulty comes from a wrong default assumption or unusual project harness, not from large patches or expensive builds.

The initial suite covers these ten diagnostic situations:

1. **Operating-system mismatch:** project guidance gives Windows commands while the benchmark runs on Linux; the agent must infer a valid equivalent without changing the intended workflow.
2. **Unexpected package/build tool:** familiar commands are absent and the repository declares a less common package manager or build orchestrator that must be discovered and used.
3. **Generated-file trap:** the apparent target is generated output; success requires finding and changing the source plus running the correct generator.
4. **Scoped monorepo verification:** the root command is prohibitively broad or misleading; the task requires resolving the affected workspace and its real verification command.
5. **Interactive/background dependency:** verification requires starting a long-running subprocess, observing readiness, using it, and shutting it down cleanly.
6. **Offline dependency constraint:** network access is unavailable; the agent must use the repository's vendored, cached, or hermetic dependency path.
7. **Concurrent file change:** another actor changes a previously read file, forcing the SHA interlock to reject a stale write and the agent to reread and reconcile.
8. **Misleading local instructions:** a lower-authority repository instruction or prompt-injection-shaped file conflicts with the effective task/policy boundary; the agent must follow the correct authority.
9. **Nonstandard test oracle:** success is established by a project-specific verifier or protocol rather than the language ecosystem's default test command.
10. **Pre-existing or flaky failure:** the baseline contains an unrelated failure or nondeterministic signal; the agent must isolate the requested regression and avoid claiming unrelated breakage as its result.

Each case has:

- a content-addressed workspace fixture and environment description;
- one observable task objective;
- hidden deterministic acceptance tests;
- negative invariants for prohibited side effects;
- private diagnostic capability tags used only for analysis;
- fixed wall-time, model-call, token, and tool-process budgets;
- a versioned fixture identifier so changes begin a new result series.

Exact repositories, commands, budgets, and replicate counts belong to the versioned benchmark manifest and remain an open implementation decision.

## Model-marked evidence

Every live-model benchmark result records a model-route signature containing at least:

- OpenRouter model slug and variant;
- actual serving provider and any provider quantization reported by OpenRouter;
- provider generation identifier and timestamp;
- reasoning mode and reasoning budget;
- temperature, top-p, seed when supported, context cap, and output cap;
- harness manifest and component hashes;
- execution-policy and benchmark-suite versions;
- task budget and workspace-fixture hash.

The initial development route is:

```text
openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
```

The free route is a bootstrap constraint, not a timeless product default. A later route starts a new benchmark series.

Results are comparable for promotion only when the material fields of their route signatures match. In particular:

- different model slugs, reasoning modes, provider endpoints, or quantizations are never pooled into one score;
- if OpenRouter sends the paired runs to different providers, the pair is invalid and must be rerun or reported in separate provider strata;
- cross-model results may be shown side by side to measure transfer, but they do not establish a causal incumbent-versus-candidate improvement;
- free-route availability failures are reported separately from task failures.

## Scorecard and decision order

Omega does not collapse benchmark behavior into one weighted score that can trade correctness for cost.

The scorecard reports:

- verified task success and failure category;
- hidden-verifier and negative-invariant results;
- input, cached-input, reasoning, and output tokens;
- provider charge and equivalent list-price cost, including when the route is free;
- wall time, time to first token, and generation time;
- model turns, tool calls, process starts, stale writes, policy decisions, and retries;
- harness updates and child sessions used;
- final workspace diff and artifact hashes.

Promotion applies these signals in order:

1. correctness, security, isolation, and policy invariants are non-tradeable gates;
2. verified task capability takes precedence over efficiency;
3. when capability is equivalent, lower cost and resource use win;
4. latency and unnecessary actions break remaining ties.

Thresholds and statistical rules are defined by the incumbent Promotion Eval under ADR-0011 and are not fixed by this ADR.

## Consequences

- Developers get fast deterministic CI without pretending a scripted model measures agent capability.
- OmegaBench-10 creates a cheap, interpretable signal about whether the harness adapts to unfamiliar projects.
- Model and provider changes cannot silently manufacture an apparent harness improvement.
- Ten tasks provide diagnostic speed rather than broad external validity; later external suites are still needed.
- Hidden verifiers, fixture secrecy, and versioning must prevent the evolution loop from memorizing benchmark answers.
- The free OpenRouter route requires local throttling and explicit treatment of provider availability.

## Alternatives considered

- **Use only SWE-bench or another large public leaderboard:** rejected for the development loop because it is expensive, slow, less diagnostic, and vulnerable to benchmark familiarity.
- **Use one aggregate score across models:** rejected because model capability and serving differences would be misattributed to the harness.
- **Use an LLM judge as the success oracle:** rejected because executable repository tasks should have deterministic behavioral verification.
- **Make the ten tasks large real-world projects:** rejected because slow reset and ambiguous failure attribution weaken the feedback loop.
- **Test only happy-path conventional repositories:** rejected because Omega's value is adapting its harness when ordinary assumptions fail.
- **Run live model calls in normal unit CI:** rejected because cost, availability, and stochasticity would make the correctness suite unreliable.

