/**
 * The pure parts of `scripts/measure-connections.mjs` (#145, D227) that
 * Scope 5 of #244 (D244 point 7) added: the bystander reads' p50 / p99 / max
 * (`summarizePercentiles`), the tally that reports how many of another
 * address's reads were refused (`rowLockReport`), the tally of `row-lock`'s
 * session deletions sent amid captures (`throwawayReport`), the parse of
 * PostgreSQL's log of lock waits (`summarizeLockWaits`, hostile and growing
 * inputs included), the statements that turn that log on and every setting
 * back off, a failed marker or not (`startLockWaits`, `lockWaitsOf`, with a
 * stand-in for `psql`, #272), and that every registered series is one the
 * client runs (`SERIES`, `clientSeries`). The measurement itself needs Docker and runs by
 * hand on the operator's machine, as D227's, D228's and D244's do; importing
 * the script must not start it, and running it through a symbolic link
 * must, which its `isMain` guard ensures.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SERIES,
  clientSeries,
  lockWaitsOf,
  rowLockReport,
  startLockWaits,
  summarizeLockWaits,
  summarizePercentiles,
  throwawayReport,
} from '../../../scripts/measure-connections.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/measure-connections.mjs', import.meta.url));

describe('summarizePercentiles', () => {
  it('reports the 50th, 99th and largest and the count', () => {
    assert.deepEqual(summarizePercentiles([5, 1, 3, 9, 2, 100]), {
      count: 6,
      p50Ms: 3,
      p99Ms: 100,
      maxMs: 100,
    });
  });

  it('is all zeroes for no values, and ignores a non-finite one', () => {
    assert.deepEqual(summarizePercentiles([]), { count: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 });
    assert.deepEqual(summarizePercentiles([Number.NaN, 10, Number.POSITIVE_INFINITY]), {
      count: 1,
      p50Ms: 10,
      p99Ms: 10,
      maxMs: 10,
    });
  });

  it('rounds to the millisecond and the 99th never exceeds the max', () => {
    const summary = summarizePercentiles([1.4, 2.6, 999.5]);
    assert.equal(summary.p50Ms, 3);
    assert.ok(summary.p99Ms <= summary.maxMs);
    assert.equal(summary.maxMs, 1000);
  });
});

describe('rowLockReport', () => {
  it('counts any 2xx as ok (a read 200, a DELETE 204), the 429s and the rest', () => {
    const report = rowLockReport([
      { status: 200, ms: 10 },
      { status: 204, ms: 20 },
      { status: 404, ms: 5 },
      { status: 429, errorCode: 1012, ms: 3 },
      { status: 0, ms: 60_000 },
    ]);
    assert.equal(report.sent, 5);
    assert.equal(report.ok, 2);
    assert.equal(report.refused, 1);
    assert.deepEqual(report.refusedCodes, { 1012: 1 });
    // A 404 (a request already gone) and a status-0 timeout are neither.
    assert.equal(report.other, 2);
    assert.equal(report.maxMs, 60_000);
  });

  it('leaves refusedCodes out when nothing was refused', () => {
    const report = rowLockReport([
      { status: 200, ms: 1 },
      { status: 200, ms: 2 },
    ]);
    assert.equal(report.refused, 0);
    assert.equal(report.other, 0);
    assert.ok(!('refusedCodes' in report));
  });

  it('is empty-safe', () => {
    const report = rowLockReport([]);
    assert.deepEqual(
      { sent: report.sent, ok: report.ok, refused: report.refused, other: report.other },
      { sent: 0, ok: 0, refused: 0, other: 0 },
    );
  });
});

describe('the series registry', () => {
  it('registers the three Scope 5 series, the first two logging lock waits', () => {
    assert.equal(SERIES['row-lock']?.client, 'row-lock');
    assert.equal(SERIES['row-lock-refused']?.client, 'row-lock-refused');
    assert.equal(SERIES['row-lock-control']?.client, 'row-lock-control');
    assert.equal(SERIES['row-lock']?.lockWaits, true);
    assert.equal(SERIES['row-lock-refused']?.lockWaits, true);
    assert.notEqual(SERIES['row-lock-control']?.lockWaits, true);
  });

  it('names for every series a client the client runs', () => {
    for (const [name, series] of Object.entries(SERIES)) {
      assert.equal(typeof clientSeries(series.client), 'function', `${name}: ${series.client}`);
    }
  });

  it('runs no client by an unknown name, a bare prefix or a prefix inside a name', () => {
    for (const name of ['', 'row-lock-', 'hostile:', 'abandon:', 'xhostile:s1', 'constructor']) {
      assert.equal(clientSeries(name), undefined, name);
    }
  });
});

describe('throwawayReport', () => {
  it('tallies the deletions that met captures in flight and what those captures were answered', () => {
    const report = throwawayReport(
      [
        // Sent with 6 of 10 in flight: 2 of them stored, 4 found the session gone.
        {
          inFlightAtSend: 6,
          storedAfterSend: 2,
          goneAfterSend: 4,
          statuses: [200, 200, 200, 200, 200, 200, 404, 404, 404, 404],
        },
        // Sent with 3 in flight, every one stored: not among the captures.
        {
          inFlightAtSend: 3,
          storedAfterSend: 3,
          goneAfterSend: 0,
          statuses: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
        },
        // Sent once every capture had answered.
        { inFlightAtSend: 0, storedAfterSend: 0, goneAfterSend: 0, statuses: Array(10).fill(200) },
      ],
      10,
    );

    assert.deepEqual(report, {
      deletions: 3,
      capturesEach: 10,
      withCapturesInFlight: 2,
      landedAmongCaptures: 1,
      inFlightAtSend: 9,
      storedAfterSend: 5,
      goneAfterSend: 4,
      captureStatuses: { 200: 26, 404: 4 },
    });
  });

  it('is empty-safe', () => {
    assert.deepEqual(throwawayReport([], 10), {
      deletions: 0,
      capturesEach: 10,
      withCapturesInFlight: 0,
      landedAmongCaptures: 0,
      inFlightAtSend: 0,
      storedAfterSend: 0,
      goneAfterSend: 0,
      captureStatuses: {},
    });
  });
});

const TOKEN = 'row-lock-1792800000000';
const AT = '2026-10-23 18:00:00.000 UTC';
const DELETE_LOCK = 'SELECT id, access_key_hash FROM sessions WHERE id = $1 FOR UPDATE';
const CAPTURE_LOCK = [
  'SELECT id, response_status, response_headers, response_body,',
  '\t              response_queue -> response_queue_answered AS queue_step,',
  '\t       FROM sessions WHERE id = $1 FOR UPDATE',
];

/** A line of PostgreSQL's log under the series' prefix. */
function logLine(pid: number, app: string, level: string, message: string): string {
  return `${AT} [${pid}] app=${app} ${level}:  ${message}`;
}

