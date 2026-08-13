import { DurableObject } from "cloudflare:workers";
import { EVENT_CONFIG, QUESTION_LENSES, REACTION_KINDS } from "./config";
import type {
  AudienceQuestion,
  DifficultySnapshot,
  QuestionLens,
  ReactionKind,
  SessionSnapshot,
} from "./types";
import { assertDifficulty, assertVoterId, cleanText, isUuid } from "./validation";

type QuestionRow = {
  id: string;
  text: string;
  nickname: string;
  lens: QuestionLens;
  difficulty: number;
  created_at: number;
  upvotes: number;
};

type ExportData = {
  exportedAt: number;
  snapshot: SessionSnapshot;
  questionCount: number;
};

export class LiveSession extends DurableObject<Env> {
  private snapshotCache: SessionSnapshot | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        poll_id TEXT NOT NULL,
        voter_id TEXT NOT NULL,
        option_index INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (poll_id, voter_id)
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        voter_id TEXT NOT NULL,
        text TEXT NOT NULL,
        nickname TEXT NOT NULL,
        lens TEXT NOT NULL DEFAULT 'clarify',
        difficulty INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS difficulty_votes (
        voter_id TEXT PRIMARY KEY,
        score INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS question_votes (
        question_id TEXT NOT NULL,
        voter_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (question_id, voter_id),
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions(created_at);
      CREATE INDEX IF NOT EXISTS idx_questions_voter_id ON questions(voter_id);
      CREATE INDEX IF NOT EXISTS idx_question_votes_question_id ON question_votes(question_id);
    `);
  }

  async snapshot(): Promise<SessionSnapshot> {
    if (this.snapshotCache) return this.snapshotCache;

    const polls = EVENT_CONFIG.polls.map((poll) => {
      const counts = new Array<number>(poll.options.length).fill(0);
      const rows = this.ctx.storage.sql
        .exec<{ option_index: number; count: number }>(
          "SELECT option_index, COUNT(*) AS count FROM votes WHERE poll_id = ? GROUP BY option_index",
          poll.id,
        )
        .toArray();
      for (const row of rows) {
        if (row.option_index >= 0 && row.option_index < counts.length) {
          counts[row.option_index] = row.count;
        }
      }
      return { ...poll, counts, total: counts.reduce((sum, count) => sum + count, 0) };
    });

    const questions = this.ctx.storage.sql
      .exec<QuestionRow>(`
        SELECT
          q.id,
          q.text,
          q.nickname,
          q.lens,
          q.difficulty,
          q.created_at,
          COUNT(qv.question_id) AS upvotes
        FROM questions q
        LEFT JOIN question_votes qv ON qv.question_id = q.id
        GROUP BY q.id
        ORDER BY q.created_at DESC
        LIMIT 100
      `)
      .toArray()
      .map(toAudienceQuestion);

    const difficultyCounts = new Array<number>(5).fill(0);
    const difficultyRows = this.ctx.storage.sql
      .exec<{ score: number; count: number }>(
        "SELECT score, COUNT(*) AS count FROM difficulty_votes GROUP BY score",
      )
      .toArray();
    for (const row of difficultyRows) {
      if (row.score >= 1 && row.score <= 5) difficultyCounts[row.score - 1] = row.count;
    }
    const difficultyTotal = difficultyCounts.reduce((sum, count) => sum + count, 0);
    const weightedDifficulty = difficultyCounts.reduce(
      (sum, count, index) => sum + count * (index + 1),
      0,
    );
    const difficulty: DifficultySnapshot = {
      counts: difficultyCounts,
      total: difficultyTotal,
      average: difficultyTotal
        ? Math.round((weightedDifficulty / difficultyTotal) * 10) / 10
        : null,
    };

    this.snapshotCache = { updatedAt: Date.now(), polls, difficulty, questions };
    return this.snapshotCache;
  }

  async vote(pollId: string, optionIndex: number, voterId: string): Promise<SessionSnapshot> {
    const poll = EVENT_CONFIG.polls.find((candidate) => candidate.id === pollId);
    if (
      !poll ||
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      optionIndex >= poll.options.length
    ) {
      throw new Error("invalid vote");
    }
    assertVoterId(voterId);
    const snapshot = await this.snapshot();
    const previous = this.ctx.storage.sql
      .exec<{ option_index: number }>(
        "SELECT option_index FROM votes WHERE poll_id = ? AND voter_id = ?",
        pollId,
        voterId,
      )
      .toArray()[0];
    this.ctx.storage.sql.exec(
      `INSERT INTO votes (poll_id, voter_id, option_index, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (poll_id, voter_id)
       DO UPDATE SET option_index = excluded.option_index, updated_at = excluded.updated_at`,
      pollId,
      voterId,
      optionIndex,
      Date.now(),
    );
    if (previous?.option_index !== optionIndex) {
      const result = snapshot.polls.find((candidate) => candidate.id === pollId);
      if (result) {
        if (previous) {
          const previousCount = result.counts[previous.option_index];
          if (typeof previousCount === "number") result.counts[previous.option_index] = previousCount - 1;
        } else {
          result.total += 1;
        }
        const nextCount = result.counts[optionIndex];
        if (typeof nextCount === "number") result.counts[optionIndex] = nextCount + 1;
      }
    }
    return this.broadcastSnapshot(this.touch(snapshot));
  }

  async ask(
    text: string,
    nickname: string,
    lens: QuestionLens,
    difficulty: number,
    voterId: string,
  ): Promise<SessionSnapshot> {
    const cleanedText = cleanText(text, 280);
    const cleanedNickname = cleanText(nickname || "匿名", 24);
    assertVoterId(voterId);
    if (cleanedText.length < 4) throw new Error("question too short");
    if (!QUESTION_LENSES.has(lens)) throw new Error("invalid question lens");
    assertDifficulty(difficulty);

    const snapshot = await this.snapshot();
    const prior = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM questions WHERE voter_id = ?", voterId)
      .one();
    if (prior.count >= EVENT_CONFIG.question.maxPerDevice) {
      throw new Error("question limit reached");
    }

    const previousDifficulty = this.ctx.storage.sql
      .exec<{ score: number }>("SELECT score FROM difficulty_votes WHERE voter_id = ?", voterId)
      .toArray()[0];
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO difficulty_votes (voter_id, score, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (voter_id)
       DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
      voterId,
      difficulty,
      now,
    );
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO questions (id, voter_id, text, nickname, lens, difficulty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      voterId,
      cleanedText,
      cleanedNickname,
      lens,
      difficulty,
      now,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO question_votes (question_id, voter_id, created_at) VALUES (?, ?, ?)",
      id,
      voterId,
      now,
    );
    this.updateDifficultySnapshot(snapshot.difficulty, previousDifficulty?.score, difficulty);
    snapshot.questions.unshift({
      id,
      text: cleanedText,
      nickname: cleanedNickname,
      lens,
      difficulty,
      createdAt: now,
      upvotes: 1,
    });
    snapshot.questions = snapshot.questions.slice(0, 100);
    return this.broadcastSnapshot(this.touch(snapshot));
  }

  async setDifficulty(score: number, voterId: string): Promise<SessionSnapshot> {
    assertVoterId(voterId);
    assertDifficulty(score);
    const snapshot = await this.snapshot();
    const previous = this.ctx.storage.sql
      .exec<{ score: number }>("SELECT score FROM difficulty_votes WHERE voter_id = ?", voterId)
      .toArray()[0];
    this.ctx.storage.sql.exec(
      `INSERT INTO difficulty_votes (voter_id, score, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (voter_id)
       DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
      voterId,
      score,
      Date.now(),
    );
    this.updateDifficultySnapshot(snapshot.difficulty, previous?.score, score);
    return this.broadcastSnapshot(this.touch(snapshot));
  }

  async upvote(questionId: string, voterId: string): Promise<SessionSnapshot> {
    assertVoterId(voterId);
    if (!isUuid(questionId)) throw new Error("invalid question");
    const snapshot = await this.snapshot();
    const exists = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM questions WHERE id = ?", questionId)
      .one();
    if (exists.count === 0) throw new Error("question not found");
    const priorVote = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM question_votes WHERE question_id = ? AND voter_id = ?",
        questionId,
        voterId,
      )
      .one();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO question_votes (question_id, voter_id, created_at) VALUES (?, ?, ?)",
      questionId,
      voterId,
      Date.now(),
    );
    if (priorVote.count === 0) {
      const question = snapshot.questions.find((candidate) => candidate.id === questionId);
      if (question) question.upvotes += 1;
    }
    return this.broadcastSnapshot(this.touch(snapshot));
  }

