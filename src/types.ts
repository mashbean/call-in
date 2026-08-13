export type QuestionLens = "clarify" | "chorus" | "bridge" | "keeper";
export type ReactionKind = "applause" | "insight" | "resonate" | "pause";

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
  polls: PollResult[];
  difficulty: DifficultySnapshot;
  questions: AudienceQuestion[];
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
  reactions: Array<{ id: ReactionKind; emoji: string; label: string }>;
  polls: Poll[];
};