/**
 * The lines PostgreSQL logs for one wait that ended with the lock, as the
 * series' runs logged them: for the transaction holding the row, with the
 * relation in its `CONTEXT`, or for the tuple behind another waiter, with none.
 */
function waitLines(
  pid: number,
  app: string,
  ms: number,
  statement: string[],
  { holder = 89, lock = 'transaction', relation = 'sessions' } = {},
): string[] {
  const what =
    lock === 'transaction'
      ? 'ShareLock on transaction 1529'
      : 'AccessExclusiveLock on tuple (0,1) of relation 16393 of database 16384';
  const context =
    lock === 'transaction'
      ? [logLine(pid, app, 'CONTEXT', `while locking tuple (0,1) in relation "${relation}"`)]
      : [];
  const statementLines = [
    logLine(pid, app, 'STATEMENT', statement[0] ?? ''),
    ...statement.slice(1),
  ];

  return [
    logLine(pid, app, 'LOG', `process ${pid} still waiting for ${what} after 1.378 ms`),
    logLine(pid, app, 'DETAIL', `Process holding the lock: ${holder}. Wait queue: ${pid}.`),
    ...context,
    ...statementLines,
    logLine(pid, app, 'LOG', `process ${pid} acquired ${what} after ${ms} ms`),
    ...context,
    ...statementLines,
  ];
}

