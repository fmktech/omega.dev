# Existing projects cannot adopt corrected built-in runners

## Symptom

- **Observed:** project `project_e63605eec4e5b349510f4fc6921ed7a3` remains pinned to runner component `component_fc38…` after rebuilding and restarting Omega, so new negative-applicability and tool-interlock fixes are absent from its next session.
- **Expected:** immutable project harnesses remain stable, while an explicit local operation can create and activate a descendant containing the current built-in runner and preserving project-scoped learned components.
- **Delta:** initialization only handles projects whose `activeHarnessId` is null; evolution can mutate learned components, but no operator path upgrades the daemon-supplied baseline runner.

## Hypotheses

### H1: Harness initialization intentionally short-circuits for existing projects

- **Layer:** application bootstrap.
- **Prediction:** `ensureProjectHarness` returns the active immutable manifest without comparing its runner to the current built-in runner.
- **Evidence:** the first branch returns `harnesses.getHarness(project.activeHarnessId)` whenever the pointer is non-null.
- **Verdict:** **PROVEN**.

### H2: Re-registering a workspace refreshes its runner

- **Layer:** workspace registration.
- **Prediction:** `project.register-workspace` would rebuild and activate a new initial harness.
- **Evidence:** registration calls `ensureProjectHarness`, which takes the existing-project short circuit above.
- **Verdict:** falsified.

### H3: A normal skill evolution automatically replaces the runner

- **Layer:** candidate compiler.
- **Prediction:** skill-only evolution candidates would contain the current built-in runner.
- **Evidence:** candidates preserve all incumbent components except the explicitly replaced allowed component kind; the failed skill candidate retained the old runner.
- **Verdict:** falsified.

## 5 Whys

1. **Why would the next replay still over-trigger the learned skill?** Its runner predates negative-first applicability.
2. **Why did restart not fix it?** Harness manifests and component payloads are immutable and content-addressed.
3. **Why was no descendant created?** Initialization only creates a harness when a project has no active pointer.
4. **Why can the operator not request the upgrade?** The client contract exposes get/list/pin/rollback, but no built-in-runner upgrade operation.
5. **Why did tests miss it?** Initial-harness tests cover first creation and deterministic repetition, not adoption of a newer built-in runner by an existing lineage.

## Falsification check

If an existing active project could explicitly materialize a direct descendant that replaces only its runner component, preserves every project component, and atomically activates it, H1 would not explain the stale runner. No such operation exists.

## Resolution target

Add an explicit `harness.upgrade-runner` local operation. It creates a direct immutable descendant using the current built-in runner, preserves all non-runner components and source provenance, rejects a no-op upgrade, and activates through the existing compare-and-set pin path.
