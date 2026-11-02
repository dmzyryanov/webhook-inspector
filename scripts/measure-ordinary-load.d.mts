/**
 * The pure parts of `measure-ordinary-load.mjs` (#186, D232) that
 * `apps/backend/src/measure-ordinary-load.test.ts` imports.
 */
export interface Profile {
  webhookIntervalMs: number;
  smallMinBytes: number;
  smallMaxBytes: number;
  largeBytes: number;
  largeEvery: number;
  reloadMinMs: number;
  reloadMaxMs: number;
  reloadAwaitsClose: boolean;
  ciShare: number;
  ciWebhooks: number;
  ciIntervalMs: number;
  ciWaitSeconds: number;
  ciPauseMs: number;
  lifetimeSeconds: number;
}

export const PROFILE: Readonly<Profile>;
/** Read with `profileProblems`, which takes anything a `--profile` may hold. */
export function profileProblems(profile: Record<string, unknown>): string[];
export function parseProfile(text: string): Profile;
export const SERVED_WELL: Readonly<{ captureP99Ms: number; realtimeP99Ms: number }>;
export const CLIENT_HEALTH: Readonly<{
  eventLoopP99Ms: number;
  cpuPercent: number;
  scheduleLagP99Ms: number;
}>;
export const PUBLISHED_LIMITS: Readonly<{
  creationsPerMinute: number;
  callsPerMinute: number;
  callsInFlight: number;
  realtimeConnections: number;
}>;
export const PRODUCTION_PAGE_USERS_MAX: number;

export interface Summary {
  count: number;
  median: number | null;
  p99: number | null;
  max: number | null;
}

export function percentile(sorted: number[], fraction: number): number | null;
export function summarize(values: number[]): Summary;
export function userAddress(index: number): string;

export interface PlannedUser {
  index: number;
  kind: 'page' | 'ci';
  address: string;
  startMs: number;
}

export function planUsers(pageUsers: number, ciUsers: number, rampMs: number): PlannedUser[];

export interface Step {
  label: string;
  pageUsers: number;
  ciUsers: number;
  users: number;
}

export function parseSteps(text: string, ciShare?: number): Step[];
export function random(seed: number): () => number;
export function webhookSize(
  userIndex: number,
  seq: number,
  next: () => number,
  profile?: Profile,
): number;
export function webhookBody(size: number, userIndex: number, seq: number): Buffer;
export function proxyHeader(source: string, sourcePort?: number): Buffer;

export interface HttpAnswer {
  complete: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  errorCode?: number;
}

export function parseHttpAnswer(bytes: Buffer): HttpAnswer;
export function pendingSessions(text: string): {
  pending: string[];
  created: string[];
  skipped: number;
};
export function cleanupOrigin(text: string, given: string | undefined): string;
export function nextRetryDelay(previousDelayMs: number, connectionLifetimeMs: number): number;

/** What `missedOnLiveConnection` reads of a page's connection. */
export interface PageConnection {
  readyAt: number | null;
  endedAt: number | null;
}

export function missedOnLiveConnection(
  connection: PageConnection | null,
  sentAt: number,
  answeredAt: number,
): boolean;

export function recordSession(
  file: string | undefined,
  verb: 'created' | 'deleted',
  id: string,
): void;

export interface Budget {
  perMinute: { creations: number; calls: number };
  callsInFlightAtMost: number;
  realtimeConnections: number;
  realtimeConnectionsAtMost: number;
  tlsConnectionsAbout: number;
  problems: string[];
}

export function productionBudget(options: {
  pageUsers: number;
  ciUsers: number;
  apiSockets: number;
  profile?: Profile | Record<string, unknown>;
}): Budget;

export interface Verdict {
  verdict: boolean;
  reasons: string[];
}

/** The part of a report the verdict reads. */
export interface VerdictInput {
  webhooks: { sent: number; captureMs: Summary; lost: number; sessionsNotCounted: number };
  realtime: { tracked: number; notShown: number; ms: Summary };
  errors: { total: number };
}

export function servedWell(report: VerdictInput): Verdict;

export interface WorkerRecords {
  webhooks: {
    kind: 'page' | 'ci';
    large: boolean;
    at: number;
    ms: number;
    status: number;
    errorCode?: number;
    error?: string;
  }[];
  api: {
    kind: string;
    at: number;
    ms: number;
    status: number;
    errorCode?: number;
    error?: string;
  }[];
  shown: {
    at: number;
    captureMs: number;
    eventMs: number | null;
    listedMs: number | null;
    /** The page user's index. */
    user: number;
    /** What the page was doing when the webhook's answer came. */
    state: 'ready' | 'connecting' | 'waiting' | 'reloading' | 'closed';
    /** The load that listed the row first, if one did. */
    listedBy: 'page load' | 'ready' | null;
    /** A list-only row whose event a live, ready connection never carried. */
    missed: boolean;
  }[];
  pages: PageNotes[];
  stored: {
    kind: 'page' | 'ci';
    sent: number;
    stored: number;
    answeredNotStored: number;
    countFailed: boolean;
  }[];
  ws: { opened: number; readies: number; reconnections: number; closes: Record<string, number> };
  ci: { loops: number; loopsCounted: number };
  sessions: { created: number; deleted: number; ciCreated: number; ciDeleted: number };
  rateLimitRemainingMin: { creations: number | null; calls: number | null };
  /** When each realtime connection first came `ready`, from `t0`; absent before #188. */
  readyAts?: number[];
  health: {
    users: number;
    eventLoopDelayMs: { p50: number; p99: number; max: number };
    cpuPercent: number;
    scheduleLagMs: Summary;
    rssMiB: number;
  };
}