/** A marker line, and the connections it lists. */
function marker(mark: string, connections: [number, string][] = []): string[] {
  return [
    logLine(60, 'psql', 'LOG', mark),
    ...connections.map(([pid, app]) =>
      logLine(60, 'psql', 'LOG', `qa-measure connection ${pid} app=${app}`),
    ),
    logLine(60, 'psql', 'CONTEXT', 'PL/pgSQL function inline_code_block line 1 at RAISE'),
    logLine(60, 'psql', 'STATEMENT', `DO $$BEGIN RAISE LOG '${mark}'; END$$`),
  ];
}

const FROM = marker(`qa-measure lock waits from ${TOKEN}`, [
  [89, 'webhook-inspector-capture'],
  [60, 'psql'],
]);
const TO = marker(`qa-measure lock waits to ${TOKEN}`);

describe('summarizeLockWaits', () => {
  it('groups the waits between the markers by who waited, on what, held by whom', () => {
    const log = [
      // Before the series: not counted.
      ...waitLines(10, 'webhook-inspector-api', 999, [DELETE_LOCK]),
      ...FROM,
      // A connection opened during the series, named by `log_connections`.
      logLine(
        13,
        '',
        'LOG',
        'connection authorized: user=webhook_inspector database=webhook_inspector application_name=webhook-inspector-capture',
      ),
      ...waitLines(11, 'webhook-inspector-api', 12.5, [DELETE_LOCK]),
      ...waitLines(12, 'webhook-inspector-api', 40.25, [DELETE_LOCK]),
      ...waitLines(12, 'webhook-inspector-api', 3.5, [DELETE_LOCK], { holder: 11, lock: 'tuple' }),
      ...waitLines(13, 'webhook-inspector-capture', 3.1, CAPTURE_LOCK, { holder: 11 }),
      ...waitLines(14, 'webhook-inspector-api', 2, ['DELETE FROM requests WHERE id = $1'], {
        holder: 7,
        relation: 'requests',
      }),
      ...TO,
      // After the series: not counted.
      ...waitLines(15, 'webhook-inspector-api', 999, [DELETE_LOCK]),
    ].join('\n');

    assert.deepEqual(summarizeLockWaits(log, TOKEN), {
      read: true,
      ended: true,
      loggedFromMs: 1,
      waits: 5,
      unfinished: 0,
      deadlocks: 0,
      by: [
        {
          app: 'webhook-inspector-api',
          statement: DELETE_LOCK,
          lock: 'transaction',
          heldBy: 'webhook-inspector-capture',
          relation: 'sessions',
          count: 2,
          p50Ms: 13,
          p99Ms: 40,
          maxMs: 40,
        },
        {
          app: 'webhook-inspector-api',
          statement: DELETE_LOCK,
          lock: 'tuple',
          heldBy: 'webhook-inspector-api',
          relation: null,
          count: 1,
          p50Ms: 4,
          p99Ms: 4,
          maxMs: 4,
        },
        {
          app: 'webhook-inspector-capture',
          statement: 'SELECT id, response_status, response_headers, response_body,',
          lock: 'transaction',
          heldBy: 'webhook-inspector-api',
          relation: 'sessions',
          count: 1,
          p50Ms: 3,
          p99Ms: 3,
          maxMs: 3,
        },
        {
          app: 'webhook-inspector-api',
          statement: 'DELETE FROM requests WHERE id = $1',
          lock: 'transaction',
          heldBy: 'unknown',
          relation: 'requests',
          count: 1,
          p50Ms: 2,
          p99Ms: 2,
          maxMs: 2,
        },
      ],
    });
  });

  it('keeps each process apart when their lines interleave', () => {
    const first = waitLines(21, 'webhook-inspector-api', 5, [DELETE_LOCK]);
    const second = waitLines(22, 'webhook-inspector-capture', 7, CAPTURE_LOCK, { holder: 21 });
    const interleaved: string[] = [];

    for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
      interleaved.push(...[first[index], second[index]].filter((line) => line !== undefined));
    }

    const summary = summarizeLockWaits([...FROM, ...interleaved, ...TO].join('\n'), TOKEN);

    assert.ok(summary.read);
    assert.equal(summary.waits, 2);
    assert.deepEqual(
      summary.by.map((group) => [group.app, group.heldBy, group.relation, group.maxMs]).sort(),
      [
        ['webhook-inspector-api', 'webhook-inspector-capture', 'sessions', 5],
        ['webhook-inspector-capture', 'webhook-inspector-api', 'sessions', 7],
      ],
    );
  });

  it('names the first of several holders, and none for a wait whose holder is not given', () => {
    const several = waitLines(71, 'webhook-inspector-api', 9, [DELETE_LOCK]).map((line) =>
      line.includes('DETAIL')
        ? logLine(
            71,
            'webhook-inspector-api',
            'DETAIL',
            'Processes holding the lock: 89, 90. Wait queue: 71.',
          )
        : line,
    );
    const none = waitLines(72, 'webhook-inspector-api', 4, [DELETE_LOCK]).filter(
      (line) => !line.includes('DETAIL'),
    );
    const summary = summarizeLockWaits([...FROM, ...several, ...none, ...TO].join('\n'), TOKEN);

    assert.ok(summary.read);
    assert.deepEqual(
      summary.by.map((group) => [group.heldBy, group.maxMs]),
      [
        ['webhook-inspector-capture', 9],
        [null, 4],
      ],
    );
  });

  it('counts a wait never acquired as unfinished, and deadlocks', () => {
    const log = [
      ...FROM,
      logLine(
        31,
        'webhook-inspector-api',
        'LOG',
        'process 31 still waiting for ShareLock on transaction 5 after 1.001 ms',
      ),
      logLine(31, 'webhook-inspector-api', 'STATEMENT', DELETE_LOCK),
      logLine(32, 'webhook-inspector-capture', 'ERROR', 'deadlock detected'),
      logLine(
        32,
        'webhook-inspector-capture',
        'DETAIL',
        'Process 32 waits for ShareLock on transaction 6',
      ),
      ...TO,
    ].join('\n');

    assert.deepEqual(summarizeLockWaits(log, TOKEN), {
      read: true,
      ended: true,
      loggedFromMs: 1,
      waits: 0,
      unfinished: 1,
      deadlocks: 1,
      by: [],
    });
  });

  it('is not read without its first marker, and not ended without its second', () => {
    const waits = waitLines(41, 'webhook-inspector-api', 5, [DELETE_LOCK]);

    assert.deepEqual(summarizeLockWaits(waits.join('\n'), TOKEN), {
      read: false,
      error: 'no marker',
    });
    // Another series' marker, its token this one's with a digit more.
    assert.equal(
      summarizeLockWaits(marker(`qa-measure lock waits from ${TOKEN}0`).join('\n'), TOKEN).read,
      false,
    );

    const open = summarizeLockWaits([...FROM, ...waits].join('\n'), TOKEN);

    assert.ok(open.read);
    assert.equal(open.ended, false);
    assert.equal(open.waits, 1);
  });

  it('reads no wait from lines that only resemble one', () => {
    const log = [
      ...FROM,
      // The message at another level, a wait with no duration, a message in
      // the middle of a line, a pid of eleven digits, no prefix at all.
      logLine(
        51,
        'webhook-inspector-api',
        'DETAIL',
        'process 51 acquired ShareLock on transaction 1 after 5 ms',
      ),
      logLine(52, 'webhook-inspector-api', 'LOG', 'process 52 acquired ShareLock on transaction 1'),
      logLine(
        53,
        'webhook-inspector-api',
        'LOG',
        'x process 53 acquired ShareLock on transaction 1 after 5 ms',
      ),
      `${AT} [12345678901] app=webhook-inspector-api LOG:  process 1 acquired X on transaction after 5 ms`,
      'process 55 acquired ShareLock on transaction 1 after 5 ms',
      '',
      // A whole prefix in the middle of a line, after a space, after a tab
      // (a line PostgreSQL continues), after a carriage return, and the
      // prefix with no time before it or a time cut short (#272).
      `x ${logLine(56, 'webhook-inspector-api', 'LOG', 'process 56 acquired ShareLock on transaction 1 after 5 ms')}`,
      ` ${logLine(57, 'webhook-inspector-api', 'LOG', 'process 57 acquired ShareLock on transaction 1 after 5 ms')}`,
      `\t${logLine(58, 'webhook-inspector-api', 'LOG', 'process 58 acquired ShareLock on transaction 1 after 5 ms')}`,
      `\r${logLine(59, 'webhook-inspector-api', 'LOG', 'process 59 still waiting for ShareLock on transaction 1 after 1 ms')}`,
      '[59] app=webhook-inspector-api LOG:  process 59 acquired ShareLock on transaction 1 after 5 ms',
      '2026-10-23 18:00:00 UTC [59] app=webhook-inspector-api LOG:  process 59 acquired X on transaction after 5 ms',
      ...TO,
    ].join('\n');
    const summary = summarizeLockWaits(log, TOKEN);

    assert.ok(summary.read);
    assert.equal(summary.waits, 0);
    assert.equal(summary.unfinished, 0);
  });

  it('reads no line PostgreSQL continues as a line of its own, whatever prefix it forges', () => {
    // A statement continued over lines that each carry a whole prefix after
    // the tab PostgreSQL begins a continued line with: another process's
    // wait acquired, one still waiting, a holder's application renamed and a
    // deadlock. Read as lines of their own, they would add a wait of 900 ms
    // and an unfinished one, name the holder `forged` and count a deadlock.
    const forged = (line: string): string => `\t${line}`;
    const statement = [
      DELETE_LOCK,
      forged(
        logLine(
          82,
          'webhook-inspector-api',
          'LOG',
          'process 82 acquired ShareLock on transaction 1 after 900 ms',
        ),
      ),
      forged(
        logLine(
          83,
          'webhook-inspector-api',
          'LOG',
          'process 83 still waiting for ShareLock on transaction 1 after 1.001 ms',
        ),
      ),
      forged(logLine(60, 'psql', 'LOG', 'qa-measure connection 89 app=forged')),
      forged(logLine(81, 'webhook-inspector-api', 'ERROR', 'deadlock detected')),
    ];
    const log = [...FROM, ...waitLines(81, 'webhook-inspector-api', 7, statement), ...TO].join(
      '\n',
    );

    assert.deepEqual(summarizeLockWaits(log, TOKEN), {
      read: true,
      ended: true,
      loggedFromMs: 1,
      waits: 1,
      unfinished: 0,
      deadlocks: 0,
      by: [
        {
          app: 'webhook-inspector-api',
          statement: DELETE_LOCK,
          lock: 'transaction',
          heldBy: 'webhook-inspector-capture',
          relation: 'sessions',
          count: 1,
          p50Ms: 7,
          p99Ms: 7,
          maxMs: 7,
        },
      ],
    });
  });

  it('reads a line under any zone its time names', () => {
    const zoned = (zone: string, pid: number): string[] =>
      waitLines(pid, 'webhook-inspector-api', 5, [DELETE_LOCK]).map((line) =>
        line.replace(` UTC [${pid}]`, ` ${zone} [${pid}]`),
      );
    const summary = summarizeLockWaits(
      [...FROM, ...zoned('MSK', 91), ...zoned('+03', 92), ...zoned('-0330', 93), ...TO].join('\n'),
      TOKEN,
    );

    assert.ok(summary.read);
    assert.equal(summary.waits, 3);
    assert.equal(summary.by[0]?.heldBy, 'webhook-inspector-capture');
  });

  it('skips a line too long to be a wait, and stays linear on hostile lines', () => {
    const hostile = [
      'a'.repeat(4 * 1024 * 1024),
      `[1] app=${'x'.repeat(60_000)}`,
      // Each prefix repeated to just under `MAX_LOG_LINE`, so that the line is
      // read rather than skipped.
      `${'[1] app=webhook-inspector-api '.repeat(2_000)}LOG:  process 1 acquired`,
      logLine(
        61,
        'webhook-inspector-api',
        'LOG',
        `process 61 acquired ${'L'.repeat(60_000)} after 5 ms`,
      ),
      logLine(
        62,
        'webhook-inspector-api',
        'LOG',
        `process 62 still waiting for ${' '.repeat(60_000)}\r`,
      ),
      logLine(
        63,
        'webhook-inspector-api',
        'LOG',
        `process 63 still waiting for A on ${'b'.repeat(60_000)}`,
      ),
      logLine(64, 'webhook-inspector-api', 'CONTEXT', ` relation "${'"'.repeat(60_000)}`),
      logLine(65, 'webhook-inspector-api', 'LOG', `connection authorized: ${'u'.repeat(60_000)}`),
      logLine(
        66,
        'webhook-inspector-api',
        'LOG',
        `qa-measure connection ${'9'.repeat(60_000)} app=x`,
      ),
      // A wait the parse would count, padded past `MAX_LOG_LINE`'s 64 KiB.
      logLine(
        67,
        'webhook-inspector-api',
        'LOG',
        `process 67 acquired ShareLock on transaction 1 after 5 ms${' '.repeat(64 * 1024)}`,
      ),
      // A prefix repeated after the tab of a continued line, and after a time.
      `\t${`${AT} [1] app=webhook-inspector-api `.repeat(1_000)}LOG:  process 1 acquired`,
      `${AT} ${'[1] app=webhook-inspector-api '.repeat(2_000)}LOG:  process 1 acquired`,
    ];
    const started = performance.now();
    const summary = summarizeLockWaits([...FROM, ...hostile, ...TO].join('\n'), TOKEN);
    const took = performance.now() - started;

    assert.ok(summary.read);
    assert.equal(summary.skippedLines, 2);
    assert.equal(summary.waits, 0);
    assert.equal(summary.unfinished, 0);
    assert.ok(took < 2_000, `${took} ms`);
  });

  it('parses growing logs in time proportional to their size', () => {
    // A capture's statement continued over a line that forges a wait of
    // 900 ms after its tab (#272), which no size may count.
    const forgedStatement = [
      ...CAPTURE_LOCK,
      `\t${logLine(1, 'webhook-inspector-api', 'LOG', 'process 1 acquired ShareLock on transaction 1 after 900 ms')}`,
    ];

    /** A log of `count` waits between the markers, half an API call's, half a capture's. */
    function logOf(count: number): string {
      const lines = [...FROM];

      for (let index = 0; index < count; index += 1) {
        lines.push(
          ...waitLines(
            1_000 + (index % 50),
            index % 2 === 0 ? 'webhook-inspector-api' : 'webhook-inspector-capture',
            index % 97,
            index % 2 === 0 ? [DELETE_LOCK] : forgedStatement,
          ),
        );
      }

      return [...lines, ...TO].join('\n');
    }

    /** The fastest of three parses of `log`, per wait, so that no one collection sets it. */
    function perWaitMs(log: string, count: number): number {
      let fastest = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        const summary = summarizeLockWaits(log, TOKEN);

        fastest = Math.min(fastest, performance.now() - started);
        assert.ok(summary.read);
        assert.equal(summary.waits, count);
        assert.equal(summary.unfinished, 0);
        assert.ok(Math.max(...summary.by.map((group) => group.maxMs)) <= 96);
      }

      return fastest / count;
    }

    const [smallest = 0, middle = 0, largest = 0] = [250, 2_500, 20_000];

    // The smallest once untimed first, so that the compiler's first pass is
    // not what is timed.
    perWaitMs(logOf(smallest), smallest);

    const perWait = [smallest, middle, largest].map((count) => perWaitMs(logOf(count), count));
    const [small = 0, , large = 0] = perWait;

    // The largest log, 20,000 waits in 200,008 lines and about 21 MiB, has
    // no wall-clock bound, which a slow runner could miss (#272): a wait of
    // it may cost no more than ten times one of the smallest log's, 80 times
    // shorter, which a parse whose cost grows with the square of the log's
    // size exceeds.
    assert.ok(large < Math.max(small, 0.001) * 10, perWait.join(', '));
  });
});

