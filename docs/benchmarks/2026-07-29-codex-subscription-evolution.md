# Codex subscription evolution proof — 2026-07-29

## Claim tested

Can Omega use a ChatGPT subscription through the local Codex runtime for reflection, crystallize one project-scoped skill, and cause a measurable improvement on later real-workspace tasks without exposing evaluation feedback to reflection?

## Isolation

- `account/read` reported `authType: chatgpt`, `planType: pro`.
- Reflection alone used `openai-codex:gpt-5.6-sol` through `codex app-server --stdio`.
- Both incumbent and candidate workspace arms used the unchanged `openrouter:deepseek/deepseek-v4-flash` route served by GMICloud.
- Reflection saw only the completed developer conversation. It received no holdout task, hidden check, score, or evaluation result.
- Nine pairs ran in isolated, network-disabled OCI workspaces: two relevant tasks and one adjacent negative control, each repeated three times with alternating condition order.
- A pair was comparable only when both arms reported the same actual coder route.

Command:

```sh
pnpm build
pnpm benchmark:workspace-skill-transfer 3 --codex
```

## Failure that improved the harness

The first full v6 run correctly failed promotion. Codex treated the observed transcript line `verify-auth: PASS` as a normative output contract. In one candidate run, the coder rewrote the existing verifier to manufacture that historical message. The hidden preservation check caught the mutation:

- comparable pairs: 9/9;
- relevant retrieval: 6/6;
- negative inhibition: 3/3;
- regressions: 1;
- `positiveTransfer: false`.

Root cause was Omega's crystallization prompt: it required exact observed outputs without distinguishing user/spec requirements from incidental one-run tool output.

The resulting invariant is now enforced in both reflection instructions and every compiled skill: historical tool output is observational unless a user or authoritative specification makes it normative, and an existing verifier/generator/tool may not be edited merely to reproduce a historical message.

The failed record remains at:

```text
~/.omega/benchmarks/workspace-skill-transfer/bee8c4092a518f360413b6db8b7981694fd91b95d49d487aeb5b6775213c37cd.json
```

## Corrected v7 result

| Measure | Incumbent | Codex-evolved candidate |
| --- | ---: | ---: |
| Relevant task passes | 2/6 | 6/6 |
| Irrelevant task passes | 3/3 | 3/3 |
| Tool calls | 94 | 63 |
| Normalized coder cost | 7,294 µUSD | 7,958 µUSD |

Transfer gates:

- comparable pairs: **9/9**;
- gained pairs: **4**;
- regressed pairs: **0**;
- relevant skill reads: **6/6**;
- negative-control non-reads: **3/3**;
- tool-call reduction: **32.98%**;
- normalized coder-cost change: **+9.10%**;
- capability improved: **true**;
- efficiency improved: **false**;
- positive transfer: **true**.

The reflection completed in one attempt with no retry, scored 9/10 on the independent reflection rubric, and compiled this project skill:

```text
regenerate-authentication-configuration-and-run-its-scoped-verifier
```

The authoritative record is:

```text
~/.omega/benchmarks/workspace-skill-transfer/dab188c8a226ea808682111518a5729cc9b263cf20f404d9b99e300dda6b0838.json
```

## Verdict

This is positive causal evidence for beneficial harness evolution with subscription-backed Codex reflection. The stronger model was not used in either evaluated coding arm; the only treatment was the immutable skill produced from prior developer feedback.

It is not evidence of universal improvement. The proof covers one project workflow, three task shapes, and three replicates. It also shows the candidate improved capability and tool economy while increasing normalized coder cost, so it should be described as a capability win rather than a complete efficiency win.
