import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ABOUT_RU } from './about-copy-ru.ts';
import { aboutParagraphText, MCP_SERVER_URL } from './about-copy.ts';
import { ABOUT_ADDRESSES } from './about-link.ts';
import { CONTACT_ADDRESS, CONTACT_MAILTO } from './contact.ts';
import { APP_ORIGIN } from '../../scripts/site-origin.mjs';

/**
 * The text of `/ru/about` (issue #170, D255), exactly as approved on
 * 2026-10-20, variant A: every text of the issue's `Russian text,
 * approved`, byte for byte, with the no-break spaces that set where its lines
 * may end (issue #258): after every one-letter word, before every em dash,
 * inside `QA Tools`, and among the last words of some lines (D211's rule),
 * and nothing else. As `about-copy.test.ts` does for `/about`;
 * `about-pair.test.ts` holds the two pages in step.
 */

const NBSP = String.fromCharCode(0xa0);
const NBH = String.fromCharCode(0x2011);
const EM_DASH = String.fromCharCode(0x2014);

/** A text as the issue writes it, ` NBSP ` standing for one no-break space with no ordinary space beside it. */
const approved = (text: string) => text.replaceAll(' NBSP ', NBSP);

/** Every text of the page a reader meets in its body, label by label. */
const everyText = () => [
  ABOUT_RU.eyebrow,
  ABOUT_RU.heading,
  ...ABOUT_RU.story.map(aboutParagraphText),
  ...ABOUT_RU.facts.flatMap((fact) => [fact.label, ...fact.lines]),
];

/**
 * Where a text lets a line break against the rules of issue #258, by the
 * ordinary spaces it holds: a line may break at an ordinary space only. Each
 * problem is named with the words around it.
 */
function lineBreakProblems(text: string): string[] {
  const rules: [string, RegExp][] = [
    ['an ordinary space beside a joint', / \u00a0|\u00a0 /gu],
    ['a one-letter word before an ordinary space', /(?<![\p{L}\p{N}])\p{L} /gu],
    ['an ordinary space before an em dash', / \u2014/gu],
    ['QA Tools split', /QA (?:Tools|TOOLS)/gu],
  ];

  return rules.flatMap(([rule, pattern]) =>
    [...text.matchAll(pattern)].map((match) => {
      const at = match.index;

      return `${rule}: ${text.slice(Math.max(0, at - 12), at + match[0].length + 12)}`;
    }),
  );
}

