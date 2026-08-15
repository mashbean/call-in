export type QuestionLens = "clarify" | "chorus" | "bridge" | "keeper";
export type ReactionKind = "applause" | "insight" | "resonate" | "pause";
export type SessionMode = "open" | "slow" | "approval" | "paused" | "closed";
export type QuestionVisibility = "pending" | "public" | "author_only";
export type ParticipantQuestionState = "normal" | "review" | "muted";
export type ModerationReason = "harassment" | "disruption" | "off_topic" | "privacy" | "other";

export type Poll = {
  id: string;
  question: string;
  prompt: string;
  options: string[];
};

export type PollResult = Poll & {
  counts: number[];
  total: number;
};

export type AudienceQuestion = {
  id: string;
  text: string;
  nickname: string;
  lens: QuestionLens;
  difficulty: number;
  createdAt: number;
  upvotes: number;
};

export type DifficultySnapshot = {
  counts: number[];
  total: number;
  average: number | null;
};

export type SessionSnapshot = {
  updatedAt: number;
  session: { mode: SessionMode };
  polls: PollResult[];
  difficulty: DifficultySnapshot;
  questions: AudienceQuestion[];
};

export type ParticipantProfile = {
  alias: string;
  publicLabel: string;
  cocVersion: string;
  questionState: ParticipantQuestionState;
  slowUntil: number | null;
};

export type OwnQuestion = AudienceQuestion & {
  visibility: QuestionVisibility;
  statusLabel: string;
};

export type ParticipantState = {
  participant: ParticipantProfile | null;
  questions: OwnQuestion[];
};

export type QuestionSubmission = {
  snapshot: SessionSnapshot;
  submission: OwnQuestion;
};

export type ModeratorQuestion = OwnQuestion & {
  voterId: string;
  moderationReason: ModerationReason | null;
  moderatedAt: number | null;
};

export type ModerationAction = {
  id: string;
  questionId: string | null;
  voterId: string | null;
  action: string;
  reason: string;
  actor: string;
  createdAt: number;
};

export type ModeratorSnapshot = {
  updatedAt: number;
  session: { mode: SessionMode };
  questions: ModeratorQuestion[];
  actions: ModerationAction[];
};

export type PublicEventConfig = {
  eventId: string;
  eyebrow: string;
  title: string;
  description: string;
  dashboardTitle: string;
  deckUrl: string;
  locale: string;
  theme: Record<string, string>;
  difficulty: { title: string; labels: string[] };
  question: {
    title: string;
    placeholder: string;
    maxPerDevice: number;
    lenses: Array<{ id: QuestionLens; label: string; description: string }>;
  };
  moderation?: {
    enabled: boolean;
    presentationDelaySeconds: number;
    questionCooldownSeconds: number;
    questionsPerTenMinutes: number;
    slowModeSeconds: number;
    codeOfConduct: {
      version: string;
      title: string;
      summary: string;
      rules: string[];
    };
  };
  reactions: Array<{ id: ReactionKind; emoji: string; label: string }>;
  polls: Poll[];
};
