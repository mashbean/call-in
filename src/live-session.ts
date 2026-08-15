import { DurableObject } from "cloudflare:workers";
import { EVENT_CONFIG, QUESTION_LENSES, REACTION_KINDS } from "./config";
import type {
  AudienceQuestion,
  DifficultySnapshot,
  FlagReason,
  ModerationAction,
  ModerationReason,
  ModeratorQuestion,
  ModeratorSnapshot,
  OwnQuestion,
  ParticipantProfile,
  ParticipantQuestionState,
  ParticipantState,
  QuestionLens,
  QuestionSubmission,
  QuestionVisibility,
  ReactionKind,
  SessionMode,
  SessionSnapshot,
} from "./types";
import { assertDifficulty, assertVoterId, cleanText, isUuid } from "./validation";

type QuestionRow = {
  id: string;
  voter_id: string;
  text: string;
  nickname: string;
  lens: QuestionLens;
  difficulty: number;
  created_at: number;
  upvotes: number;
  visibility: QuestionVisibility;
  publish_at: number | null;
  moderation_reason: ModerationReason | null;
  moderated_at: number | null;
  flag_count?: number;
  flag_weight?: number;
  harassment_flags?: number;
  disruption_flags?: number;
  off_topic_flags?: number;
  privacy_flags?: number;
};

type ParticipantRow = {
  voter_id: string;
  alias: string;
  public_label: string;
  coc_version: string;
  question_state: ParticipantQuestionState;
  slow_until: number | null;
  flags_agreed: number;
  flags_rejected: number;
};

type ModerationActionRow = {
  id: string;
  question_id: string | null;
  voter_id: string | null;
  action: string;
  reason: string;
  actor: string;
  created_at: number;
};

type QuestionFlagExport = {
  question_id: string;
  voter_id: string;
  reason: FlagReason;
  weight: number;
  status: "pending" | "agreed" | "rejected";
  created_at: number;
  resolved_at: number | null;
};

type ExportData = {
  exportedAt: number;
  snapshot: SessionSnapshot;
  questions: QuestionRow[];
  participants: ParticipantRow[];
  questionFlags: QuestionFlagExport[];
  moderationActions: ModerationAction[];
};

const moderation = EVENT_CONFIG.moderation;

