import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { anonymousLabelFor } from "./anon-labels";
import { EVENT_CONFIG, QUESTION_LENSES, REACTION_KINDS, validateEventConfig } from "./config";
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
  PublicEventConfig,
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

type ReactionRow = {
  kind: string;
  created_at: number;
};

type HostedEventRow = {
  event_id: string;
  admin_hash: string;
  moderator_hash: string;
  created_at: number;
  expires_at: number;
};

type HostedDeckRow = {
  filename: string;
  media_type: string;
  size_bytes: number;
};

const maxHostedPdfBytes = 20 * 1024 * 1024;
const hostedPdfChunkBytes = 1024 * 1024;
const maxHostedPdfBytesPerDay = 400 * 1024 * 1024;

type ExportData = {
  exportedAt: number;
  config: PublicEventConfig;
  snapshot: SessionSnapshot;
  questions: QuestionRow[];
  participants: ParticipantRow[];
  questionFlags: QuestionFlagExport[];
  moderationActions: ModerationAction[];
  reactions: ReactionRow[];
};

export class LiveSession extends DurableObject<Env> {
  private snapshotCache: SessionSnapshot | null = null;
  private eventConfigCache: PublicEventConfig | null = null;
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
    if (version < 4) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE anon_labels (
          voter_id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (4, ${Date.now()});
      `);
    }
    if (version < 5) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE reactions (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_reactions_created_at ON reactions(created_at);
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (5, ${Date.now()});
      `);
    }
    if (version < 6) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE event_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          config_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (6, ${Date.now()});
      `);
    }
    if (version < 7) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE hosted_event (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          event_id TEXT NOT NULL UNIQUE,
          admin_hash TEXT NOT NULL,
          moderator_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE hosted_creation_limits (
          bucket TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (7, ${Date.now()});
      `);
    }
    if (version < 8) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE hosted_deck (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          filename TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL
        );
        CREATE TABLE hosted_deck_chunks (
          chunk_index INTEGER PRIMARY KEY,
          data BLOB NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (8, ${Date.now()});
      `);
    }
  }

  eventConfig(): PublicEventConfig {
    return this.getEventConfig();
  }

  isHostedEvent(): boolean {
    const hosted = this.getHostedEvent();
    return Boolean(hosted && hosted.expires_at > Date.now());
  }

  async initializeHostedEvent(
    configValue: unknown,
    adminHash: string,
    moderatorHash: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<PublicEventConfig> {
    const config = validateEventConfig(configValue);
    if (!/^[a-f0-9]{32}$/.test(config.eventId)) throw new Error("invalid hosted event id");
    if (!/^[a-f0-9]{64}$/.test(adminHash) || !/^[a-f0-9]{64}$/.test(moderatorHash)) {
      throw new Error("invalid hosted event access");
    }
    if (!Number.isInteger(createdAt) || !Number.isInteger(expiresAt) || expiresAt <= createdAt) {
      throw new Error("invalid hosted event lifetime");
    }
    if (this.getHostedEvent()) throw new Error("hosted event already exists");
    this.ctx.storage.sql.exec(
      `INSERT INTO hosted_event
        (id, event_id, admin_hash, moderator_hash, created_at, expires_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      config.eventId,
      adminHash,
      moderatorHash,
      createdAt,
      expiresAt,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO event_config (id, config_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE
       SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      JSON.stringify(config),
      createdAt,
    );
    this.eventConfigCache = config;
    await this.ctx.storage.setAlarm(expiresAt);
    return config;
  }

  async isHostedAuthorized(role: "admin" | "moderator", token: string): Promise<boolean> {
    if (token.length < 24 || token.length > 256) return false;
    const hosted = this.getHostedEvent();
    if (!hosted || hosted.expires_at <= Date.now()) return false;
    const expectedHash = role === "admin" ? hosted.admin_hash : hosted.moderator_hash;
    const actual = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    return timingSafeEqual(actual, hexToBytes(expectedHash));
  }

  reserveHostedEvent(
    createdAt: number,
    uploadBytes = 0,
  ): { minuteCount: number; dayCount: number; uploadBytes: number } {
    if (!Number.isInteger(createdAt)) throw new Error("invalid creation time");
    if (!Number.isInteger(uploadBytes) || uploadBytes < 0 || uploadBytes > maxHostedPdfBytes) {
      throw new Error("PDF is too large (20 MB maximum)");
    }
    const minuteBucket = `minute:${Math.floor(createdAt / 60_000)}`;
    const dayBucket = `day:${new Date(createdAt).toISOString().slice(0, 10)}`;
    const uploadBucket = `pdf-bytes:${new Date(createdAt).toISOString().slice(0, 10)}`;
    const minuteCount = this.creationCount(minuteBucket);
    const dayCount = this.creationCount(dayBucket);
    const uploadedToday = this.creationCount(uploadBucket);
    if (minuteCount >= 6 || dayCount >= 100) throw new Error("hosted event creation limit reached");
    if (uploadedToday + uploadBytes > maxHostedPdfBytesPerDay) {
      throw new Error("PDF upload limit reached for today");
    }
    this.incrementCreationCount(minuteBucket, createdAt);
    this.incrementCreationCount(dayBucket, createdAt);
    if (uploadBytes) this.incrementCreationCount(uploadBucket, createdAt, uploadBytes);
    this.ctx.storage.sql.exec(
      "DELETE FROM hosted_creation_limits WHERE updated_at < ?",
      createdAt - 2 * 24 * 60 * 60 * 1000,
    );
    return {
      minuteCount: minuteCount + 1,
      dayCount: dayCount + 1,
      uploadBytes: uploadedToday + uploadBytes,
    };
  }

  async deleteHostedEvent(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, "event deleted");
    this.clearHostedEventData();
    await this.ctx.storage.deleteAlarm();
  }

  async updateEventConfig(value: unknown): Promise<{ config: PublicEventConfig; updatedAt: number }> {
    const config = validateEventConfig(value);
    const expectedEventId = this.getHostedEvent()?.event_id ?? EVENT_CONFIG.eventId;
    if (config.eventId !== expectedEventId) {
      throw new Error("eventId cannot change after deployment");
    }
    const updatedAt = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO event_config (id, config_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE
       SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      JSON.stringify(config),
      updatedAt,
    );
    this.eventConfigCache = config;
    this.snapshotCache = null;
    await this.broadcastSnapshot();
    return { config, updatedAt };
  }

  async ensureDemoSession(
    value: unknown,
    now: number,
    resetAt: number,
    seedVersion: string,
  ): Promise<{ resetAt: number }> {
    const config = validateEventConfig(value);
    if (config.eventId !== EVENT_CONFIG.eventId) throw new Error("invalid demo eventId");
    if (
      !Number.isInteger(now) ||
      !Number.isInteger(resetAt) ||
      resetAt <= now ||
      resetAt > now + 2 * 24 * 60 * 60 * 1000
    ) {
      throw new Error("invalid demo reset time");
    }
    if (!/^[a-z0-9-]{4,64}$/i.test(seedVersion)) throw new Error("invalid demo seed version");

    const current = this.getEventConfig();
    if (JSON.stringify(current) !== JSON.stringify(config)) await this.updateEventConfig(config);

    const storedResetAt = await this.ctx.storage.get<number>("demoResetAt");
    const storedSeedVersion = await this.ctx.storage.get<string>("demoSeedVersion");
    if (!storedResetAt || storedResetAt <= now || storedSeedVersion !== seedVersion) {
      await this.reset();
      await this.seedDemoBaseline(config, now);
      await this.ctx.storage.put("demoResetAt", resetAt);
      await this.ctx.storage.put("demoSeedVersion", seedVersion);
      await this.scheduleNextAlarm();
      return { resetAt };
    }
    return { resetAt: storedResetAt };
  }

  private async seedDemoBaseline(config: PublicEventConfig, now: number): Promise<void> {
    const difficultyCounts = [2, 5, 29, 7, 2];
    let difficultyIndex = 0;
    for (let score = 1; score <= difficultyCounts.length; score += 1) {
      for (let count = 0; count < (difficultyCounts[score - 1] ?? 0); count += 1) {
        this.ctx.storage.sql.exec(
          "INSERT INTO difficulty_votes (voter_id, score, updated_at) VALUES (?, ?, ?)",
          crypto.randomUUID(),
          score,
          now - (45 - difficultyIndex) * 13_000,
        );
        difficultyIndex += 1;
      }
    }

    const english = config.locale.toLowerCase().startsWith("en");
    const questions: Array<{
      text: string;
      lens: QuestionLens;
      difficulty: number;
      upvotes: number;
    }> = english
      ? [
          { text: "Does the audience need to install an app to join from a phone?", lens: "clarify", difficulty: 2, upvotes: 8 },
          { text: "Will the PDF and audience responses both disappear after seven days?", lens: "keeper", difficulty: 3, upvotes: 6 },
          { text: "Can I hand the moderator link to another person on the event team?", lens: "clarify", difficulty: 3, upvotes: 5 },
          { text: "What happens to responses when the venue connection is unstable?", lens: "keeper", difficulty: 4, upvotes: 4 },
          { text: "Would this also work for a classroom or an in-person workshop?", lens: "bridge", difficulty: 2, upvotes: 7 },
          { text: "Can audience members ask questions without showing their real names?", lens: "chorus", difficulty: 3, upvotes: 5 },
        ]
      : [
          { text: "觀眾只用手機加入時，需要另外安裝 App 嗎？", lens: "clarify", difficulty: 2, upvotes: 8 },
          { text: "PDF 與觀眾回應會在七天後一起刪除嗎？", lens: "keeper", difficulty: 3, upvotes: 6 },
          { text: "可以把主持私密連結交給活動團隊的另一個人嗎？", lens: "clarify", difficulty: 3, upvotes: 5 },
          { text: "現場網路不穩時，觀眾送出的回應會怎麼處理？", lens: "keeper", difficulty: 4, upvotes: 4 },
          { text: "除了線上演講，也適合實體教室或工作坊嗎？", lens: "bridge", difficulty: 2, upvotes: 7 },
          { text: "觀眾可以不用真名、以活動暱稱提問嗎？", lens: "chorus", difficulty: 3, upvotes: 5 },
        ];

    questions.forEach((question, index) => {
      const questionId = crypto.randomUUID();
      const voterId = crypto.randomUUID();
      const createdAt = now - (questions.length - index) * 4 * 60_000;
      const nickname = english ? `Demo guest #${index + 1}` : `示範聽眾 #${index + 1}`;
      this.ctx.storage.sql.exec(
        `INSERT INTO questions
          (id, voter_id, text, nickname, lens, difficulty, created_at, visibility,
           publish_at, moderation_reason, moderated_at, moderated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'public', NULL, NULL, NULL, NULL)`,
        questionId,
        voterId,
        question.text,
        nickname,
        question.lens,
        question.difficulty,
        createdAt,
      );
      for (let vote = 0; vote < question.upvotes; vote += 1) {
        this.ctx.storage.sql.exec(
          "INSERT INTO question_votes (question_id, voter_id, created_at) VALUES (?, ?, ?)",
          questionId,
          crypto.randomUUID(),
          createdAt + vote * 1_000,
        );
      }
    });

    this.snapshotCache = null;
    await this.broadcastSnapshot(await this.snapshot());
  }

  async snapshot(): Promise<SessionSnapshot> {
    if (this.snapshotCache) return this.snapshotCache;

    const config = this.getEventConfig();
    const polls = config.polls.map((poll) => {
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
    const moderation = this.getEventConfig().moderation;
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
    const poll = this.getEventConfig().polls.find((candidate) => candidate.id === pollId);
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

  anonymousLabel(voterId: string): string {
    assertVoterId(voterId);
    const existing = this.ctx.storage.sql
      .exec<{ label: string }>("SELECT label FROM anon_labels WHERE voter_id = ?", voterId)
      .toArray()[0];
    if (existing) return existing.label;
    const assigned = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM anon_labels")
      .one().count;
    const label = anonymousLabelFor(assigned);
    this.ctx.storage.sql.exec(
      "INSERT INTO anon_labels (voter_id, label, created_at) VALUES (?, ?, ?)",
      voterId,
      label,
      Date.now(),
    );
    return label;
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
    const config = this.getEventConfig();
    const moderation = config.moderation;

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
    if (prior.count >= config.question.maxPerDevice) {
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
    const publicLabel = participant?.public_label ?? (cleanText(nickname, 24) || this.anonymousLabel(voterId));
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
    if (publishAt) await this.scheduleNextAlarm();
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
    const questionRow = this.ctx.storage.sql
      .exec<{ voter_id: string }>(
        "SELECT voter_id FROM questions WHERE id = ? AND visibility = 'public'",
        questionId,
      )
      .toArray()[0];
    if (!questionRow) throw new Error("question not found");
    if (questionRow.voter_id === voterId) throw new Error("cannot upvote your own question");
    const priorVote = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM question_votes WHERE question_id = ? AND voter_id = ?",
        questionId,
        voterId,
      )
      .one();
    const question = snapshot.questions.find((candidate) => candidate.id === questionId);
    if (priorVote.count === 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO question_votes (question_id, voter_id, created_at) VALUES (?, ?, ?)",
        questionId,
        voterId,
        Date.now(),
      );
      if (question) question.upvotes += 1;
    } else {
      this.ctx.storage.sql.exec(
        "DELETE FROM question_votes WHERE question_id = ? AND voter_id = ?",
        questionId,
        voterId,
      );
      if (question) question.upvotes = Math.max(0, question.upvotes - 1);
    }
    return this.broadcastSnapshot(this.touch(snapshot));
  }

  async flagQuestion(
    questionId: string,
    reason: FlagReason,
    voterId: string,
  ): Promise<{ ok: true; held: boolean }> {
    assertVoterId(voterId);
    const moderation = this.getEventConfig().moderation;
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
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO reactions (id, kind, created_at) VALUES (?, ?, ?)",
      id,
      kind,
      now,
    );
    const payload = JSON.stringify({
      type: "reaction",
      data: { id, kind, createdAt: now },
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
    this.ctx.storage.sql.exec("DELETE FROM reactions");
    this.ctx.storage.sql.exec("DELETE FROM anon_labels");
    this.ctx.storage.sql.exec("DELETE FROM difficulty_votes");
    this.ctx.storage.sql.exec("DELETE FROM votes");
    this.ctx.storage.sql.exec(
      "UPDATE session_settings SET mode = 'open', updated_at = ? WHERE id = 1",
      Date.now(),
    );
    await this.ctx.storage.deleteAlarm();
    this.reactionWindows.clear();
    this.snapshotCache = null;
    const snapshot = await this.broadcastSnapshot(await this.snapshot());
    const participantReset = JSON.stringify({
      type: "participant",
      data: { participant: null, questions: [] },
    });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() as { voterId?: unknown } | null;
        if (typeof attachment?.voterId === "string") socket.send(participantReset);
      } catch (error) {
        console.error(JSON.stringify({ message: "participant reset broadcast failed", error: String(error) }));
      }
    }
    await this.scheduleNextAlarm();
    return snapshot;
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
    const reactions = this.ctx.storage.sql
      .exec<ReactionRow>("SELECT kind, created_at FROM reactions ORDER BY created_at")
      .toArray();
    return {
      exportedAt: Date.now(),
      config: this.getEventConfig(),
      snapshot: await this.snapshot(),
      questions,
      participants,
      questionFlags,
      moderationActions,
      reactions,
    };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const demoResetAt = await this.ctx.storage.get<number>("demoResetAt");
    if (demoResetAt && demoResetAt <= now) {
      const config = this.getEventConfig();
      await this.reset();
      await this.seedDemoBaseline(config, now);
      await this.ctx.storage.put("demoResetAt", nextTaipeiMidnight(now));
      await this.scheduleNextAlarm();
      return;
    }
    const hosted = this.getHostedEvent();
    if (hosted && hosted.expires_at <= now) {
      for (const socket of this.ctx.getWebSockets()) socket.close(1001, "event expired");
      this.clearHostedEventData();
      await this.ctx.storage.deleteAlarm();
      return;
    }
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
    await this.scheduleNextAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/deck") {
      if (!this.isHostedEvent()) return new Response("Event not found", { status: 404 });
      if (request.method === "PUT") return this.storeHostedDeck(request, url);
      if (request.method === "GET") return this.readHostedDeck();
      return new Response("Method not allowed", { status: 405 });
    }
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

  private getEventConfig(): PublicEventConfig {
    if (this.eventConfigCache) return this.eventConfigCache;
    const row = this.ctx.storage.sql
      .exec<{ config_json: string }>("SELECT config_json FROM event_config WHERE id = 1")
      .toArray()[0];
    this.eventConfigCache = row ? validateEventConfig(JSON.parse(row.config_json)) : EVENT_CONFIG;
    return this.eventConfigCache;
  }

  private getHostedEvent(): HostedEventRow | undefined {
    return this.ctx.storage.sql
      .exec<HostedEventRow>(
        `SELECT event_id, admin_hash, moderator_hash, created_at, expires_at
         FROM hosted_event WHERE id = 1`,
      )
      .toArray()[0];
  }

  private async storeHostedDeck(request: Request, url: URL): Promise<Response> {
    const declaredSize = Number(request.headers.get("Content-Length") || "0");
    if (!Number.isInteger(declaredSize) || declaredSize < 1 || declaredSize > maxHostedPdfBytes) {
      return new Response("PDF is too large (20 MB maximum)", { status: 413 });
    }
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength !== declaredSize || buffer.byteLength > maxHostedPdfBytes) {
      return new Response("PDF is too large (20 MB maximum)", { status: 413 });
    }
    const bytes = new Uint8Array(buffer);
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      return new Response("File is not a valid PDF", { status: 415 });
    }
    const filename = cleanHostedFilename(url.searchParams.get("filename") || "slides.pdf");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM hosted_deck_chunks");
      this.ctx.storage.sql.exec("DELETE FROM hosted_deck");
      this.ctx.storage.sql.exec(
        "INSERT INTO hosted_deck (id, filename, media_type, size_bytes) VALUES (1, ?, 'application/pdf', ?)",
        filename,
        bytes.byteLength,
      );
      for (let offset = 0, index = 0; offset < bytes.byteLength; offset += hostedPdfChunkBytes, index += 1) {
        const chunk = bytes.slice(offset, offset + hostedPdfChunkBytes);
        this.ctx.storage.sql.exec(
          "INSERT INTO hosted_deck_chunks (chunk_index, data) VALUES (?, ?)",
          index,
          chunk.buffer,
        );
      }
    });
    return Response.json({ stored: true, size: bytes.byteLength });
  }

  private readHostedDeck(): Response {
    const deck = this.ctx.storage.sql
      .exec<HostedDeckRow>("SELECT filename, media_type, size_bytes FROM hosted_deck WHERE id = 1")
      .toArray()[0];
    if (!deck) return new Response("Deck not found", { status: 404 });
    const chunks = this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM hosted_deck_chunks ORDER BY chunk_index")
      .toArray();
    const body = new Uint8Array(deck.size_bytes);
    let offset = 0;
    for (const row of chunks) {
      const chunk = new Uint8Array(row.data);
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== deck.size_bytes) return new Response("Deck storage is incomplete", { status: 500 });
    return new Response(body, {
      headers: {
        "Content-Type": deck.media_type,
        "Content-Length": String(deck.size_bytes),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(deck.filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  private clearHostedEventData(): void {
    this.ctx.storage.sql.exec("DELETE FROM hosted_deck_chunks");
    this.ctx.storage.sql.exec("DELETE FROM hosted_deck");
    this.ctx.storage.sql.exec("DELETE FROM moderation_actions");
    this.ctx.storage.sql.exec("DELETE FROM question_flags");
    this.ctx.storage.sql.exec("DELETE FROM question_votes");
    this.ctx.storage.sql.exec("DELETE FROM questions");
    this.ctx.storage.sql.exec("DELETE FROM participants");
    this.ctx.storage.sql.exec("DELETE FROM reactions");
    this.ctx.storage.sql.exec("DELETE FROM anon_labels");
    this.ctx.storage.sql.exec("DELETE FROM difficulty_votes");
    this.ctx.storage.sql.exec("DELETE FROM votes");
    this.ctx.storage.sql.exec("DELETE FROM event_config");
    this.ctx.storage.sql.exec("DELETE FROM hosted_event");
    this.eventConfigCache = null;
    this.snapshotCache = null;
    this.reactionWindows.clear();
  }

  private creationCount(bucket: string): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT count FROM hosted_creation_limits WHERE bucket = ?",
        bucket,
      )
      .toArray()[0]?.count ?? 0;
  }

  private incrementCreationCount(bucket: string, updatedAt: number, amount = 1): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO hosted_creation_limits (bucket, count, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (bucket) DO UPDATE
       SET count = count + excluded.count, updated_at = excluded.updated_at`,
      bucket,
      amount,
      updatedAt,
    );
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
    const moderation = this.getEventConfig().moderation;
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

  private async scheduleNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ publish_at: number }>(
        `SELECT MIN(publish_at) AS publish_at
         FROM questions
         WHERE visibility = 'pending' AND publish_at IS NOT NULL`,
      )
      .toArray()[0];
    const expiry = this.getHostedEvent()?.expires_at;
    const demoResetAt = await this.ctx.storage.get<number>("demoResetAt");
    const timestamps = [next?.publish_at, expiry, demoResetAt].filter(
      (value): value is number => typeof value === "number" && value > Date.now(),
    );
    if (timestamps.length) await this.ctx.storage.setAlarm(Math.min(...timestamps));
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

function nextTaipeiMidnight(now: number): number {
  const taipeiOffsetMs = 8 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  return (Math.floor((now + taipeiOffsetMs) / dayMs) + 1) * dayMs - taipeiOffsetMs;
}

function shortBadge(voterId: string): string {
  return voterId.replaceAll("-", "").slice(-4).toUpperCase();
}

function cleanHostedFilename(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "-")
    .trim()
    .slice(0, 180);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned || "slides"}.pdf`;
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
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
