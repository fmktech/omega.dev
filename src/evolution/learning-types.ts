export type LearningTarget = "knowledge" | "skill" | "runner" | "tool" | "policy";

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
};
