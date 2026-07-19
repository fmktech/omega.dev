export type LearningTarget = "knowledge" | "skill" | "runner" | "tool" | "policy";

export type CrystallizedLesson = {
  readonly sourceIds: readonly string[];
  readonly target: LearningTarget;
  readonly title: string;
  readonly guidance: string;
};