  async react(kind: ReactionKind, voterId: string): Promise<{ ok: true }> {
    assertVoterId(voterId);
    if (!REACTION_KINDS.has(kind)) throw new Error("invalid reaction");
    const payload = JSON.stringify({
      type: "reaction",
      data: { id: crypto.randomUUID(), kind, createdAt: Date.now() },
    });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (error) {
        console.error(JSON.stringify({ message: "reaction broadcast failed", error: String(error) }));
      }
    }
    return { ok: true };
  }

  async reset(): Promise<SessionSnapshot> {
    this.ctx.storage.sql.exec("DELETE FROM question_votes");
    this.ctx.storage.sql.exec("DELETE FROM questions");
    this.ctx.storage.sql.exec("DELETE FROM difficulty_votes");
    this.ctx.storage.sql.exec("DELETE FROM votes");
    this.snapshotCache = null;
    return this.broadcastSnapshot(await this.snapshot());
  }

  async exportData(): Promise<ExportData> {
    const questionCount = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM questions")
      .one().count;
    return { exportedAt: Date.now(), snapshot: await this.snapshot(), questionCount };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "snapshot", data: await this.snapshot() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message === "ping") socket.send("pong");
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    console.error(JSON.stringify({ message: "websocket error", error: String(error) }));
    socket.close(1011, "websocket error");
  }

  private touch(snapshot: SessionSnapshot): SessionSnapshot {
    snapshot.updatedAt = Date.now();
    this.snapshotCache = snapshot;
    return snapshot;
  }

  private updateDifficultySnapshot(
    snapshot: DifficultySnapshot,
    previousScore: number | undefined,
    nextScore: number,
  ): void {
    if (previousScore === nextScore) return;
    if (previousScore) {
      const previousCount = snapshot.counts[previousScore - 1];
      if (typeof previousCount === "number") snapshot.counts[previousScore - 1] = previousCount - 1;
    } else {
      snapshot.total += 1;
    }
    const nextCount = snapshot.counts[nextScore - 1];
    if (typeof nextCount === "number") snapshot.counts[nextScore - 1] = nextCount + 1;
    const weighted = snapshot.counts.reduce(
      (sum, count, index) => sum + count * (index + 1),
      0,
    );
    snapshot.average = snapshot.total
      ? Math.round((weighted / snapshot.total) * 10) / 10
      : null;
  }

  private async broadcastSnapshot(snapshot?: SessionSnapshot): Promise<SessionSnapshot> {
    const currentSnapshot = snapshot ?? (await this.snapshot());
    const payload = JSON.stringify({ type: "snapshot", data: currentSnapshot });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (error) {
        console.error(JSON.stringify({ message: "snapshot broadcast failed", error: String(error) }));
      }
    }
    return currentSnapshot;
  }
}

function toAudienceQuestion(row: QuestionRow): AudienceQuestion {
  return {
    id: row.id,
    text: row.text,
    nickname: row.nickname,
    lens: row.lens,
    difficulty: row.difficulty,
    createdAt: row.created_at,
    upvotes: row.upvotes,
  };
}
