/**
 * The pure part of `measure-backend-probe.mjs` (#213, D244) that
 * `apps/backend/src/measure-backend-probe.test.ts` imports.
 */

/**
 * The name a pool's readings go under: its `application_name` without the
 * `webhook-inspector-` before it, `shared` for a pool that sets none.
 */
export function poolName(options?: { application_name?: unknown } | null): string;