export class LiveSession extends DurableObject<Env> {
  private snapshotCache: SessionSnapshot | null = null;
  private readonly reactionWindows = new Map<string, number[]>();

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
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions(created_at);
      CREATE INDEX IF NOT EXISTS idx_questions_voter_id ON questions(voter_id);
      CREATE INDEX IF NOT EXISTS idx_question_votes_question_id ON question_votes(question_id);
    `);

    const version = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
      )
      .one().version;
    if (version < 2) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE questions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
        ALTER TABLE questions ADD COLUMN publish_at INTEGER;
        ALTER TABLE questions ADD COLUMN moderation_reason TEXT;
        ALTER TABLE questions ADD COLUMN moderated_at INTEGER;
        ALTER TABLE questions ADD COLUMN moderated_by TEXT;
        CREATE TABLE participants (
          voter_id TEXT PRIMARY KEY,
          alias TEXT NOT NULL,
          public_label TEXT NOT NULL,
          coc_version TEXT NOT NULL,
          coc_accepted_at INTEGER NOT NULL,
          question_state TEXT NOT NULL DEFAULT 'normal',
          slow_until INTEGER,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE moderation_actions (
          id TEXT PRIMARY KEY,
          question_id TEXT,
          voter_id TEXT,
          action TEXT NOT NULL,
          reason TEXT NOT NULL,
          actor TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE session_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          mode TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO session_settings (id, mode, updated_at) VALUES (1, 'open', ${Date.now()});
        CREATE INDEX idx_questions_visibility_publish_at ON questions(visibility, publish_at);
        CREATE INDEX idx_moderation_actions_created_at ON moderation_actions(created_at);
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, ${Date.now()});
      `);
    }
    if (version < 3) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE participants ADD COLUMN flags_agreed INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE participants ADD COLUMN flags_rejected INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE question_flags (
          question_id TEXT NOT NULL,
          voter_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          weight REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          PRIMARY KEY (question_id, voter_id),
          FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
          FOREIGN KEY (voter_id) REFERENCES participants(voter_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_question_flags_question_status ON question_flags(question_id, status);
        CREATE INDEX idx_question_flags_voter_id ON question_flags(voter_id);
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, ${Date.now()});
      `);
    }
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
          q.id, q.voter_id, q.text, q.nickname, q.lens, q.difficulty, q.created_at,
          q.visibility, q.publish_at, q.moderation_reason, q.moderated_at,
          COUNT(qv.question_id) AS upvotes
        FROM questions q
        LEFT JOIN question_votes qv ON qv.question_id = q.id
        WHERE q.visibility = 'public'
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

    this.snapshotCache = {
      updatedAt: Date.now(),
      session: { mode: this.getSessionMode() },
      polls,
      difficulty,
      questions,
    };
    return this.snapshotCache;
  }

  async registerParticipant(
    alias: string,
    cocVersion: string,
    voterId: string,
  ): Promise<ParticipantState> {
    assertVoterId(voterId);
    if (!moderation?.enabled) return { participant: null, questions: [] };
    const cleanedAlias = cleanText(alias, 24);
    if (cleanedAlias.length < 2) throw new Error("alias too short");
    if (cocVersion !== moderation.codeOfConduct.version) {
      throw new Error("code of conduct must be accepted");
    }
    const now = Date.now();
    const existing = this.getParticipantRow(voterId);
    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE participants SET coc_version = ?, coc_accepted_at = ?, last_seen_at = ? WHERE voter_id = ?",
        cocVersion,
        now,
        now,
        voterId,
      );
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO participants
          (voter_id, alias, public_label, coc_version, coc_accepted_at, question_state, slow_until, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'normal', NULL, ?, ?)`,
        voterId,
        cleanedAlias,
        `${cleanedAlias} #${shortBadge(voterId)}`,
        cocVersion,
        now,
        now,
        now,
      );
    }
    const state = await this.participantState(voterId);
    await this.broadcastParticipantState(voterId, state);
    return state;
  }

  async participantState(voterId: string): Promise<ParticipantState> {
    assertVoterId(voterId);
    const participant = this.getParticipantRow(voterId);
    const questions = this.ctx.storage.sql
      .exec<QuestionRow>(`
        SELECT
          q.id, q.voter_id, q.text, q.nickname, q.lens, q.difficulty, q.created_at,
          q.visibility, q.publish_at, q.moderation_reason, q.moderated_at,
          COUNT(qv.question_id) AS upvotes
        FROM questions q
        LEFT JOIN question_votes qv ON qv.question_id = q.id
        WHERE q.voter_id = ?
        GROUP BY q.id
        ORDER BY q.created_at DESC
        LIMIT 20
      `, voterId)
      .toArray()
      .map(toOwnQuestion);
    return { participant: participant ? toParticipantProfile(participant) : null, questions };
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
  ): Promise<QuestionSubmission> {
    const cleanedText = cleanText(text, 280);
    assertVoterId(voterId);
    if (cleanedText.length < 4) throw new Error("question too short");
    if (!QUESTION_LENSES.has(lens)) throw new Error("invalid question lens");
    assertDifficulty(difficulty);

    const sessionMode = this.getSessionMode();
    if (sessionMode === "paused") throw new Error("questions are paused");
    if (sessionMode === "closed") throw new Error("session is closed");

    const participant = this.getParticipantRow(voterId);
    if (moderation?.enabled) {
      if (!participant || participant.coc_version !== moderation.codeOfConduct.version) {
        throw new Error("code of conduct must be accepted");
      }
      if (participant.question_state === "muted") throw new Error("question access is limited");
    }

    const prior = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM questions WHERE voter_id = ?", voterId)
      .one();
    if (prior.count >= EVENT_CONFIG.question.maxPerDevice) {
      throw new Error("question limit reached");
    }

    const now = Date.now();
    if (moderation?.enabled) {
      const recent = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM questions WHERE voter_id = ? AND created_at >= ?",
          voterId,
          now - 10 * 60 * 1000,
        )
        .one().count;
      if (recent >= moderation.questionsPerTenMinutes) throw new Error("question rate limit reached");
      const latest = this.ctx.storage.sql
        .exec<{ created_at: number }>(
          "SELECT created_at FROM questions WHERE voter_id = ? ORDER BY created_at DESC LIMIT 1",
          voterId,
        )
        .toArray()[0];
      const isSlow = sessionMode === "slow" || Boolean(participant?.slow_until && participant.slow_until > now);
      const cooldownSeconds = isSlow
        ? Math.max(moderation.slowModeSeconds, moderation.questionCooldownSeconds)
        : moderation.questionCooldownSeconds;
      if (latest && now - latest.created_at < cooldownSeconds * 1000) {
        throw new Error("question cooldown active");
      }
    }

    const snapshot = await this.snapshot();
    const previousDifficulty = this.ctx.storage.sql
      .exec<{ score: number }>("SELECT score FROM difficulty_votes WHERE voter_id = ?", voterId)
      .toArray()[0];
    this.ctx.storage.sql.exec(
      `INSERT INTO difficulty_votes (voter_id, score, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (voter_id)
       DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
      voterId,
      difficulty,
      now,
    );

    const requiresApproval = sessionMode === "approval" || participant?.question_state === "review";
    const delay = moderation?.enabled ? moderation.presentationDelaySeconds * 1000 : 0;
    const visibility: QuestionVisibility = requiresApproval || delay > 0 ? "pending" : "public";
    const publishAt = visibility === "pending" && !requiresApproval ? now + delay : null;
    const publicLabel = participant?.public_label ?? cleanText(nickname || "Anonymous", 24);
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO questions
        (id, voter_id, text, nickname, lens, difficulty, created_at, visibility, publish_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      voterId,
      cleanedText,
      publicLabel,
      lens,
      difficulty,
      now,
      visibility,
      publishAt,
    );
    if (participant) {
      this.ctx.storage.sql.exec(
        "UPDATE participants SET last_seen_at = ? WHERE voter_id = ?",
        now,
        voterId,
      );
    }
    this.updateDifficultySnapshot(snapshot.difficulty, previousDifficulty?.score, difficulty);
    if (visibility === "public") {
      snapshot.questions.unshift({
        id,
        text: cleanedText,
        nickname: publicLabel,
        lens,
        difficulty,
        createdAt: now,
        upvotes: 0,
      });
      snapshot.questions = snapshot.questions.slice(0, 100);
    }
    if (publishAt) await this.scheduleNextPublication();
    const nextSnapshot = await this.broadcastSnapshot(this.touch(snapshot));
    const result = {
      snapshot: nextSnapshot,
      submission: {
        id,
        text: cleanedText,
        nickname: publicLabel,
        lens,
        difficulty,
        createdAt: now,
        upvotes: 0,
        visibility,
        statusLabel: statusLabel(visibility),
      },
    };
    await this.broadcastParticipantState(voterId);
    return result;
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
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM questions WHERE id = ? AND visibility = 'public'",
        questionId,
      )
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

  async flagQuestion(
    questionId: string,
    reason: FlagReason,
    voterId: string,
  ): Promise<{ ok: true; held: boolean }> {
    assertVoterId(voterId);
    if (!isUuid(questionId)) throw new Error("invalid question");
    if (!moderation?.enabled || !moderation.flags.enabled) throw new Error("flagging is disabled");
    if (!["harassment", "disruption", "off_topic", "privacy"].includes(reason)) {
      throw new Error("invalid flag reason");
    }
    const participant = this.getParticipantRow(voterId);
    if (!participant || participant.coc_version !== moderation.codeOfConduct.version) {
      throw new Error("code of conduct must be accepted");
    }
    const question = this.ctx.storage.sql
      .exec<{ voter_id: string; visibility: QuestionVisibility }>(
        "SELECT voter_id, visibility FROM questions WHERE id = ?",
        questionId,
      )
      .toArray()[0];
    if (!question || question.visibility !== "public") throw new Error("question not found");
    if (question.voter_id === voterId) throw new Error("cannot flag your own question");

    const existing = this.ctx.storage.sql
      .exec<{ status: string }>(
        "SELECT status FROM question_flags WHERE question_id = ? AND voter_id = ?",
        questionId,
        voterId,
      )
      .toArray()[0];
    if (existing) return { ok: true, held: false };
    const flagTotal = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM question_flags WHERE voter_id = ?",
        voterId,
      )
      .one().count;
    if (flagTotal >= moderation.flags.maxPerDevice) throw new Error("flag limit reached");

    const weight = flagTrustWeight(participant.flags_agreed, participant.flags_rejected);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO question_flags
        (question_id, voter_id, reason, weight, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      questionId,
      voterId,
      reason,
      weight,
      now,
    );
    const summary = this.getFlagSummary(questionId);
    const threshold = this.flagThreshold();
    const held = summary.count >= moderation.flags.autoHoldMin && summary.weight >= threshold;
    if (held) {
      this.ctx.storage.sql.exec(
        `UPDATE questions
         SET visibility = 'author_only', publish_at = NULL,
             moderation_reason = 'disruption', moderated_at = ?, moderated_by = 'community'
         WHERE id = ? AND visibility = 'public'`,
        now,
        questionId,
      );
      this.recordModerationAction(
        questionId,
        question.voter_id,
        "auto_hold",
        "community_flags",
        now,
        "community",
      );
      this.snapshotCache = null;
      await this.broadcastSnapshot();
      await this.broadcastParticipantState(question.voter_id);
    } else {
      this.broadcastModerationActivity();
    }
    return { ok: true, held };
  }

  async react(kind: ReactionKind, voterId: string): Promise<{ ok: true }> {
    assertVoterId(voterId);
    if (!REACTION_KINDS.has(kind)) throw new Error("invalid reaction");
    const now = Date.now();
    const window = (this.reactionWindows.get(voterId) ?? []).filter((time) => now - time < 10_000);
    if (window.length >= 3) throw new Error("reaction rate limit reached");
    window.push(now);
    this.reactionWindows.set(voterId, window);
    const payload = JSON.stringify({
      type: "reaction",
      data: { id: crypto.randomUUID(), kind, createdAt: now },
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

  async moderatorSnapshot(): Promise<ModeratorSnapshot> {
    const flagThreshold = this.flagThreshold();
    const questions = this.ctx.storage.sql
      .exec<QuestionRow>(`
        SELECT
          q.id, q.voter_id, q.text, q.nickname, q.lens, q.difficulty, q.created_at,
          q.visibility, q.publish_at, q.moderation_reason, q.moderated_at,
          (SELECT COUNT(*) FROM question_votes qv WHERE qv.question_id = q.id) AS upvotes,
          (SELECT COUNT(*) FROM question_flags qf WHERE qf.question_id = q.id AND qf.status = 'pending') AS flag_count,
          (SELECT COALESCE(SUM(qf.weight), 0) FROM question_flags qf WHERE qf.question_id = q.id AND qf.status = 'pending') AS flag_weight,
          (SELECT COUNT(*) FROM question_flags qf WHERE qf.question_id = q.id AND qf.status = 'pending' AND qf.reason = 'harassment') AS harassment_flags,
          (SELECT COUNT(*) FROM question_flags qf WHERE qf.question_id = q.id AND qf.status = 'pending' AND qf.reason = 'disruption') AS disruption_flags,
          (SELECT COUNT(*) FROM question_flags qf WHERE qf.question_id = q.id AND qf.status = 'pending' AND qf.reason = 'off_topic') AS off_topic_flags,
          (SELECT COUNT(*) FROM question_flags qf WHERE qf.question_id = q.id AND qf.status = 'pending' AND qf.reason = 'privacy') AS privacy_flags
        FROM questions q
        ORDER BY
          CASE WHEN q.visibility = 'author_only' AND q.moderated_by = 'community' THEN 0
               WHEN q.visibility = 'pending' THEN 1 WHEN q.visibility = 'public' THEN 2 ELSE 3 END,
          flag_weight DESC,
          q.created_at DESC
        LIMIT 200
      `)
      .toArray()
      .map((row) => toModeratorQuestion(row, flagThreshold));
    const actions = this.ctx.storage.sql
      .exec<ModerationActionRow>(
        "SELECT * FROM moderation_actions ORDER BY created_at DESC LIMIT 100",
      )
      .toArray()
      .map(toModerationAction);
    return {
      updatedAt: Date.now(),
      session: { mode: this.getSessionMode() },
      questions,
      actions,
    };
  }

  async moderateQuestion(
    questionId: string,
    action: "hide" | "restore",
    reason: ModerationReason,
  ): Promise<ModeratorSnapshot> {
    if (!isUuid(questionId)) throw new Error("invalid question");
    const row = this.ctx.storage.sql
      .exec<{ voter_id: string }>("SELECT voter_id FROM questions WHERE id = ?", questionId)
      .toArray()[0];
    if (!row) throw new Error("question not found");
    const now = Date.now();
    const visibility: QuestionVisibility = action === "hide" ? "author_only" : "public";
    this.ctx.storage.sql.exec(
      `UPDATE questions
       SET visibility = ?, publish_at = NULL, moderation_reason = ?, moderated_at = ?, moderated_by = 'moderator'
       WHERE id = ?`,
      visibility,
      action === "hide" ? reason : null,
      now,
      questionId,
    );
    this.resolveFlags(questionId, action === "hide" ? "agreed" : "rejected", now);
    this.recordModerationAction(questionId, row.voter_id, action, reason, now);
    this.snapshotCache = null;
    await this.broadcastSnapshot();
    await this.broadcastParticipantState(row.voter_id);
    return this.moderatorSnapshot();
  }

  async moderateParticipant(
    voterId: string,
    action: "slow" | "review" | "mute" | "restore",
    reason: ModerationReason,
  ): Promise<ModeratorSnapshot> {
    assertVoterId(voterId);
    const participant = this.getParticipantRow(voterId);
    if (!participant) throw new Error("participant not found");
    const now = Date.now();
    const nextState: ParticipantQuestionState =
      action === "review" ? "review" : action === "mute" ? "muted" : "normal";
    const slowUntil = action === "slow" ? now + 10 * 60 * 1000 : null;
    this.ctx.storage.sql.exec(
      "UPDATE participants SET question_state = ?, slow_until = ?, last_seen_at = ? WHERE voter_id = ?",
      nextState,
      slowUntil,
      now,
      voterId,
    );
    this.recordModerationAction(null, voterId, action, reason, now);
    await this.broadcastParticipantState(voterId);
    return this.moderatorSnapshot();
  }

  async setSessionMode(mode: SessionMode): Promise<ModeratorSnapshot> {
    if (!["open", "slow", "approval", "paused", "closed"].includes(mode)) {
      throw new Error("invalid session mode");
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE session_settings SET mode = ?, updated_at = ? WHERE id = 1",
      mode,
      now,
    );
    this.recordModerationAction(null, null, `session:${mode}`, "other", now);
    this.snapshotCache = null;
    await this.broadcastSnapshot();
    return this.moderatorSnapshot();
  }

  async reset(): Promise<SessionSnapshot> {
    this.ctx.storage.sql.exec("DELETE FROM moderation_actions");
    this.ctx.storage.sql.exec("DELETE FROM question_flags");
    this.ctx.storage.sql.exec("DELETE FROM question_votes");
    this.ctx.storage.sql.exec("DELETE FROM questions");
    this.ctx.storage.sql.exec("DELETE FROM participants");
    this.ctx.storage.sql.exec("DELETE FROM difficulty_votes");
    this.ctx.storage.sql.exec("DELETE FROM votes");
    this.ctx.storage.sql.exec(
      "UPDATE session_settings SET mode = 'open', updated_at = ? WHERE id = 1",
      Date.now(),
    );
    await this.ctx.storage.deleteAlarm();
    this.reactionWindows.clear();
    this.snapshotCache = null;
    return this.broadcastSnapshot(await this.snapshot());
  }

  async exportData(): Promise<ExportData> {
    const questions = this.ctx.storage.sql
      .exec<QuestionRow>(`
        SELECT
          q.id, q.voter_id, q.text, q.nickname, q.lens, q.difficulty, q.created_at,
          q.visibility, q.publish_at, q.moderation_reason, q.moderated_at,
          COUNT(qv.question_id) AS upvotes
        FROM questions q
        LEFT JOIN question_votes qv ON qv.question_id = q.id
        GROUP BY q.id
        ORDER BY q.created_at DESC
      `)
      .toArray();
    const participants = this.ctx.storage.sql
      .exec<ParticipantRow>(
        "SELECT voter_id, alias, public_label, coc_version, question_state, slow_until, flags_agreed, flags_rejected FROM participants ORDER BY created_at",
      )
      .toArray();
    const moderationActions = this.ctx.storage.sql
      .exec<ModerationActionRow>("SELECT * FROM moderation_actions ORDER BY created_at")
      .toArray()
      .map(toModerationAction);
    const questionFlags = this.ctx.storage.sql
      .exec<QuestionFlagExport>(
        `SELECT question_id, voter_id, reason, weight, status, created_at, resolved_at
         FROM question_flags ORDER BY created_at`,
      )
      .toArray();
    return {
      exportedAt: Date.now(),
      snapshot: await this.snapshot(),
      questions,
      participants,
      questionFlags,
      moderationActions,
    };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const affectedVoters = this.ctx.storage.sql
      .exec<{ voter_id: string }>(
        `SELECT DISTINCT voter_id FROM questions
         WHERE visibility = 'pending' AND publish_at IS NOT NULL AND publish_at <= ?`,
        now,
      )
      .toArray();
    this.ctx.storage.sql.exec(
      `UPDATE questions
       SET visibility = 'public', publish_at = NULL
       WHERE visibility = 'pending' AND publish_at IS NOT NULL AND publish_at <= ?`,
      now,
    );
    this.snapshotCache = null;
    await this.broadcastSnapshot();
    for (const row of affectedVoters) await this.broadcastParticipantState(row.voter_id);
    await this.scheduleNextPublication();
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
    if (typeof message !== "string") return;
    if (message === "ping") {
      socket.send("pong");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(message);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "type" in parsed &&
        parsed.type === "identify" &&
        "voterId" in parsed &&
        typeof parsed.voterId === "string" &&
        isUuid(parsed.voterId)
      ) {
        socket.serializeAttachment({ voterId: parsed.voterId });
        socket.send(
          JSON.stringify({ type: "participant", data: await this.participantState(parsed.voterId) }),
        );
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "invalid websocket message" }));
    }
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    console.error(JSON.stringify({ message: "websocket error", error: String(error) }));
    socket.close(1011, "websocket error");
  }

  private getSessionMode(): SessionMode {
    return this.ctx.storage.sql
      .exec<{ mode: SessionMode }>("SELECT mode FROM session_settings WHERE id = 1")
      .one().mode;
  }

  private getParticipantRow(voterId: string): ParticipantRow | undefined {
    return this.ctx.storage.sql
      .exec<ParticipantRow>(
        `SELECT voter_id, alias, public_label, coc_version, question_state, slow_until,
                flags_agreed, flags_rejected
         FROM participants WHERE voter_id = ?`,
        voterId,
      )
      .toArray()[0];
  }

  private recordModerationAction(
    questionId: string | null,
    voterId: string | null,
    action: string,
    reason: string,
    createdAt: number,
    actor = "moderator",
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO moderation_actions
        (id, question_id, voter_id, action, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      questionId,
      voterId,
      action,
      reason,
      actor,
      createdAt,
    );
  }

  private getFlagSummary(questionId: string): { count: number; weight: number } {
    return this.ctx.storage.sql
      .exec<{ count: number; weight: number }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(weight), 0) AS weight
         FROM question_flags WHERE question_id = ? AND status = 'pending'`,
        questionId,
      )
      .one();
  }

  private flagThreshold(): number {
    if (!moderation?.enabled || !moderation.flags.enabled) return 0;
    const participants = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM participants WHERE coc_version = ?",
        moderation.codeOfConduct.version,
      )
      .one().count;
    return Math.min(
      moderation.flags.autoHoldMax,
      Math.max(
        moderation.flags.autoHoldMin,
        Math.ceil(participants * moderation.flags.autoHoldParticipantRatio),
      ),
    );
  }

  private resolveFlags(
    questionId: string,
    outcome: "agreed" | "rejected",
    resolvedAt: number,
  ): void {
    const scoreColumn = outcome === "agreed" ? "flags_agreed" : "flags_rejected";
    this.ctx.storage.sql.exec(
      `UPDATE participants SET ${scoreColumn} = ${scoreColumn} + 1
       WHERE voter_id IN (
         SELECT voter_id FROM question_flags WHERE question_id = ? AND status = 'pending'
       )`,
      questionId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE question_flags SET status = ?, resolved_at = ?
       WHERE question_id = ? AND status = 'pending'`,
      outcome,
      resolvedAt,
      questionId,
    );
  }

  private async scheduleNextPublication(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ publish_at: number }>(
        `SELECT MIN(publish_at) AS publish_at
         FROM questions
         WHERE visibility = 'pending' AND publish_at IS NOT NULL`,
      )
      .toArray()[0];
    if (next?.publish_at) await this.ctx.storage.setAlarm(next.publish_at);
    else await this.ctx.storage.deleteAlarm();
  }

  private async broadcastParticipantState(
    voterId: string,
    state?: ParticipantState,
  ): Promise<void> {
    const payload = JSON.stringify({
      type: "participant",
      data: state ?? (await this.participantState(voterId)),
    });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() as { voterId?: unknown } | null;
        if (attachment?.voterId !== voterId) continue;
        socket.send(payload);
      } catch (error) {
        console.error(JSON.stringify({ message: "participant broadcast failed", error: String(error) }));
      }
    }
  }

  private broadcastModerationActivity(): void {
    const payload = JSON.stringify({ type: "moderation-activity", data: { updatedAt: Date.now() } });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (error) {
        console.error(JSON.stringify({ message: "moderation activity broadcast failed", error: String(error) }));
      }
    }
  }

  private touch(snapshot: SessionSnapshot): SessionSnapshot {
    snapshot.updatedAt = Date.now();
    snapshot.session.mode = this.getSessionMode();
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

function shortBadge(voterId: string): string {
  return voterId.replaceAll("-", "").slice(-4).toUpperCase();
}

function statusLabel(visibility: QuestionVisibility): string {
  if (visibility === "public") return "Published";
  if (visibility === "pending") return "Waiting for review";
  return "Not public";
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

function toOwnQuestion(row: QuestionRow): OwnQuestion {
  return {
    ...toAudienceQuestion(row),
    visibility: row.visibility,
    statusLabel: statusLabel(row.visibility),
  };
}

function toModeratorQuestion(row: QuestionRow, flagThreshold: number): ModeratorQuestion {
  const flagReasons: Partial<Record<FlagReason, number>> = {};
  if (row.harassment_flags) flagReasons.harassment = row.harassment_flags;
  if (row.disruption_flags) flagReasons.disruption = row.disruption_flags;
  if (row.off_topic_flags) flagReasons.off_topic = row.off_topic_flags;
  if (row.privacy_flags) flagReasons.privacy = row.privacy_flags;
  return {
    ...toOwnQuestion(row),
    voterId: row.voter_id,
    moderationReason: row.moderation_reason,
    moderatedAt: row.moderated_at,
    flagCount: row.flag_count ?? 0,
    flagWeight: Math.round((row.flag_weight ?? 0) * 100) / 100,
    flagThreshold,
    flagReasons,
  };
}

function flagTrustWeight(agreed: number, rejected: number): number {
  if (rejected >= 3 && rejected >= agreed * 2) return 0.25;
  if (rejected > agreed) return 0.5;
  if (agreed >= 3 && rejected / (agreed + rejected) <= 0.25) return 1.5;
  return 1;
}

function toParticipantProfile(row: ParticipantRow): ParticipantProfile {
  return {
    alias: row.alias,
    publicLabel: row.public_label,
    cocVersion: row.coc_version,
    questionState: row.question_state,
    slowUntil: row.slow_until,
  };
}

function toModerationAction(row: ModerationActionRow): ModerationAction {
  return {
    id: row.id,
    questionId: row.question_id,
    voterId: row.voter_id,
    action: row.action,
    reason: row.reason,
    actor: row.actor,
    createdAt: row.created_at,
  };
}