/** One page user's realtime connections over its run. */
export interface PageNotes {
  user: number;
  connections: number;
  refusals: number;
  readies: number;
  notReadyMs: number;
}

export interface Report extends VerdictInput {
  webhooks: VerdictInput['webhooks'] & {
    statuses: Record<string, number>;
    captureMsHold: Summary;
    captureMsSmall: Summary;
    captureMsLarge: Summary;
    largeShare: number | null;
    perSecondHold: number;
    stored: number;
    answeredNotStored: number;
    sessionsCounted: number;
  };
  realtime: VerdictInput['realtime'] & {
    shownByEvent: number;
    shownByListOnly: number;
    msHold: Summary;
    eventMs: Summary;
    fromSendMs: Summary;
    listOnly: {
      count: number;
      ms: Summary;
      byStateAtCapture: Record<string, number>;
      byLoad: Record<string, number>;
      missedOnLiveConnection: number;
    };
    pages: {
      count: number;
      refused: number;
      neverReady: number;
      notReadyMs: Summary;
      longestWithoutConnection: (PageNotes & { listOnly: number })[];
    };
  };
  api: {
    calls: number;
    p99Ms: number | null;
    byKind: Record<string, { count: number; statuses: Record<string, number>; ms: Summary }>;
    rateLimitRemainingMin: { creations: number | null; calls: number | null };
  };
  ws: { opened: number; readies: number; reconnections: number; closes: Record<string, number> };
  /** What the backend did over the hold, each counted when it was done (#188). */
  units: {
    holdS: number;
    webhooksCaptured: number;
    eventsDelivered: number;
    apiAnswered: number;
    apiAnsweredByKind: Record<string, number>;
    connectionsReady: number;
  };
  ci: { loops: number; loopsCounted: number; sessionsCreated: number; sessionsDeleted: number };
  errors: { total: number; byKind: Record<string, number> };
  client: {
    workers: WorkerRecords['health'][];
    healthy: boolean;
    problems: string[];
    limits: typeof CLIENT_HEALTH;
  };
  servedWell: Verdict;
}

export function buildReport(
  raws: WorkerRecords[],
  config: { rampMs: number; holdMs: number },
): Report;

export interface StatsSample {
  at: number;
  cpuNs: number;
  periods: number;
  throttled: number;
  memory: number;
  anon: number;
}

export function summarizeSamples(
  samples: StatsSample[],
  from: number,
  to: number,
): {
  samples: number;
  samplesHold: number;
  cpuPercentHold: { mean: number | null; peak: number | null };
  throttledPercentHold: number | null;
  memoryMiB: { peak: number | null; anonPeak: number | null };
};

export function idleCpu(samples: StatsSample[]): { seconds: number; cpuPercent: number | null };
export function backendCpus(value: string | undefined): string;
export function cpuLimit(text: string): number | null;
export function captureCount(value: string | undefined): number;
export function idleSeconds(value: string | undefined): number;
export function quietSeconds(value: string | undefined): number;
export const READINESS_SCRIPT: string;
export function readinessWait(
  url?: string,
  options?: { deadlineMs?: number; intervalMs?: number },
): string[];
export function profileDirsInUse(dir: string, steps: { label: string }[]): string[];

export interface ProbeLine {
  t: number;
  loops: number;
  events: number;
}

export interface ProbeWindow {
  seconds: number;
  loops: number;
  events: number;
}

export function parseProbeLines(text: string): ProbeLine[];
export function probeWindow(lines: ProbeLine[], from: number, to: number): ProbeWindow | null;
export function profileOffset(profile: unknown, lines: ProbeLine[]): number | null;
export function moduleOf(url: string, functionName?: string): string;

export interface SelfTime {
  name: string;
  ms: number;
  percent: number | null;
}

export function summarizeCpuProfile(
  profile: unknown,
  window?: { from: number; to: number } | null,
  top?: number,
): {
  sampledMs: number;
  idleMs: number;
  busyMs: number;
  functions: SelfTime[];
  modules: SelfTime[];
};

export function holdCpu(
  profile: unknown,
  lines: ProbeLine[],
  hold: { from: number; to: number },
): ReturnType<typeof summarizeCpuProfile> | null;

export interface StatementCount {
  calls: number;
  query: string;
}

export function parseStatementCounts(text: string): StatementCount[];
export function perCapture(input: {
  count: number;
  quiet: ProbeWindow | null;
  series: ProbeWindow | null;
  statements: StatementCount[];
}): {
  captures: number;
  statements: number | null;
  byStatement: { perCapture: number | null; query: string }[];
  otherStatements: StatementCount[];
  loopTurns: number | null;
  loopEvents: number | null;
};

export function places(
  appOrigin: string,
  count?: number,
): Promise<{
  count: number;
  freeAtOnce: boolean;
  first: Record<string, number | boolean>;
  after65s?: Record<string, number | boolean>;
}>;

export function cleanup(
  file: string,
  appOrigin?: string,
): Promise<{
  pending: number;
  deleted: number;
  alreadyGone: number;
  failed: Record<string, number>;
  skipped: number;
  recorded: number;
  readAfter: Record<string, number>;
  left: number;
}>;
