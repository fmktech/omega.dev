# Negative skill applicability is ignored by the runner

## Symptom

- **Observed:** in synthetic negative-control run `27eedcbe...`, the candidate loaded the locations-and-lots skill once for “a task board where users authenticate ... using npm packages.”
- **Expected:** no skill read, because the catalog explicitly excludes authentication, npm/network installs, and materially different entity models.
- **Delta:** the runner prompt merely says to read entries that “may be relevant” and never gives negative applicability precedence.

## Hypotheses

### H1: The runner lacks an explicit negative-first retrieval rule

- **Layer:** initial runner bootstrap/tool instructions.
- **Prediction:** the generated runner prompt mentions relevance but does not say that any matching `doesNotApplyWhen` condition forbids `skill.read`.
- **Evidence:** `bootstrapPrompt` contains only “When an entry may be relevant, call ... skill.read”; the live candidate then read the excluded skill exactly once.
- **Verdict:** **PROVEN**.

### H2: Reflection dropped the negative applicability metadata

- **Layer:** reflection compilation/catalog parsing.
- **Prediction:** the installed catalog omits authentication, package installation, or differing entity model exclusions.
- **Evidence:** the compiled skill frontmatter contains all three exclusions.
- **Verdict:** rejected.

### H3: The repeated-read cache inflated a legitimate read into the violation

- **Layer:** runner skill cache/metrics.
- **Prediction:** the run reports more than one skill read or repeated component fetches.
- **Evidence:** the run reports exactly one skill read; the issue is selection, not caching.
- **Verdict:** rejected.

## Root cause

Skill selection was delegated to a language model with only a positive “may be relevant” instruction. The catalog carries negative applicability, but the runner is not told to evaluate it first or treat a match as a hard exclusion.

## 5 Whys

1. **Why did the negative-control candidate load the skill?** It considered shared terms such as Node 24 and app construction relevant.
2. **Why did positive overlap win?** The runner had no negative-first rule.
3. **Why was metadata insufficient?** Structured fields do not imply precedence to the model.
4. **Why was precedence unspecified?** Retrieval initially focused on discovering potentially useful skills.
5. **Why did tests miss it?** Tests covered catalog transport and single-read caching, not the actual selection instruction.

## Falsification condition

This diagnosis is false if a runner whose bootstrap and tool description explicitly make any negative match a hard exclusion still reads this skill on the same negative-control objective.
