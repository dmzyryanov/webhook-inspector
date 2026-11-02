/**
 * The pure parts of `measure-header-queries.mjs` (#130, D250) that
 * `apps/backend/src/measure-header-queries.test.ts` imports.
 */
export const BOUNDS: Readonly<{
  captureP95Ms: number;
  captureMaxMs: number;
  readyMaxMs: number;
  backendMemoryMiB: number;
}>;

export interface Timings {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function timings(values: number[]): Timings;

export function neverMatching(shape: 'a' | 'b'): { name: string; value: string }[];

export interface Phase {
  captures: { sent: number; outcomes: Record<string, number>; stored: number; ms: Timings };
  ready: { outcomes: Record<string, number>; ms: Timings };
}

export interface BackendReading {
  restartCount: number;
  startedAt: string;
  oomKilled: boolean;
  status: string;
  memoryPeakMiB?: number;
  vmHwmMiB?: number;
  vmRssMiB?: number;
}

export function phaseFailures(
  phase: Phase,
  before: BackendReading,
  after: BackendReading,
): string[];
