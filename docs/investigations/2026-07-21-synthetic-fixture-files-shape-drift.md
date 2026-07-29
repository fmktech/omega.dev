# Synthetic fixture files shape drift

## Observed failure

Evolution job `4df99955-164d-451a-b105-d9498964ddef` failed static fixture compilation twice. Both the original Gemini 3 Flash proposal and its repair represented `files` as an array of `{path, content}` objects.

## Hypotheses

1. **The evaluator returned invalid JSON because streamed text fragments were joined incorrectly.** This predicts parse failure before any fixture field can be identified.
2. **The evaluator misunderstood the required `files` representation because the prompt names the field but never says it is a path-to-content object.** This predicts valid JSON with a consistent array representation in both attempts.
3. **The compiler incorrectly rejects the documented array representation.** This predicts documentation or tests that define `files` as an array rather than a record.

## Evidence and conclusion

Hypothesis 2 is proven. Both outputs parse as valid JSON and consistently use `files: [{path,content}]`. The prompt says the fixture shape contains `files` and describes what it contains, but never states its JSON type. The compiler and TypeScript fixture type require `Readonly<Record<string,string>>`. The repair prompt repeats semantic constraints but still omits the representation, so the same error recurs. Hypothesis 1 is falsified by successful JSON parsing and field-specific validation. Hypothesis 3 is falsified by the compiler type, existing tests, and stored fixture-object format.

## Five whys

1. Why did the evolution job fail before evaluation? The generated suite could not compile.
2. Why could it not compile? Every fixture used an array for `files`.
3. Why did the evaluator choose an array? `{path,content}` is a natural representation and the prompt did not forbid it.
4. Why did repair repeat it? The validator reported only an invalid fixture shape and the repair instructions did not restate the exact `files` type.
5. Why was this missed? Tests asserted broad fixture instructions but not the wire-level representation needed by an untyped model response.

## Fix and falsification test

State in both authoring and repair prompts that `files` must be a JSON object mapping safe relative path keys directly to string contents, never an array. Regression assertions will require that wording in both child objectives. If either prompt omits it, the fix is incomplete.