describe('the Russian about page text (variant A, 2026-10-20)', () => {
  it('names and describes the page, at its own address, in Russian', () => {
    assert.equal(ABOUT_RU.lang, 'ru');
    assert.equal(ABOUT_RU.path, '/ru/about');
    assert.equal(ABOUT_RU.path, ABOUT_ADDRESSES.ru);
    assert.equal(ABOUT_RU.url, `${APP_ORIGIN}/ru/about`);
    assert.equal(ABOUT_RU.title, 'О QA Tools');
    assert.equal(
      ABOUT_RU.description,
      'Кто и как делает QA Tools, кто за него платит и что происходит с вашими данными.',
    );
  });

  it('has the eyebrow and the heading the owner approved', () => {
    assert.equal(ABOUT_RU.eyebrow, approved('О NBSP QA NBSP TOOLS'));
    assert.equal(ABOUT_RU.heading, approved('От тестировщика NBSP — тестировщикам'));
    // Option B of issue #258: the dash ends the first line on a phone.
    assert.equal(ABOUT_RU.heading, `От тестировщика${NBSP}${EM_DASH} тестировщикам`);
  });

  it('tells the story in three paragraphs, byte for byte', () => {
    assert.deepEqual(ABOUT_RU.story.map(aboutParagraphText), [
      approved(
        'Я NBSP тестировщик и NBSP делаю инструменты для тестировщиков. QA NBSP Tools NBSP — мой личный проект и NBSP заодно эксперимент: на нём я NBSP учусь NBSP новому.',
      ),
      approved(
        `Код пишут ИИ-агенты, и NBSP сервис сделан в NBSP том числе для них: агент может работать с NBSP QA NBSP Tools через MCP-сервер ${APP_ORIGIN}/mcp.`,
      ),
      approved('Пользуйтесь NBSP — и NBSP пишите, что NBSP думаете: contact@qa-tools.ru.'),
    ]);
  });

  it('shows the MCP address as code, not a link, and the contact address as mail from contact.ts', () => {
    assert.deepEqual(
      ABOUT_RU.story.map((paragraph) => paragraph.map((part) => part.kind)),
      [['text'], ['text', 'code', 'text'], ['text', 'mail', 'text']],
    );
    assert.deepEqual(ABOUT_RU.story[1]?.[1], { kind: 'code', text: MCP_SERVER_URL });
    assert.deepEqual(ABOUT_RU.story[2]?.[1], {
      kind: 'mail',
      text: CONTACT_ADDRESS,
      href: CONTACT_MAILTO,
    });
  });

  it('states the four facts, each line its own, byte for byte', () => {
    assert.deepEqual(ABOUT_RU.facts, [
      {
        label: 'Как это сделано',
        lines: [
          approved(
            'Весь код написан ИИ-агентами: Claude Code пишет его, тестирует NBSP и NBSP проверяет.',
          ),
          approved(
            'Я NBSP решаю, что делать, и NBSP утверждаю каждый экран NBSP — сначала его рисуют NBSP в NBSP Figma.',
          ),
          approved(
            'TypeScript, React и NBSP Fastify, PostgreSQL, небольшой кластер NBSP Kubernetes NBSP (k3s).',
          ),
        ],
      },
      {
        label: 'Кто платит',
        lines: [
          approved('Я. Для вас QA NBSP Tools бесплатен.'),
          approved(
            'Что бесплатно сейчас, бесплатным и NBSP останется. Если появятся платные тарифы, это будут дополнительные возможности NBSP для NBSP команд.',
          ),
        ],
      },
      {
        label: 'Ваши данные',
        lines: [
          approved('Никакой рекламы, cookie и NBSP сторонней NBSP аналитики.'),
          approved('Принятые запросы не продаются и NBSP никому NBSP не NBSP передаются.'),
        ],
      },
      {
        label: 'Проверка безопасности',
        lines: [
          approved(
            'Компании могут запросить по почте сведения о NBSP владельце сервиса или договор об NBSP обработке NBSP данных.',
          ),
        ],
      },
    ]);
  });

  it('is the approved words exactly once the joints are read as spaces', () => {
    const plain = (text: string) => text.replaceAll(NBSP, ' ');

    assert.deepEqual(everyText().map(plain), [
      'О QA TOOLS',
      'От тестировщика — тестировщикам',
      'Я тестировщик и делаю инструменты для тестировщиков. QA Tools — мой личный проект и заодно эксперимент: на нём я учусь новому.',
      `Код пишут ИИ-агенты, и сервис сделан в том числе для них: агент может работать с QA Tools через MCP-сервер ${APP_ORIGIN}/mcp.`,
      'Пользуйтесь — и пишите, что думаете: contact@qa-tools.ru.',
      'Как это сделано',
      'Весь код написан ИИ-агентами: Claude Code пишет его, тестирует и проверяет.',
      'Я решаю, что делать, и утверждаю каждый экран — сначала его рисуют в Figma.',
      'TypeScript, React и Fastify, PostgreSQL, небольшой кластер Kubernetes (k3s).',
      'Кто платит',
      'Я. Для вас QA Tools бесплатен.',
      'Что бесплатно сейчас, бесплатным и останется. Если появятся платные тарифы, это будут дополнительные возможности для команд.',
      'Ваши данные',
      'Никакой рекламы, cookie и сторонней аналитики.',
      'Принятые запросы не продаются и никому не передаются.',
      'Проверка безопасности',
      'Компании могут запросить по почте сведения о владельце сервиса или договор об обработке данных.',
    ]);
  });

  it('joins every one-letter word to the next, every em dash to the word before it and QA Tools, and the last words of some lines', () => {
    for (const text of everyText()) {
      assert.deepEqual(lineBreakProblems(text), [], text);
    }

    // Every joined run, in the order the page reads: the rules' joints and,
    // ending a line, D211's last words (`я учусь новому.`, `что думаете:`,
    // `кластер Kubernetes (k3s).`, `возможности для команд.`, and the runs
    // that already reached over a one-letter word).
    const joined = everyText()
      .flatMap((text) => [...text.matchAll(/[^\s\u00a0]+(?:\u00a0[^\s\u00a0]+)+/g)])
      .map((match) => match[0].replaceAll(NBSP, '_'));

    assert.deepEqual(joined, [
      'О_QA_TOOLS',
      'тестировщика_—',
      'Я_тестировщик',
      'и_делаю',
      'QA_Tools_—',
      'и_заодно',
      'я_учусь_новому.',
      'и_сервис',
      'в_том',
      'с_QA_Tools',
      'Пользуйтесь_—',
      'и_пишите,',
      'что_думаете:',
      'тестирует_и_проверяет.',
      'Я_решаю,',
      'и_утверждаю',
      'экран_—',
      'рисуют_в_Figma.',
      'и_Fastify,',
      'кластер_Kubernetes_(k3s).',
      'QA_Tools',
      'и_останется.',
      'возможности_для_команд.',
      'и_сторонней_аналитики.',
      'и_никому_не_передаются.',
      'о_владельце',
      'об_обработке_данных.',
    ]);

    // The title and the description, which the page does not lay out, keep
    // their ordinary spaces.
    assert.ok(!ABOUT_RU.title.includes(NBSP));
    assert.ok(!ABOUT_RU.description.includes(NBSP));
  });

  it('finds each break against the rules, also in long made-up texts', () => {
    // The check above passes only if it can fail: each rule caught alone,
    // and the joined text clean.
    assert.deepEqual(lineBreakProblems('работать с QA Tools'), [
      'a one-letter word before an ordinary space: работать с QA Tools',
      'QA Tools split: работать с QA Tools',
    ]);
    assert.deepEqual(lineBreakProblems(`Я тестировщик`), [
      'a one-letter word before an ordinary space: Я тестировщик',
    ]);
    assert.deepEqual(lineBreakProblems(`каждый экран ${EM_DASH} сначала`), [
      `an ordinary space before an em dash: каждый экран ${EM_DASH} сначала`,
    ]);
    assert.deepEqual(lineBreakProblems('О QA TOOLS'), [
      'a one-letter word before an ordinary space: О QA TOOLS',
      'QA Tools split: О QA TOOLS',
    ]);
    assert.deepEqual(lineBreakProblems(`я ${NBSP}учусь`), [
      `an ordinary space beside a joint: я ${NBSP}учусь`,
      `a one-letter word before an ordinary space: я ${NBSP}учусь`,
    ]);
    // No break against the rules: a one-letter word before a comma or a
    // full stop, the last letter of a word, a letter after a digit.
    assert.deepEqual(lineBreakProblems('слово и, k3s в. Я. Для'), []);
    assert.deepEqual(lineBreakProblems(`с${NBSP}QA${NBSP}Tools${NBSP}${EM_DASH} мой`), []);

    // Made-up texts of growing size: every break found, in linear time.
    for (const count of [1, 1_000, 100_000]) {
      const broken = `в QA Tools ${EM_DASH} `.repeat(count);
      const joined = `в${NBSP}QA${NBSP}Tools${NBSP}${EM_DASH} `.repeat(count);
      const started = performance.now();

      assert.equal(lineBreakProblems(broken).length, 3 * count);
      assert.deepEqual(lineBreakProblems(joined), []);
      assert.equal(lineBreakProblems(' '.repeat(count) + NBSP.repeat(count)).length, 1);
      assert.ok(performance.now() - started < 5_000, `${count}: ${performance.now() - started} ms`);
    }
  });

  it('holds only the characters it was approved in: Cyrillic, ASCII, the joints and the em dash', () => {
    // The English page's ASCII-only rule (`about-copy.test.ts`), widened for
    // Russian to an explicit set rather than dropped: printable ASCII, the
    // Russian alphabet with Ё, the no-break space and hyphen, the em dash.
    // No `« »`, which the text does not use.
    for (const text of [ABOUT_RU.title, ABOUT_RU.description, ...everyText()]) {
      assert.doesNotMatch(text, /[^\x20-\x7e\u0410-\u044f\u0401\u0451\u00a0\u2011\u2014]/, text);
    }

    // No no-break hyphen: the hyphens of `ИИ-агенты` and `MCP-сервер` are as written.
    assert.ok(!everyText().join('').includes(NBH));
    assert.equal(everyText().join('').split(EM_DASH).length - 1, 4);
  });
});
