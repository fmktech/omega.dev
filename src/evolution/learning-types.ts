export type LearningTarget = "knowledge" | "skill" | "runner" | "tool" | "policy";

/** One externally observable operation learned from project evidence. */
export type ObservableContract = {
  readonly operation: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly errors: readonly string[];
  readonly sideEffects: readonly string[];
  /** Exact paths, commands, signatures, status codes, error codes, or wire values. */
  readonly exactValues: readonly string[];
};

export type CrystallizedLesson = {
  readonly sourceIds: readonly string[];
  readonly target: LearningTarget;
  readonly title: string;
  readonly guidance: string;
  /** Repository-relative paths that make this lesson relevant. */
  readonly relevantPaths?: readonly string[];
  /** Concrete task conditions that should cause the lesson to be loaded. */
  readonly appliesWhen?: readonly string[];
  /** Concrete task conditions that should prevent adjacent-task over-triggering. */
  readonly doesNotApplyWhen?: readonly string[];
  /** Explicit observable behavior that must survive reflection without abstraction loss. */
  readonly observableContracts?: readonly ObservableContract[];
};
