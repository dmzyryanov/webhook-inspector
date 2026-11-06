/**
 * The pure parts of `measure-connections.mjs` (#145, D227; Scope 5 of #244)
 * that `apps/backend/src/measure-connections.test.ts` imports. The measurement
 * itself needs Docker and runs by hand, as D227's, D228's and D244's do; only
 * the stats of Scope 5's readings, the parse of PostgreSQL's lock waits, the
 * statements that turn that log on and off (with a stand-in for `psql`, #272)
 * and the series registry are tested.
 */

/** The 50th and 99th percentiles and the largest of `values`, and their count. */
export function summarizePercentiles(values: readonly number[]): {
  count: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
};

export interface MeasuredAnswer {
  status: number;
  errorCode?: number;
  ms: number;
}

/** A set of answers tallied for the choice among #244's levers: `200`, `429` and the rest, with p50 / p99 / max. */
export function rowLockReport(answers: readonly MeasuredAnswer[]): {
  sent: number;
  ok: number;
  refused: number;
  refusedCodes?: Record<string, number>;
  other: number;
  count: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
};

/** One `row-lock` session `DELETE` sent amid captures to its session. */
export interface ThrowawayDeletion {
  inFlightAtSend: number;
  storedAfterSend: number;
  goneAfterSend: number;
  statuses: readonly number[];
}

/** The throwaway deletions tallied: how many met captures in flight, and what those captures were answered. */
export function throwawayReport(
  deletions: readonly ThrowawayDeletion[],
  capturesEach: number,
): {
  deletions: number;
  capturesEach: number;
  withCapturesInFlight: number;
  landedAmongCaptures: number;
  inFlightAtSend: number;
  storedAfterSend: number;
  goneAfterSend: number;
  captureStatuses: Record<string, number>;
};

/**
 * One group of PostgreSQL's logged lock waits: who waited, in what statement,
 * on which lock (`transaction` or `tuple`), held by whose connection
 * (`unknown` when no line names it, `null` when the wait named no holder),
 * and on which relation.
 */
export interface LockWaitGroup {
  app: string;
  statement: string | null;
  lock: string;
  heldBy: string | null;
  relation: string | null;
  count: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** PostgreSQL's lock waits between the two markers naming `token` in its log. */
export function summarizeLockWaits(text: string, token: string): LockWaitsSummary;

/** What a series' log of lock waits reads, or why it was not read. */
export type LockWaitsSummary =
  | { read: false; error: string }
  | {
      read: true;
      ended: boolean;
      loggedFromMs: number;
      waits: number;
      unfinished: number;
      deadlocks: number;
      skippedLines?: number;
      by: LockWaitGroup[];
    };

/** Sends one `psql` call's statements to PostgreSQL, in order; rejects when one fails. */
export type StatementsRun = (statements: readonly string[]) => Promise<unknown>;

/** Turns PostgreSQL's log of lock waits on for a series, and logs its first marker. */
export function startLockWaits(
  token: string,
  options?: { run?: StatementsRun; settleMs?: number },
): Promise<void>;

/**
 * Logs the second marker, then resets every setting `startLockWaits` changed
 * in a call of its own, and reads the log; rejects only when the reset fails.
 */
export function lockWaitsOf(
  token: string,
  options?: { run?: StatementsRun; readLog?: () => Promise<string> },
): Promise<LockWaitsSummary>;

/** What runs the client's series `name`, or `undefined` when the client runs none by it. */
export function clientSeries(name: string): (() => Promise<unknown>) | undefined;

/** Every series the orchestrator can run, by name. */
export const SERIES: Record<
  string,
  {
    client: string;
    env: Record<string, string>;
    probe?: boolean;
    lockWaits?: boolean;
  }
>;
