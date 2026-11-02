import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  API_CALL_LIMIT,
  MAX_BODY_BYTES,
  MAX_REALTIME_CONNECTIONS_PER_ADDRESS,
  MAX_RECEIVE_CONNECTIONS_PER_ADDRESS,
  MAX_REQUESTS_PER_SESSION,
  RATE_LIMIT_WINDOW_SECONDS,
  SESSION_CREATE_LIMIT,
  SESSION_ID_ALPHABET,
  SESSION_ID_LENGTH,
  SESSION_IDLE_DAYS,
} from '@webhook-inspector/shared';
import { readChangelog } from '../../scripts/changelog.mjs';
import { CONTACT_ADDRESS, CONTACT_MAILTO } from './contact.ts';
import { type LegalPage, legalLineText, PRIVACY_PAGE, TERMS_PAGE } from './legal-copy.ts';

/**
 * Every number the Terms of Use and the Privacy Policy state, held to the
 * source that makes it true (issue #112, Scope 3, D217): changing one there
 * fails this suite until the page is changed with it. The texts themselves
 * are pinned by `legal-copy.test.ts`; here each sentence is looked for with
 * its number taken from the source, so a page that kept an old number would
 * not find it. The 14 days' notice of a change (issue #163, D224) is taken
 * from the rule a delivery reads when it writes a changelog entry: the
 * `Notice` bullet of `CHANGELOG.md`'s header. The Privacy Policy's line on
 * the proxy's error log (issue #185, D231) states no number: its facts are
 * held to the proxy's settings and to what the backup copies. A change a page
 * announces ahead, a dated line of its changes section (issue #214, D224), is
 * held to the changelog entry whose Notice paragraph names the same day: that
 * entry is dated at least the notice period before it. Every such line is
 * held so: on `/privacy`, 2 November 2026's log line to 1.0.11, and the
 * contact address's mail moving to Yandex 360 (issue #275) to the entry that
 * announced it. The 90 days a day's
 * sender networks are kept (issue #165, D254) are read from the statement of
 * the pg_cron job that removes them, which must remove nothing else.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const NBSP = '\u00a0';

/** A section's lines as text, one per line, found by the section's label. */
function section(page: LegalPage, label: string): string {
  const found = page.sections.find((item) => item.label === label);

  assert.ok(found, `${page.path} has no section ${label}`);

  return found.lines.map(legalLineText).join('\n');
}

/**
 * The `- **Notice.**` bullet of `CHANGELOG.md`'s header on one line, the rule
 * a delivery reads when it writes an entry, and the notice it gives in days.
 */