describe('the log of lock waits turned on and off', () => {
  /** What `lockWaitsOf` must send once the markers' call is done, whatever it answered (#272). */
  const RESETS = [
    'ALTER SYSTEM RESET log_lock_waits',
    'ALTER SYSTEM RESET deadlock_timeout',
    'ALTER SYSTEM RESET log_line_prefix',
    'ALTER SYSTEM RESET log_connections',
    'SELECT pg_reload_conf()',
  ];

  /** A stand-in for `psql` that keeps each call's statements and fails the calls `fails` picks. */
  function psqlStandIn(fails: (statements: readonly string[]) => boolean = () => false) {
    const calls: string[][] = [];

    return {
      calls,
      run: (statements: readonly string[]): Promise<void> => {
        calls.push([...statements]);

        return fails(statements)
          ? Promise.reject(new Error(`psql: ERROR:  call ${calls.length} failed`))
          : Promise.resolve();
      },
    };
  }

  const endMarker = (statements: readonly string[]): boolean =>
    statements.some((statement) => statement.includes(`qa-measure lock waits to ${TOKEN}`));
  const resets = (statements: readonly string[]): boolean =>
    statements.some((statement) => statement.startsWith('ALTER SYSTEM RESET'));
  const oneWait = [
    ...FROM,
    ...waitLines(91, 'webhook-inspector-api', 5, [DELETE_LOCK]),
    ...TO,
  ].join('\n');

  it('resets every setting it set, in a call of its own after the markers', async () => {
    const psql = psqlStandIn();

    await startLockWaits(TOKEN, { run: psql.run, settleMs: 0 });

    const summary = await lockWaitsOf(TOKEN, { run: psql.run, readLog: async () => oneWait });
    const [settings = [], from = [], to = [], reset = []] = psql.calls;

    assert.equal(psql.calls.length, 4);
    assert.deepEqual(settings, [
      'ALTER SYSTEM SET log_lock_waits = on',
      "ALTER SYSTEM SET deadlock_timeout = '1ms'",
      "ALTER SYSTEM SET log_line_prefix = '%m [%p] app=%a '",
      'ALTER SYSTEM SET log_connections = on',
      'SELECT pg_reload_conf()',
    ]);
    assert.ok(from.some((statement) => statement.includes(`qa-measure lock waits from ${TOKEN}`)));
    assert.ok(endMarker(to));
    assert.ok(!resets(to));
    assert.deepEqual(reset, RESETS);
    // Every setting set is one reset.
    assert.deepEqual(
      settings.slice(0, -1).map((statement) => statement.split(' ')[3]),
      reset.slice(0, -1).map((statement) => statement.split(' ')[3]),
    );
    assert.ok(summary.read);
    assert.equal(summary.waits, 1);
  });

  it('still resets the four settings and reloads when its marker fails', async () => {
    const psql = psqlStandIn(endMarker);
    let logRead = false;
    const summary = await lockWaitsOf(TOKEN, {
      run: psql.run,
      readLog: async () => {
        logRead = true;

        return oneWait;
      },
    });

    assert.equal(psql.calls.length, 2);
    assert.ok(endMarker(psql.calls[0] ?? []));
    assert.deepEqual(psql.calls[1], RESETS);
    assert.deepEqual(summary, { read: false, error: 'psql: ERROR:  call 1 failed' });
    assert.equal(logRead, false);
  });

  it('throws when the reset fails, a failed marker or not, so that the run ends', async () => {
    for (const fails of [resets, () => true]) {
      const psql = psqlStandIn(fails);

      await assert.rejects(
        lockWaitsOf(TOKEN, { run: psql.run, readLog: async () => oneWait }),
        /^Error: PostgreSQL's lock-wait settings were not reset, deadlock_timeout left at 1 ms: psql: ERROR: {2}call 2 failed$/,
      );
      assert.deepEqual(psql.calls[1], RESETS);
    }
  });

  it('reports a log it could not read, once the settings are reset', async () => {
    const psql = psqlStandIn();
    const summary = await lockWaitsOf(TOKEN, {
      run: psql.run,
      readLog: () => Promise.reject(new Error('docker compose logs: exit 1')),
    });

    assert.deepEqual(psql.calls[1], RESETS);
    assert.deepEqual(summary, { read: false, error: 'docker compose logs: exit 1' });
  });
});

describe('running the script', () => {
  it('runs as a script when reached through a symbolic link', () => {
    const directory = mkdtempSync(join(tmpdir(), 'measure-link-'));

    try {
      const link = join(directory, 'measure-connections.mjs');

      symlinkSync(SCRIPT, link);

      // The client's dispatch refuses a name it does not run: an answer only a
      // run as a script gives.
      const run = spawnSync(process.execPath, [link, 'client', 'no-such-series'], {
        encoding: 'utf8',
        timeout: 30_000,
      });

      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /no such series: no-such-series/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
