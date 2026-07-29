# Child session stale-harness investigation

## Observed failure

After upgrading the project's active runner, starting evolution from an older completed source session still launched both evolution children with that source session's original harness. The new handoff-loading runner therefore could not participate in the rerun.

## Hypotheses

1. The project activation pointer was not updated by `upgrade-runner`.
2. The daemon cached the old active harness after activation.
3. `spawnChild` explicitly pinned the parent's `initialHarnessId` instead of resolving the project's active harness for the new child call.

## Evidence and conclusion

Hypothesis 1 is falsified by the successful harness update from `harness_6cea…` to `harness_cd827…`. Hypothesis 2 is falsified because new main sessions and resumes resolve the active harness through the repository. Hypothesis 3 is proven by `session-service.ts`: the child launch loaded `parent.header.initialHarnessId` directly.

## Five whys

1. Why did the upgraded runner not affect evolution? Evolution is implemented as child sessions.
2. Why did those children use old code? `spawnChild` copied the parent's initial harness.
3. Why is that inconsistent? Other new calls resolve the project-active harness, and the product decision says the next call adopts a newly activated version.
4. Why did tests miss it? The session fixture kept the active and parent harness IDs equal.
5. Why is this especially harmful for self-improvement? A harness fix cannot repair evolution of the historical session that revealed the defect.

## Fix and falsification

Resolve the project-active harness when launching every new child while preserving the parent's harness ID on the parent-side `child.spawned` event. A regression starts a parent under one harness, changes the active pointer, and proves the child starts under the newer harness.