function noticeRule(): { rule: string; days: string } {
  const changelog = read('../../../../CHANGELOG.md');
  // The header: everything above the first version, never published.
  const header = changelog.slice(0, changelog.search(/^## \d/m));
  const bullet = /^- \*\*Notice\.\*\*[\s\S]*?(?=^- |^\s*$)/m.exec(header)?.[0];

  assert.ok(bullet, "CHANGELOG.md's header has no `- **Notice.**` bullet");

  const rule = bullet.replace(/\s+/g, ' ');
  const days =
    /announces a change to the Terms of Use or the Privacy Policy at least (\d+) days before it applies/.exec(
      rule,
    )?.[1];

  assert.ok(days !== undefined, `the Notice bullet names no notice in days: ${rule}`);

  return { rule, days };
}

/** The months as the pages write a day: `2 November 2026`. */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A whole number as the pages write it: `1,000`, `1,200`, `60`. */
const written = (value: number) => value.toLocaleString('en-US');

/** A small count as a page writes it in words: `the first eight characters`. */
const COUNT_WORDS: Readonly<Record<number, string>> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
};

/** The backend's migrations, in the order they run, each as `[file, SQL]`. */
const MIGRATIONS = readdirSync(new URL('../../../backend/migrations/', import.meta.url))
  .filter((file) => /^\d{3}_.*\.sql$/.test(file))
  .sort()
  .map((file) => [file, read(`../../../backend/migrations/${file}`)] as const);

describe('the numbers of the Terms of Use and the Privacy Policy, against their sources', () => {
  it('states the session id: 43 random letters and digits (D004, D161)', () => {
    assert.match(SESSION_ID_ALPHABET, /^[A-Za-z0-9]+$/);
    assert.equal(new Set(SESSION_ID_ALPHABET).size, SESSION_ID_ALPHABET.length);
    assert.ok(
      section(TERMS_PAGE, 'Your sessions').includes(
        `its key: ${SESSION_ID_LENGTH}${NBSP}random letters and digits,`,
      ),
      `the session id is ${SESSION_ID_LENGTH} characters long`,
    );
  });

  it('states the body limit, 1 MB, on both pages (MAX_BODY_BYTES, D008)', () => {
    const megabytes = MAX_BODY_BYTES / (1024 * 1024);

    assert.ok(Number.isInteger(megabytes), `MAX_BODY_BYTES is ${MAX_BODY_BYTES}`);
    assert.ok(
      section(TERMS_PAGE, 'Limits').includes(
        `A request body can be up${NBSP}to${NBSP}${megabytes}${NBSP}MB; larger requests are${NBSP}refused.`,
      ),
    );
    assert.ok(
      section(PRIVACY_PAGE, 'What a session keeps').includes(
        `body up${NBSP}to${NBSP}${megabytes}${NBSP}MB.`,
      ),
    );
  });

  it('states the requests a session keeps, 1,000 (MAX_REQUESTS_PER_SESSION)', () => {
    assert.ok(
      section(TERMS_PAGE, 'Limits').includes(
        `keeps its newest ${written(MAX_REQUESTS_PER_SESSION)}${NBSP}requests`,
      ),
      `MAX_REQUESTS_PER_SESSION is ${MAX_REQUESTS_PER_SESSION}`,
    );
  });

  it('states the idle lifetime, 7 days, on both pages (SESSION_IDLE_DAYS, D133)', () => {
    assert.ok(
      section(TERMS_PAGE, 'Limits').includes(
        `is deleted ${SESSION_IDLE_DAYS}${NBSP}days after its last${NBSP}use.`,
      ),
      `SESSION_IDLE_DAYS is ${SESSION_IDLE_DAYS}`,
    );
    assert.ok(
      section(PRIVACY_PAGE, 'How long').includes(
        `goes unused for ${SESSION_IDLE_DAYS}${NBSP}days;`,
      ),
      `SESSION_IDLE_DAYS is ${SESSION_IDLE_DAYS}`,
    );
  });

  it('states the rate limits, 60 new sessions and 1,200 other calls a minute (D201)', () => {
    assert.equal(RATE_LIMIT_WINDOW_SECONDS, 60, 'the window is no longer a minute');
    assert.ok(
      section(TERMS_PAGE, 'Limits').includes(
        `The API allows ${written(SESSION_CREATE_LIMIT)} new sessions and ${written(API_CALL_LIMIT)} other calls a minute from one${NBSP}address.`,
      ),
      `the limits are ${SESSION_CREATE_LIMIT} and ${API_CALL_LIMIT}`,
    );
    // An address is held for one window at most by a count per minute (D201
    // item 7), and for as long as its connection stays open by a count of
    // connections: the receive host's and the realtime connections' (D227).
    assert.ok(MAX_RECEIVE_CONNECTIONS_PER_ADDRESS > 0 && MAX_REALTIME_CONNECTIONS_PER_ADDRESS > 0);
    assert.ok(
      section(PRIVACY_PAGE, 'Logs').includes(
        `Limits keep an IP${NBSP}address in memory for up to a minute, or while its connection stays open, and write it${NBSP}nowhere.`,
      ),
    );
    // Production runs the defaults: the chart sets neither variable that
    // would change them (apps/backend/src/config.ts).
    for (const file of ['../../../../deploy/helm/qa-tools/values.yaml']) {
      assert.doesNotMatch(read(file), /RATE_LIMIT_/, file);
    }
    for (const template of readdirSync(
      new URL('../../../../deploy/helm/qa-tools/templates/', import.meta.url),
    )) {
      assert.doesNotMatch(
        read(`../../../../deploy/helm/qa-tools/templates/${template}`),
        /RATE_LIMIT_/,
        template,
      );
    }
  });

  it('states the nightly backups, kept up to 3 days longer (the chart’s backup.keep, D176, D190)', () => {
    const values = read('../../../../deploy/helm/qa-tools/values.yaml');
    const keep = /^backup:\n[\s\S]*?^ {2}keep: (\d+)$/m.exec(values)?.[1];

    assert.ok(keep !== undefined, 'values.yaml has no backup.keep');
    assert.ok(
      section(PRIVACY_PAGE, 'How long').includes(
        `Nightly backups keep it up to ${keep}${NBSP}days${NBSP}longer.`,
      ),
      `backup.keep is ${keep}, and the page says otherwise`,
    );
  });

  it('states the cleanup, within 10 minutes: the expired-session job’s */10 schedule (D133)', () => {
    const schedules = MIGRATIONS.flatMap(([file, sql]) =>
      [...sql.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*\$\$([\s\S]*?)\$\$\s*\)/g)]
        .filter(([, , , command]) =>
          /DELETE FROM sessions WHERE expires_at < now\(\)/.test(command ?? ''),
        )
        .map(([, name, schedule]) => ({ file, name, schedule })),
    );
    const latest = schedules.at(-1);

    assert.ok(latest, 'no migration schedules the cleanup of expired sessions');
    assert.equal(latest.name, 'webhook-inspector-delete-expired-sessions');

    const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(latest.schedule as string)?.[1];

    assert.ok(minutes !== undefined, `${latest.file} schedules it at ${latest.schedule}`);
    assert.ok(
      section(PRIVACY_PAGE, 'How long').includes(
        `it is then removed within ${minutes}${NBSP}minutes.`,
      ),
      `the cleanup runs every ${minutes} minutes`,
    );
  });

  it('states the usage statistics: each day’s 20 most frequent values of four kinds (record_usage_days(), D178)', () => {
    const definitions = MIGRATIONS.filter(([, sql]) =>
      /CREATE (?:OR REPLACE )?FUNCTION public\.record_usage_days\(\)/.test(sql),
    );
    const [file, sql] = definitions.at(-1) ?? ['', ''];

    assert.ok(file, 'no migration defines record_usage_days()');

    const body = sql.slice(sql.indexOf('FUNCTION public.record_usage_days()'));
    const cuts = [...body.matchAll(/ranked\.position <= (\d+)/g)].map((match) => match[1]);

    assert.equal(cuts.length, 1, `${file} cuts the ranking more than once`);

    const top = cuts[0];

    // The four kinds ranked: User-Agent, content type, method and sender network.
    for (const dimension of ['user_agent', 'content_type', 'method', 'sender_net']) {
      assert.match(body, new RegExp(`\\('${dimension}', `), dimension);
    }

    const statistics = section(PRIVACY_PAGE, 'Usage statistics');

    assert.ok(
      statistics.includes(
        `Also each day's ${top} most frequent User-Agent values, content types and${NBSP}methods.`,
      ),
      `record_usage_days() keeps the top ${top}`,
    );
    assert.ok(statistics.includes(`And its ${top} most frequent sender networks:`));
  });

  it('states the sender networks, an IPv4 /24 or an IPv6 /48 (the stats.requests view, D170, D178)', () => {
    const definitions = MIGRATIONS.filter(([, sql]) =>
      /CREATE (?:OR REPLACE )?VIEW stats\.requests\b/.test(sql),
    );
    const [file, sql] = definitions.at(-1) ?? ['', ''];

    assert.ok(file, 'no migration defines stats.requests');

    const masks = /CASE family\(r\.source_ip::inet\) WHEN 4 THEN (\d+) ELSE (\d+) END/.exec(sql);

    assert.ok(masks, `${file} masks the sender's address another way`);
    assert.ok(
      section(PRIVACY_PAGE, 'Usage statistics').includes(
        `an IPv4${NBSP}/${masks[1]} or an IPv6${NBSP}/${masks[2]}, never a full address,`,
      ),
      `the view keeps /${masks[1]} and /${masks[2]}`,
    );
  });

  it('states the sender networks’ 90 days: the days of the job that removes them, which removes nothing else, and the backups’ 3 (D254)', () => {
    const removals = MIGRATIONS.flatMap(([file, sql]) =>
      [...sql.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*\$\$([\s\S]*?)\$\$\s*\)/g)]
        .filter(([, , , command]) => /\bstats\.usage_daily_top\b/.test(command ?? ''))
        .map(([, name, , command]) => ({ file, sql, name, command: command as string })),
    );
    const [first] = removals;
    const latest = removals.at(-1);

    assert.ok(first && latest, 'no migration schedules a removal from stats.usage_daily_top');
    // One job touches the top table: nothing else is removed from it, as the
    // section's other lines say. Migration 020 scheduled it, and 021 gave it
    // the inspector's name, removing it under the old one (D278).
    assert.deepEqual(
      removals.map((removal) => removal.name),
      ['qa-tools-delete-old-sender-nets', 'webhook-inspector-delete-old-sender-nets'],
    );
    assert.match(
      latest.sql,
      /^SELECT cron\.unschedule\(jobid\)\nFROM cron\.job\nWHERE jobname = 'qa-tools-delete-old-sender-nets';$/m,
    );
    assert.equal(first.command, latest.command, `${latest.file} renames it with another statement`);

    // The whole statement, so that it removes sender networks alone, by their
    // UTC day, and its days are the number the page states.
    const days =
      /^DELETE FROM stats\.usage_daily_top WHERE dimension = 'sender_net' AND day < \(now\(\) AT TIME ZONE 'UTC'\)::date - (\d+)$/.exec(
        latest.command,
      )?.[1];

    assert.ok(days !== undefined, `${latest.file}'s job removes something else: ${latest.command}`);
    // The migration that scheduled it runs the same statement once, so the
    // rule holds from its deployment.
    assert.ok(
      first.sql.includes(`\n${first.command};\n`),
      `${first.file} does not run its job's statement once`,
    );

    const values = read('../../../../deploy/helm/qa-tools/values.yaml');
    const keep = /^backup:\n[\s\S]*?^ {2}keep: (\d+)$/m.exec(values)?.[1];

    assert.ok(keep !== undefined, 'values.yaml has no backup.keep');
    assert.ok(
      section(PRIVACY_PAGE, 'Usage statistics').includes(
        `never a full address, kept ${days}${NBSP}days and up to ${keep}${NBSP}days longer in nightly${NBSP}backups.`,
      ),
      `the job keeps ${days} days, and the backups ${keep} more`,
    );
  });

  it('states what the log keeps of a session id, its first eight characters (VISIBLE_CHARACTERS in redact.ts, D059, D168)', () => {
    // Read as text, as the migrations and the chart are: the frontend imports
    // nothing from the backend's workspace.
    const declarations = [
      ...read('../../../backend/src/lib/redact.ts').matchAll(
        /^const VISIBLE_CHARACTERS = (\d+);$/gm,
      ),
    ];

    assert.equal(
      declarations.length,
      1,
      'apps/backend/src/lib/redact.ts must declare `const VISIBLE_CHARACTERS = <number>;` exactly once',
    );

    const count = Number(declarations[0]?.[1]);
    const word = COUNT_WORDS[count];

    assert.ok(word !== undefined, `VISIBLE_CHARACTERS is ${count}, which the page has no word for`);
    assert.ok(
      section(PRIVACY_PAGE, 'Logs').includes(
        `The URL includes the first ${word} characters of the session id and any query${NBSP}string.`,
      ),
      `the log keeps the first ${count} characters of a session id, and the page says otherwise`,
    );
  });

  it("states the proxy's error log: its access log off, its level the default, and no copy of it in a backup or anywhere else (D090, D176, D231)", () => {
    assert.ok(
      section(PRIVACY_PAGE, 'Logs').includes(
        `The proxy in front of the server records a sender's IP${NBSP}address in its error log when a connection fails, for example when the sender drops it mid-request. That log stays on the server until the proxy restarts; it is not backed up or sent${NBSP}anywhere.`,
      ),
    );

    // The proxy's settings, the values k3s gives its Traefik: what a line of
    // them says is read with the comments taken out.
    const traefik = read('../../../../deploy/cluster/traefik-config.yaml')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    // An address only when a connection fails, not on every request: the
    // access log, which would write one for each, stays off (D090).
    assert.match(traefik, /^ {4}logs:\n {6}access:\n {8}enabled: false$/m);
    // Its error log at Traefik's default level, INFO, which writes the ERROR
    // lines that hold the address, to the container's output, which the node
    // keeps as the pod's log: no level, no file and no export of the log is
    // set, here or as an argument.
    assert.doesNotMatch(traefik, /^\s*(?:general|level|filePath|otlp):/m);
    assert.doesNotMatch(traefik, /--(?:log|accesslog)\b|otlp/i);

    // Not backed up: the nightly backup dumps the database with pg_dump
    // (D176), and its pod mounts one directory of the node, its own; the
    // off-server copy is that dump, encrypted (D190).
    const backupScript = read('../../../../deploy/helm/qa-tools/files/db-backup.sh');

    assert.equal(
      [...backupScript.matchAll(/^if ! run "\$run_dir\/pg_dump\.err" pg_dump -Fc /gm)].length,
      1,
      'db-backup.sh no longer dumps the database once with pg_dump',
    );

    const backupTemplate = read('../../../../deploy/helm/qa-tools/templates/db-backup.yaml');

    assert.deepEqual(
      [...backupTemplate.matchAll(/hostPath:\n\s+path: (.+)$/gm)].map((match) => match[1]),
      ['{{ .Values.backup.hostPath | quote }}'],
    );
    assert.match(
      read('../../../../deploy/helm/qa-tools/values.yaml'),
      /^backup:\n[\s\S]*?^ {2}hostPath: \/var\/backups\/qa-tools\/nightly$/m,
    );

    // Not sent anywhere: nothing the repository deploys reaches the node's
    // /var/log, where it keeps every pod's log, as a collector of logs would.
    const deployed = readdirSync(new URL('../../../../deploy/', import.meta.url), {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile());

    assert.ok(deployed.length > 10, 'deploy/ was not read');
    for (const entry of deployed) {
      const path = `${entry.parentPath}/${entry.name}`;

      assert.doesNotMatch(readFileSync(path, 'utf8'), /\/var\/log\b/, path);
    }
  });

  it('gives the shutdown notice the API policy gives, at least 30 days (D212)', () => {
    const description = (
      JSON.parse(read('../../../../packages/shared/openapi.json')) as {
        info: { description: string };
      }
    ).info.description;
    const days = /removal date at least (\d+) days after the announcement/.exec(description)?.[1];

    assert.ok(days !== undefined, 'the stability policy names no notice in days');
    assert.ok(
      section(TERMS_PAGE, 'Changes to the service').includes(
        `I'll announce it here at least ${days}${NBSP}days ahead,`,
      ),
      `the stability policy gives ${days} days`,
    );
  });

  it('announces a change 14 days ahead on both pages, as the changelog header’s Notice rule says (D224)', () => {
    const { rule, days } = noticeRule();

    // One notice period: no other number of days in the rule.
    assert.deepEqual(
      [...rule.matchAll(/(\d+) days/g)].map((match) => match[1]),
      [days],
      'the Notice bullet names more than one notice period',
    );
    assert.ok(
      section(TERMS_PAGE, 'Changes to the terms').includes(
        `A new version is announced here at least ${days}${NBSP}days before it applies.`,
      ),
      `the Notice rule gives ${days} days, and /terms says otherwise`,
    );
    assert.ok(
      section(PRIVACY_PAGE, 'Changes to this policy').includes(
        `are announced here at least ${days}${NBSP}days before they apply,`,
      ),
      `the Notice rule gives ${days} days, and /privacy says otherwise`,
    );
  });

  it('dates each announced change at least the notice period after the entry whose Notice paragraph names its day and says the same (D224)', () => {
    const days = Number(noticeRule().days);
    const entries = readChangelog();

    for (const [page, label] of [
      [TERMS_PAGE, 'Changes to the terms'],
      [PRIVACY_PAGE, 'Changes to this policy'],
    ] as const) {
      // A changes section's first line is its rule; every line after it
      // announces a change: `From <day> <Month> <year>, ` and what changes;
      // `/privacy` has two (issues #214 and #275).
      for (const line of section(page, label).split('\n').slice(1)) {
        const [, date = '', month = '', year = '', change = ''] =
          /^From ([1-9]|[12]\d|3[01]) ([A-Z][a-z]+) (20\d\d), (.+)$/.exec(line) ?? [];
        const day = `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-${date.padStart(2, '0')}`;

        assert.ok(MONTHS.includes(month), `${page.path}: not a dated line: ${line}`);
        assert.equal(new Date(day).toISOString().slice(0, 10), day, `${page.path}: ${line}`);

        // The entry that announced it: the oldest whose Notice paragraph
        // names the day, as `YYYY-MM-DD`, and says what the line says.
        const said = `${day}, ${change.replaceAll(NBSP, ' ')}`;
        const announcing = entries
          .filter((entry) =>
            entry.paragraphs.some(
              (paragraph) => paragraph.startsWith('**Notice:**') && paragraph.includes(day),
            ),
          )
          .at(-1);

        assert.ok(announcing, `${page.path} announces ${day}; no Notice paragraph names that day`);
        assert.ok(
          announcing.paragraphs.some(
            (paragraph) => paragraph.startsWith('**Notice:**') && paragraph.includes(said),
          ),
          `${announcing.version}'s Notice paragraph does not say "${said}"`,
        );

        const ahead = (Date.parse(day) - Date.parse(announcing.date)) / 86_400_000;

        assert.ok(
          ahead >= days,
          `${announcing.version}, of ${announcing.date}, announces ${day} ${ahead} days ahead, not ${days}`,
        );
      }
    }
  });

  it('names the one contact address, contact.ts’s, as a mail link wherever it appears', () => {
    for (const page of [TERMS_PAGE, PRIVACY_PAGE]) {
      const text = page.sections.flatMap((item) => item.lines.map(legalLineText)).join('\n');
      const addresses = [...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(
        (match) => match[0],
      );

      assert.ok(addresses.length > 0, page.path);
      assert.deepEqual(new Set(addresses), new Set([CONTACT_ADDRESS]), page.path);

      const mail = page.sections.flatMap((item) =>
        item.lines.flatMap((line) =>
          typeof line === 'string' ? [] : line.filter((part) => part.kind === 'mail'),
        ),
      );

      assert.equal(mail.length, addresses.length, page.path);

      for (const part of mail) {
        assert.deepEqual(part, { kind: 'mail', text: CONTACT_ADDRESS, href: CONTACT_MAILTO });
      }
    }
  });
});
