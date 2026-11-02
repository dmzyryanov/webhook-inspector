// Records what script tests read in this checkout (#194, D241). A job of
// .gitlab/ci/validate.yml whose tests run only when what they read changes
// loads this with `--import` through NODE_OPTIONS; afterwards
// `node scripts/test-inputs.mjs check <job> <file>` compares the record with
// the job's `changes:` paths.
//
// For the test process and every Node process started under it, each path of
// the checkout appends one line to the file TEST_INPUTS_FILE names: a file
// that is opened, read, stat'ed, checked for or imported, a file handed to a
// child process to run (`sh deploy/…`, `bash deploy/…`), and a
// directory that is listed, with a trailing slash. A child given an
// environment of its own gets NODE_OPTIONS and TEST_INPUTS_FILE added to it,
// so it records too. Without TEST_INPUTS_FILE this does nothing.
//
// What it cannot see: a file read by a process that is not Node, such as a
// shell script's `cat`. The scripts those tests run sit in directories each
// group's list covers whole.

import fs from 'node:fs';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SELF));
const OUT = process.env.TEST_INPUTS_FILE;

if (OUT) {
  const append = fs.appendFileSync;
  const statOf = fs.statSync;
  const seen = new Set();

  const record = (entry) => {
    if (seen.has(entry)) return;
    seen.add(entry);
    try {
      append(OUT, `${entry}\n`);
    } catch {
      // A record that cannot be written leaves the check without it, which
      // fails the check rather than the test.
    }
  };

  /** This checkout's relative path of `target`, or null for anything outside it. */
  const inside = (target, base) => {
    try {
      if (target === null || target === undefined || typeof target === 'number') return null;
      let text = target instanceof URL ? fileURLToPath(target) : String(target);
      if (text.startsWith('file:')) text = fileURLToPath(text);
      const absolute = path.resolve(base ?? process.cwd(), text);
      const relative = path.relative(ROOT, absolute);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
      const top = relative.split(path.sep)[0];
      if (top === 'node_modules' || top === '.git') return null;
      return relative.split(path.sep).join('/');
    } catch {
      return null;
    }
  };

  const directories = new Set();
  const noteFile = (target, base) => {
    const relative = inside(target, base);
    if (relative === null || seen.has(relative) || directories.has(relative)) return;
    try {
      if (statOf(path.join(ROOT, relative), { throwIfNoEntry: false })?.isDirectory()) {
        directories.add(relative);
        return;
      }
    } catch {
      return;
    }
    record(relative);
  };
  const noteListing = (target) => {
    const relative = inside(target);
    if (relative !== null) record(`${relative}/`);
  };

  const LISTINGS = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync', 'cp', 'cpSync']);
  const READS = [
    'readFile',
    'readFileSync',
    'open',
    'openSync',
    'exists',
    'existsSync',
    'stat',
    'statSync',
    'lstat',
    'lstatSync',
    'access',
    'accessSync',
    'createReadStream',
    'copyFile',
    'copyFileSync',
    'readlink',
    'readlinkSync',
  ];
  const wrap = (target, name) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    const wrapped = function (where, ...rest) {
      if (LISTINGS.has(name)) noteListing(where);
      else noteFile(where);
      return original.call(this, where, ...rest);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    target[name] = wrapped;
  };
  for (const name of [...READS, ...LISTINGS]) wrap(fs, name);
  for (const name of [
    'readFile',
    'open',
    'stat',
    'lstat',
    'access',
    'copyFile',
    'readlink',
    'readdir',
    'opendir',
    'cp',
  ]) {
    wrap(fs.promises, name);
  }

  const IMPORT = `--import=${SELF}`;
  const withRecording = (options) => {
    if (!options || typeof options !== 'object' || !options.env) return options;
    const env = { ...options.env, TEST_INPUTS_FILE: OUT };
    if (!String(env.NODE_OPTIONS ?? '').includes(IMPORT)) {
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} ${IMPORT}`.trim();
    }
    return { ...options, env };
  };
  const noteRun = (command, args, options) => {
    const cwd =
      options && typeof options === 'object' && options.cwd ? String(options.cwd) : undefined;
    for (const word of [command, ...(Array.isArray(args) ? args : [])]) {
      // A word that could be a file's path: no option, no code, no spaces.
      if (typeof word === 'string' && /^[^-\s'"`()$;|&<>][^\s'"`()$;|&<>]{0,4095}$/.test(word)) {
        noteFile(word, cwd);
      }
    }
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = function (command, args, options, ...rest) {
      if (!Array.isArray(args)) {
        noteRun(command, [], args);
        return original.call(this, command, withRecording(args), options, ...rest);
      }
      noteRun(command, args, options);
      return original.call(this, command, args, withRecording(options), ...rest);
    };
  }
  for (const name of ['exec', 'execSync']) {
    const original = childProcess[name];
    childProcess[name] = function (command, options, ...rest) {
      return original.call(this, command, withRecording(options), ...rest);
    };
  }
  syncBuiltinESMExports();

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url?.startsWith('file:')) noteFile(new URL(result.url));
      return result;
    },
  });
  if (process.argv[1]) noteFile(process.argv[1]);
}
