/**
 * What the ordinary-load measurement's `--cpu-prof` run reads inside the
 * backend's process (#188), loaded before the backend with `--import` by the
 * compose file `measure-ordinary-load.cpu-prof.yml`: the event loop's turns
 * and the events it handled (`performance.nodeTiming.uvMetricsInfo`), written
 * as one JSON line every 250 ms to
 * `/tmp/qa-profile/probe.jsonl` in the backend's container (`QA_PROBE_DIR`
 * names another directory), beside the CPU profile `node --cpu-prof` writes
 * there when the backend exits. Its last line is written as the backend exits,
 * when the profile ends, so that the script can read the profile's clock
 * against the wall clock and cut the profile to the step's hold.
 *
 * Not its utilisation: under the profiler, whose signal interrupts the loop's
 * wait a thousand times a second, it read the idle backend as 85 % busy.
 *
 * It changes nothing the backend does. Only the backend's own process is
 * probed: a `node` the container's health check or `docker exec` starts does
 * not load it, its command naming no `--import`.
 *
 * Dependency-free, Node 24.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setInterval } from 'node:timers';

// Another directory for the suite's run of it alone.
const DIR = process.env.QA_PROBE_DIR ?? '/tmp/qa-profile';
const OUT = `${DIR}/probe.jsonl`;
const EVERY_MS = 250;

mkdirSync(DIR, { recursive: true });

function line() {
  const { loopCount, events } = performance.nodeTiming.uvMetricsInfo;

  appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), loops: loopCount, events })}\n`);
}

line();
setInterval(line, EVERY_MS).unref();
process.on('exit', line);
