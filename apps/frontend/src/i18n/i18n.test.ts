import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { renderAboutBody } from '../../scripts/about.mjs';
import { siteFooter, siteHeader } from '../../scripts/site-chrome.mjs';
import { formatDetailTimestamp, formatDocumentTitle, formatTimestamp } from '../lib/format.ts';
import { formatListCount, formatRowMeta, groupByDay } from '../lib/home-view.ts';
import { PRIVACY_PAGE } from '../lib/legal-copy.ts';
import { fixedLanguage } from '../lib/not-found.ts';
import { sessionRetentionLine } from '../lib/session-lifetime.ts';
import { en, type Messages } from './en.ts';
import {
  browserLanguage,
  initialLanguage,
  LANGUAGE_KEY,
  LANGUAGES,
  languageOfTag,
  MESSAGES,
  readStoredLanguage,
  storeLanguage,
} from './index.ts';
import { LATIN_IN_RUSSIAN } from './latin.ts';
import { ru } from './ru.ts';

const NBSP = '\u00a0';

/**
 * Arguments every text with numbers or names in it is written with in these
 * tests, by its place in the dictionary: several sets where a plural, a
 * missing value or a flag changes the words. A function of the dictionary
 * without an entry here fails the first test, so a new text cannot skip them.
 */
const SAMPLES: Record<string, readonly (readonly unknown[])[]> = {
  number: [[0], [7], [65536], [1234567]],
  'title.unread': [[1], [5], [12]],
  'move.notice': [['webhook.qa-tools.ru', '9 Mar 2027']],
  'move.arrived': [
    [5, 2, 'qa-tools.ru'],
    [1, 0, 'qa-tools.ru'],
    [1, 1, 'qa-tools.ru'],
    [2, 2, 'qa-tools.ru'],
    [21, 1, 'qa-tools.ru'],
    [0, 0, 'qa-tools.ru'],
    [5, 2, null],
  ],
  'landing.tooManySessions': [[1], [40]],
  'landing.stepsCount': [[1], [3], [5]],
  'home.sessions': [[1], [3], [5]],
  'home.requests': [[0], [1], [2], [14]],
  'home.lastRequestAt': [['2026-10-03 11:40']],
  'home.someShown': [
    [5, 12],
    [5, 21],
  ],
  'home.allShown': [[1], [3], [5]],
  'home.deleteDescription': [
    ['abc1234', null],
    ['abc1234', 0],
    ['abc1234', 1],
    ['abc1234', 14],
  ],
  'home.deleted': [['abc1234']],
  'home.expired': [['abc1234']],
  'sessions.actions': [['abc1234']],
  'sessions.copyUrl': [['abc1234']],
  'newSession.days': [[1], [7]],
  'newSession.hours': [[1], [2], [5]],
  'newSession.hintDays': [[1], [7]],
  'newSession.hintHours': [[1], [5]],
  'lifetime.retention': [[1], [3], [7]],
  'lifetime.retentionHours': [[1], [2], [25]],
  'lifetime.retentionMinutes': [[61], [62], [90]],
  'lifetime.retentionUntil': [
    [26, 'SEP', null, '11:50'],
    [2, 'JAN', 2027, '08:05'],
  ],
  'push.position': [[2, 4]],
  'push.arrived': [[1], [3], [5]],
  'push.back': [[null], ['3 new']],
  'list.limitSuffix': [[1000]],
  'list.noMatch': [['acme']],
  'list.chooseFor': [['POST', '2b906b8']],
  'list.tapFor': [['2b906b8']],
  'list.ruleMarker': [[1], [2], [20]],
  'list.answeredByRule': [[1], [2], [20]],
  'filter.count': [[3, 8]],
  'filter.tookOver': [[2]],
  'filter.wordTooLong': [[64]],
  'filter.tooManyWords': [[10]],
  'deleteAll.description': [
    [14, 0],
    [14, 3],
  ],
  'record.queueStep': [[2, 7]],
  'record.rule': [
    [1, 'POST', '/orders'],
    [3, null, '/items/*'],
  ],
  'record.prepared': [[503]],
  'record.configuredDelay': [[500]],
  'response.headers': [[1], [2], [5]],
  'response.queued': [[6]],
  'response.keptNote': [['201 · 500 ms']],
  'response.appliedDefault': [[200]],
  'response.applied': [
    [201, 0],
    [201, 500],
  ],
  'quick.delayChip': [[0], [500], [2000]],
  'quick.needsEmptyBody': [[204]],
  'quick.untouchedWithBody': [[2]],
  'quick.untouchedNoBody': [[2]],
  'quick.customStatus': [[201]],
  'quick.statusRange': [[200, 599]],
  'quick.delayRange': [[30000]],
  'quick.fix': [
    [true, false],
    [false, true],
    [true, true],
  ],
  'config.status': [[200, 599]],
  'config.bodyForbidden': [[204]],
  'config.tooManyHeaders': [[20]],
  'config.nameTooLong': [[256]],
  'config.valueTooLong': [[1024]],
  'config.blockTooLarge': [[8192]],
  'config.locationStatus': [[300, 399]],
  'config.locationTarget': [['/s/']],
  'config.delay': [[30000]],
  'config.bodyTooLarge': [[65536]],
  'editor.bodyCounter': [['16', '65,536']],
  'editor.rejected': [['response.delayMs must be an integer between 0 and 30000']],
  'fields.statusHint': [[200, 599]],
  'fields.delayHint': [['30,000']],
  'fields.headerField': [
    [2, 'name'],
    [2, 'value'],
  ],
  'fields.removeHeader': [[2]],
  'template.hint': [['{{request.id}}']],
  'template.unknown': [['{{request.foo}}'], ['{{ request.id }}']],
  'template.finish': [
    ['{{request.header.}}', 'name'],
    ['{{request.query.}}', 'name'],
    ['{{request.body.}}', 'path'],
  ],
  'queue.step': [[2]],
  'queue.stepOfQueue': [[2, 7]],
  'queue.stepName': [
    [2, '503', 'Service Unavailable', '2 s', 'next'],
    [1, '—', null, '', 'answered'],
    [3, '200', 'OK', '', 'ahead'],
  ],
  'queue.delay': [[500], [2000]],
  'queue.sessionDefault': [[200]],
  'queue.sessionCustom': [
    [200, ''],
    [200, '2 s'],
  ],
  'queue.counter': [[2, 7]],
  'queue.answeredLast': [['503']],
  'queue.next': [['429']],
  'queue.then': [[['200', '404']]],
  'queue.thenSession': [['Custom 200']],
  'queue.nextSession': [['Custom 200']],
  'queue.savedAhead': [
    [[], true],
    [[503], false],
    [[503, 503], true],
    [[503, 429, 200], false],
  ],
  'queue.restarted': [
    [[], false, false],
    [[503], true, false],
    [[503, 429], false, true],
  ],
  'queue.placeAhead': [[2]],
  'queue.fixSteps': [[[2]], [[2, 3]], [[2, 3, 5]]],
  'queue.removeShort': [[1], [7]],
  'queue.removeQuestion': [[1], [7]],
  'queue.rejected': [['steps[1].status must be an integer']],
  'queue.rejectedStep': [[2]],
  'queue.rejectedStepWithReason': [[2, 'steps[1] must be an object']],
  'rules.count': [[1], [3], [5], [21]],
  'rules.fallbackSession': [['Custom 200']],
  'rules.fallbackQueue': [['Default 200']],
  'rules.rule': [[2]],
  'rules.checked': [[1], [2], [20], [21]],
  'rules.counter': [[1, 3]],
  'rules.ruleOfList': [[1, 3]],
  'rules.ruleName': [
    [2, 'GET', '/status', '200', 'OK', ''],
    [3, 'Any', '/items/*', '404', 'Not Found', '2 s'],
    [1, 'POST', '/', '—', null, ''],
  ],
  'rules.move': [[2]],
  'rules.pathTooLong': [['1,024']],
  'rules.fixRules': [[[2]], [[2, 3]], [[2, 3, 5]]],
  'rules.removeShort': [[1], [3]],
  'rules.removeQuestion': [[1], [3]],
  'rules.rejected': [['rules[1].path may contain * only as its last character']],
  'rules.rejectedRule': [[2]],
  'rules.rejectedRuleWithReason': [[2, 'rules[1] must be an object']],
  'rules.saved': [[1], [3], [5]],
  'signature.headerOption': [['X-Signature', 2]],
  'signature.bytes': [[1], [2], [159], [2048]],
  'signature.subject': [['HMAC-SHA256', '159 bytes']],
  'signature.valueOf': [['X-Signature', 2, 3]],
  'signature.values': [['X-Signature', 3]],
  'compare.loading': [['POST 2b906b8']],
  'compare.gone': [['POST 2b906b8']],
  'compare.notLoaded': [['POST 2b906b8']],
  'compare.unchangedLines': [[1], [4], [5]],
  'compare.noDifferences': [['Headers']],
  'compare.wholeDiffer': [[true], [false]],
  'compare.wholeSame': [
    [true, false, '1.2 KB'],
    [false, true, '1.2 KB'],
  ],
  'blocks.jsonTooDeep': [[100]],
  'blocks.jsonTooLong': [[1000000]],
  'blocks.xmlTooDeep': [[100]],
  'blocks.xmlTooLong': [[1000000]],
  'blocks.multipartSplit': [[1], [3]],
  'blocks.partTitle': [[1]],
  'blocks.statusWithoutBody': [[204]],
};

/** Every value of a dictionary by its path: `home.deleted`, `landing.steps.0.title`. */
function leaves(value: unknown, path = ''): [string, unknown][] {
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      leaves(child, path === '' ? key : `${path}.${key}`),
    );
  }

  return [[path, value]];
}

/** Arguments that choose between words rather than being written. */
const CHOICES = new Set(['fields.headerField:1', 'queue.stepName:4', 'template.finish:1']);

/**
 * Every text a dictionary can draw: its strings, and each function written
 * with its samples. `lang` is a tag for `<html lang>`, not a text.
 */
function texts(m: Messages): { path: string; text: string; args: readonly unknown[] }[] {
  return leaves(m).flatMap(([path, value]) => {
    if (path === 'lang') {
      return [];
    }

    if (typeof value === 'string') {
      return [{ path, text: value, args: [] }];
    }

    if (typeof value === 'function') {
      return (SAMPLES[path] ?? []).map((args) => ({
        path,
        text: (value as (...args: unknown[]) => string)(...args),
        args,
      }));
    }

    return [];
  });
}

/** The words of a sample argument, which are the caller's and not the dictionary's. */
function argumentTexts(args: readonly unknown[]): string[] {
  return args.flatMap((arg) =>
    Array.isArray(arg) ? arg.map(String) : typeof arg === 'string' ? [arg] : [],
  );
}

describe('the dictionaries', () => {
  it('give every text of the dictionary arguments to be written with, and nothing else', () => {
    const functions = leaves(en)
      .filter(([, value]) => typeof value === 'function')
      .map(([path]) => path)
      .sort();

    assert.deepEqual(functions, Object.keys(SAMPLES).sort());
  });

  it('have the same keys both ways, each of the same kind, lists of the same length', () => {
    const shape = (m: Messages) =>
      leaves(m).map(([path, value]) => [
        path,
        typeof value === 'function' ? `function/${value.length}` : typeof value,
      ]);

    assert.deepEqual(shape(ru), shape(en));
    assert.equal(ru.months.length, 12);
    assert.equal(en.months.length, 12);
  });

  it('write no empty text, and no value left unwritten, in either language', () => {
    for (const m of [en, ru]) {
      for (const { path, text, args } of texts(m)) {
        assert.equal(typeof text, 'string', `${m.lang} ${path}`);
        assert.notEqual(text.trim(), '', `${m.lang} ${path}(${JSON.stringify(args)})`);
        assert.doesNotMatch(
          text,
          /undefined|NaN|\[object|\$\{/,
          `${m.lang} ${path}(${JSON.stringify(args)}): ${text}`,
        );
      }
    }
  });

  it('carry the same numbers and names in both languages', () => {
    const russian = new Map(
      texts(ru).map((entry) => [`${entry.path}${JSON.stringify(entry.args)}`, entry]),
    );

    for (const english of texts(en)) {
      const other = russian.get(`${english.path}${JSON.stringify(english.args)}`);

      assert.ok(other, english.path);

      for (const [index, arg] of english.args.entries()) {
        if (CHOICES.has(`${english.path}:${index}`)) {
          continue;
        }

        for (const said of [arg]
          .flat()
          .filter((part) => typeof part === 'string' || typeof part === 'number')
          .map(String)) {
          // Each writes a placeholder it was given, or neither does: a number
          // grouped as its language groups it is written by neither as given.
          assert.equal(
            other.text.includes(said),
            english.text.includes(said),
            `${english.path}(${JSON.stringify(english.args)}): «${english.text}» / «${other.text}»`,
          );
        }
      }
    }
  });

  it('keep in Russian no Latin word but the ones Decision 7 keeps', () => {
    for (const { path, text, args } of texts(ru)) {
      let own = text;

      for (const given of argumentTexts(args)) {
        own = own.replaceAll(given, '');
      }

      for (const word of own.match(/[A-Za-z]+/g) ?? []) {
        assert.ok(LATIN_IN_RUSSIAN.has(word), `ru ${path}: «${word}» in «${text}»`);
      }
    }
  });

  it('keep in English no Cyrillic letter', () => {
    for (const { path, text } of texts(en)) {
      assert.doesNotMatch(text, /[Ѐ-ӿ]/, `en ${path}`);
    }
  });

  it('write text handed in as given, replacement patterns and braces included', () => {
    const hostile = [
      '$&',
      '$`',
      "$'",
      '$1',
      '{query}',
      '${query}',
      '<b>&amp;</b>',
      'a'.repeat(10_000),
    ];

    for (const m of [en, ru]) {
      for (const [path, value] of leaves(m)) {
        if (typeof value !== 'function') {
          continue;
        }

        for (const args of SAMPLES[path] ?? []) {
          args.forEach((arg, index) => {
            if (typeof arg !== 'string' || CHOICES.has(`${path}:${index}`)) {
              return;
            }

            for (const text of hostile) {
              const changed = args.map((other, place) => (place === index ? text : other));
              const written = (value as (...args: unknown[]) => string)(...changed);

              assert.ok(written.includes(text), `${m.lang} ${path} with ${text.slice(0, 20)}`);
            }
          });
        }
      }
    }
  });

  it('join a number to its noun with a no-break space in Russian, in the form the number asks for', () => {
    const forms = new Map([
      [0, 'запросов'],
      [1, 'запрос'],
      [2, 'запроса'],
      [4, 'запроса'],
      [5, 'запросов'],
      [11, 'запросов'],
      [12, 'запросов'],
      [14, 'запросов'],
      [21, 'запрос'],
      [22, 'запроса'],
      [25, 'запросов'],
      [101, 'запрос'],
      [111, 'запросов'],
      [1000, 'запросов'],
    ]);

    for (const [count, noun] of forms) {
      assert.equal(ru.home.requests(count), `${count}${NBSP}${noun}`);
    }

    assert.equal(ru.home.sessions(3), `3${NBSP}сессии`);
    assert.equal(ru.landing.stepsCount(3), `3${NBSP}шага`);
    assert.equal(ru.response.headers(5), `5${NBSP}заголовков`);
    assert.equal(ru.push.arrived(1), `1${NBSP}новый`);
    // The glossary's `N / 1000 запросов`: the noun agrees with the limit.
    assert.equal(ru.list.limitSuffix(1000), `${NBSP}запросов`);
    // English is unchanged: a plain space and an `s`.
    assert.equal(en.home.requests(1), '1 request');
    assert.equal(en.home.requests(0), '0 requests');
  });

  it('never throw on a count that is no count, in either language', () => {
    for (const value of [Number.NaN, -1, -2, -5, 1.5, Number.MAX_SAFE_INTEGER, Infinity]) {
      for (const m of [en, ru]) {
        assert.equal(typeof m.home.requests(value), 'string');
        assert.equal(typeof m.home.sessions(value), 'string');
        assert.equal(typeof m.lifetime.retention(value), 'string');
        assert.equal(typeof m.number(value), 'string');
      }
    }

    // A fraction and NaN take the genitive singular; MAX_SAFE_INTEGER ends in 1.
    assert.equal(ru.home.requests(1.5), `1.5${NBSP}запроса`);
    assert.equal(ru.home.requests(Number.MAX_SAFE_INTEGER), `9007199254740991${NBSP}запрос`);
    assert.equal(ru.home.requests(-2), `-2${NBSP}запроса`);
  });

  it('group numbers as each language does', () => {
    assert.equal(en.number(65536), '65,536');
    assert.equal(ru.number(65536), `65${NBSP}536`);
    assert.equal(ru.number(1234567.5), `1${NBSP}234${NBSP}567,5`);
    assert.equal(ru.number(0.5), '0,5');
    assert.equal(ru.number(-1000), `-1${NBSP}000`);
    assert.equal(ru.number(Number.NaN), 'NaN');
    assert.equal(ru.signature.bytes(2048), `2${NBSP}048${NBSP}байт`);
    assert.equal(ru.quick.delayChip(500), `0,5${NBSP}с`);
    assert.equal(en.quick.delayChip(500), '0.5 s');
  });
});

describe('the Russian wording the owner approved (glossary `792:57` and the frames)', () => {
  it('names the header, the footer band and the home page as the frames draw them', () => {
    assert.deepEqual(
      [ru.header.changelog, ru.header.status, ru.header.apiDocs],
      ['Изменения', 'Статус', 'API docs'],
    );
    assert.deepEqual(
      [ru.footer.about, ru.footer.terms, ru.footer.privacy, ru.footer.contact],
      ['О сервисе', 'Условия', 'Конфиденциальность', 'Почта:'],
    );
    assert.equal(
      ru.footer.line,
      `Запросы — заголовки, тело и IP отправителя — хранятся, пока вы их не удалите или сессия не истечёт (до 7${NBSP}дней простоя); в копиях — ещё до 3${NBSP}дней.`,
    );
    assert.equal(ru.landing.eyebrow, 'ПРОВЕРКА ВЕБХУКОВ');
    assert.equal(ru.landing.heading, 'Проверяйте вебхуки мгновенно.');
    assert.equal(ru.landing.generate, 'Создать адрес');
    assert.equal(ru.landing.steps[0]?.title, 'Создайте адрес');
    assert.equal(ru.landing.stepsTitle, 'Как это работает');
  });

  it('names the new session’s options as the approved frames do (#216)', () => {
    assert.equal(ru.newSession.expiresTitle, 'Истекает после простоя');
    assert.deepEqual(
      [ru.newSession.days(7), ru.newSession.days(1), ru.newSession.hours(1)],
      [`7${NBSP}дней`, `1${NBSP}день`, `1${NBSP}час`],
    );
    assert.deepEqual(
      [ru.newSession.ipStored, ru.newSession.ipNotStored, ru.newSession.storeIp],
      ['IP сохраняется', 'IP не сохраняется', 'Сохранять IP отправителя'],
    );
    assert.equal(ru.newSession.hintHours(1), `— истекает через 1${NBSP}час простоя`);
    assert.deepEqual(
      [
        en.newSession.expiresTitle,
        en.newSession.days(7),
        en.newSession.days(1),
        en.newSession.hours(1),
      ],
      ['Expires after last use', '7 days', '1 day', '1 hour'],
    );
    assert.deepEqual(
      [en.newSession.ipStored, en.newSession.ipNotStored, en.newSession.storeIp],
      ['IP stored', 'IP not stored', "Store the sender's IP"],
    );
    assert.equal(en.newSession.hintHours(1), '— expires 1 hour after last use');
  });

  /** Issue #228's design (R1-R8) and the Russian wording its rules give (D259). */
  it('names a private session’s controls as #228 does, in both languages', () => {
    assert.deepEqual(
      [
        en.newSession.privateSession,
        en.newSession.privateHint,
        en.lifetime.private,
        en.access.mark,
        en.access.copyReceiveUrl,
        en.access.copyReceiveUrlHint,
        en.access.copyLink,
        en.access.copyLinkHint,
        en.access.linkCopied,
        en.access.removeTitle,
        en.access.removeDescription,
        en.access.openWith,
        en.access.pasteHint,
        en.access.open,
        en.access.pasteFailed,
        en.actions.copyLink,
      ],
      [
        'Private session',
        'Opens only with its link with access',
        'PRIVATE',
        'Private session',
        'Copy receive URL',
        'For the sender: it only receives requests',
        'Copy link with access',
        'For a colleague: opens this session',
        'Link with access copied',
        'Remove this private session from the list?',
        'Only this browser holds its key. The session itself is not deleted, but once it leaves the list it opens only with its link with access. Copy the link first if you may need it.',
        'Open with a link with access or a key…',
        'Have a link with access or a key? Paste either one to open the session.',
        'Open',
        'Nothing opened: this is not a link with access or a key of a session that exists.',
        'Copy link',
      ],
    );
    assert.deepEqual(
      [
        ru.newSession.privateSession,
        ru.newSession.privateHint,
        ru.lifetime.private,
        ru.access.mark,
        ru.access.copyReceiveUrl,
        ru.access.copyReceiveUrlHint,
        ru.access.copyLink,
        ru.access.copyLinkHint,
        ru.access.linkCopied,
        ru.access.removeTitle,
        ru.access.removeDescription,
        ru.common.cancel,
        ru.sessions.removeFromList,
        ru.access.openWith,
        ru.access.pasteHint,
        ru.access.open,
        ru.access.pasteFailed,
      ],
      [
        'Приватная сессия',
        'Открывается только по ссылке с доступом',
        'ПРИВАТНАЯ',
        'Приватная сессия',
        'Копировать адрес для приёма',
        'Для отправителя: только принимает запросы',
        'Копировать ссылку с доступом',
        'Для коллеги: открывает эту сессию',
        'Ссылка с доступом скопирована',
        'Убрать приватную сессию из списка?',
        'Ключ к ней есть только в этом браузере. Сама сессия не удаляется, но после удаления из списка открыть её можно будет только по ссылке с доступом. Скопируйте ссылку, если она может понадобиться.',
        'Отмена',
        'Убрать из списка',
        'Открыть по ссылке с доступом или ключу…',
        'Есть ссылка с доступом или ключ? Вставьте любой из них, чтобы открыть сессию.',
        'Открыть',
        'Ничего не открылось: это не ссылка с доступом и не ключ существующей сессии.',
      ],
    );
  });

  it('words the move banner and its toast as the issue gives them (issue #321, C1 and T)', () => {
    assert.equal(
      en.move.notice('webhook.qa-tools.ru', '9 Mar 2027'),
      'Webhook Inspector is moving to webhook.qa-tools.ru on 9 Mar 2027',
    );
    assert.equal(
      ru.move.notice('webhook.qa-tools.ru', '9 мар. 2027'),
      'Webhook Inspector переезжает на webhook.qa-tools.ru 9 мар. 2027',
    );
    // The page closes the action with a drawn `→`.
    assert.equal(en.move.action, 'Move with my sessions');
    assert.equal(ru.move.action, 'Перейти со своими сессиями');
    assert.equal(
      en.move.arrived(5, 2, 'qa-tools.ru'),
      'Moved 5 sessions from qa-tools.ru, 2 of them private',
    );
    assert.equal(
      ru.move.arrived(5, 2, 'qa-tools.ru'),
      `Перенесено 5${NBSP}сессий с qa-tools.ru, из них 2${NBSP}приватные`,
    );
  });

  it('names the session page as the glossary does', () => {
    assert.equal(ru.endpoint.receiveUrl, 'АДРЕС ДЛЯ ПРИЁМА');
    assert.equal(sessionRetentionLine(ru), `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 7${NBSP}ДНЕЙ ПРОСТОЯ`);
    assert.equal(sessionRetentionLine(en), 'SESSION EXPIRES 7 DAYS AFTER LAST USE');
    // The other rules a session can follow (D249) and the address it keeps not.
    assert.equal(ru.lifetime.retention(1), `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 1${NBSP}ДЕНЬ ПРОСТОЯ`);
    assert.equal(ru.lifetime.retentionHours(1), `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ 1${NBSP}ЧАС ПРОСТОЯ`);
    assert.equal(en.lifetime.retention(1), 'SESSION EXPIRES 1 DAY AFTER LAST USE');
    assert.equal(en.lifetime.retentionHours(1), 'SESSION EXPIRES 1 HOUR AFTER LAST USE');
    assert.equal(
      ru.lifetime.retentionUntil(26, 'СЕНТ.', null, '11:50'),
      'СЕССИЯ ИСТЕКАЕТ 26 СЕНТ. В 11:50',
    );
    assert.equal(
      en.lifetime.retentionUntil(26, 'SEP', null, '11:50'),
      'SESSION EXPIRES 26 SEP AT 11:50',
    );
    assert.equal(ru.lifetime.ipNotStored, 'IP НЕ СОХРАНЯЕТСЯ');
    assert.equal(ru.record.ipNotStored, 'IP не сохраняется');
    assert.equal(ru.record.noAddress, 'IP недоступен');
    assert.deepEqual(
      [ru.copy.copy, ru.copy.copied, ru.list.heading, ru.deleteAll.button, ru.actions.menu],
      ['Копировать', 'Скопировано', 'Запросы', 'Удалить все', 'Действия'],
    );
    assert.deepEqual(
      [ru.actions.copyLink, ru.actions.copyCurl, ru.actions.downloadJson, ru.actions.compare],
      ['Копировать ссылку', 'Копировать как cURL', 'Скачать JSON', 'Сравнить с…'],
    );
    assert.equal(ru.signature.title, 'Проверить подпись');
    assert.equal(ru.queue.title, 'Очередь ответов');
    assert.equal(ru.list.newestOnTop, 'Новые запросы появляются сверху.');
    assert.equal(ru.response.default, 'По умолчанию');
    assert.equal(ru.response.custom, 'Свой');
    assert.equal(ru.response.queued(6), `6${NBSP}в очереди`);
    assert.equal(ru.sessions.deleteSession, 'Удалить сессию…');
    assert.equal(ru.home.deleteButton, 'Удалить сессию');
  });

  it('names the response rules in the glossary’s words, the method and the path as given (#226)', () => {
    assert.deepEqual(
      [ru.rules.title, ru.rules.setUp, ru.rules.edit, ru.rules.removeRules, ru.rules.save],
      [
        'Правила ответа',
        'Настроить правила…',
        'Изменить правила…',
        'Удалить правила',
        'Сохранить правила',
      ],
    );
    assert.equal(ru.record.rule(1, 'POST', '/orders'), 'Правило 1 · POST /orders');
    assert.equal(ru.record.rule(3, null, '/items/*'), 'Правило 3 · Любой /items/*');
    assert.equal(en.record.rule(3, null, '/items/*'), 'Rule 3 · Any /items/*');
    assert.equal(ru.rules.count(1), `1${NBSP}правило`);
    assert.equal(ru.rules.count(3), `3${NBSP}правила`);
    assert.equal(ru.rules.count(20), `20${NBSP}правил`);
    assert.equal(ru.rules.count(21), `21${NBSP}правило`);
    assert.equal(en.rules.count(1), '1 rule');
    assert.equal(en.rules.count(3), '3 rules');
    // Every place a list of 20 holds has its word, in both languages.
    for (let place = 1; place <= 20; place += 1) {
      assert.doesNotMatch(en.rules.checked(place), /\d/, `en ${place}`);
      assert.doesNotMatch(ru.rules.checked(place), /\d/, `ru ${place}`);
    }
    assert.equal(en.rules.checked(2), 'checked second');
    assert.equal(ru.rules.checked(2), 'проверяется вторым');
  });

  it('marks a row a rule answered as the approved frames do, П2 and Ответило правило 2 (#233)', () => {
    assert.equal(ru.list.ruleMarker(2), 'П2');
    assert.equal(ru.list.answeredByRule(2), 'Ответило правило 2');
    assert.equal(ru.list.ruleMarker(20), 'П20');
    assert.equal(en.list.ruleMarker(2), 'R2');
    assert.equal(en.list.answeredByRule(20), 'Answered by rule 20');
  });

  it('says the response templates as the approved frames and their notes do (#236)', () => {
    assert.deepEqual(
      [en.template.fill, en.template.insert, en.template.tag],
      ['Fill in placeholders from the request', 'Insert placeholder', 'Template'],
    );
    assert.deepEqual(
      [ru.template.fill, ru.template.insert, ru.template.tag],
      ['Подставлять значения из запроса', 'Вставить подстановку', 'Шаблон'],
    );
    assert.equal(
      en.template.hint('{{request.id}}'),
      'Placeholders like {{request.id}} are replaced with values of the captured request.',
    );
    assert.equal(
      ru.template.hint('{{request.id}}'),
      'Подстановки вида {{request.id}} заменяются значениями принятого запроса.',
    );
    assert.deepEqual(
      [en.template.requestId, en.template.method, en.template.path],
      ['Request id', 'Method', 'Path'],
    );
    // The application's own word, over `ID запроса` (the issue's decision).
    assert.deepEqual(
      [ru.template.requestId, ru.template.method, ru.template.path],
      ['Идентификатор запроса', 'Метод', 'Путь'],
    );
    assert.deepEqual(
      [en.template.query, en.template.header, en.template.body],
      ['Query parameter…', 'Header…', 'JSON body field…'],
    );
    assert.deepEqual(
      [ru.template.query, ru.template.header, ru.template.body],
      ['Параметр запроса…', 'Заголовок…', 'Поле JSON-тела…'],
    );
    assert.equal(en.template.unknown('{{request.foo}}'), 'Unknown placeholder {{request.foo}}.');
    assert.equal(
      ru.template.unknown('{{request.foo}}'),
      'Неизвестная подстановка {{request.foo}}.',
    );
    assert.equal(
      en.template.finish('{{request.header.}}', 'name'),
      'Finish {{request.header.}}: type the name before }}.',
    );
    assert.equal(
      ru.template.finish('{{request.header.}}', 'name'),
      'Допишите {{request.header.}}: имя перед }}.',
    );
    assert.equal(
      en.template.finish('{{request.body.}}', 'path'),
      'Finish {{request.body.}}: type the field path before }}.',
    );
    assert.equal(
      ru.template.finish('{{request.body.}}', 'path'),
      'Допишите {{request.body.}}: путь к полю перед }}.',
    );
    assert.equal(en.template.unclosed, 'A placeholder is not closed: {{ without }}.');
    assert.equal(ru.template.unclosed, 'Подстановка не закрыта: {{ без }}.');
  });

  it('leads the server’s own English diagnostic with Russian words (Decision 6)', () => {
    const message = 'response.headers[3] name must be an HTTP token';

    assert.equal(ru.editor.rejected(message), `Сервер отклонил эту настройку: ${message}`);
    assert.equal(ru.queue.rejected(message), `Сервер отклонил эту очередь: ${message}`);
    assert.equal(ru.rules.rejected(message), `Сервер отклонил эти правила: ${message}`);
  });

  it('names the rule or the step a refusal is placed at, counted from 1 (D257)', () => {
    const message = 'rules[1] may contain no key other than "method", "path" and "response"';

    assert.equal(
      en.rules.rejectedRule(2),
      'The server rejected rule 2. Fix the marked field and save again.',
    );
    assert.equal(
      ru.rules.rejectedRule(2),
      'Сервер отклонил правило 2. Исправьте отмеченное поле и сохраните снова.',
    );
    assert.equal(
      en.rules.rejectedRuleWithReason(2, message),
      `The server rejected rule 2: ${message}`,
    );
    assert.equal(
      ru.rules.rejectedRuleWithReason(2, message),
      `Сервер отклонил правило 2: ${message}`,
    );
    assert.equal(
      en.queue.rejectedStep(2),
      'The server rejected step 2. Fix the marked field and save again.',
    );
    assert.equal(
      ru.queue.rejectedStep(2),
      'Сервер отклонил шаг 2. Исправьте отмеченное поле и сохраните снова.',
    );
    assert.equal(
      en.queue.rejectedStepWithReason(2, message),
      `The server rejected step 2: ${message}`,
    );
    assert.equal(ru.queue.rejectedStepWithReason(2, message), `Сервер отклонил шаг 2: ${message}`);
  });
});

describe('times in Russian (Decision 5)', () => {
  const instant = '2026-09-17T14:32:06Z';

  it('write the detail panel’s time with the genitive month, and keep the list row’s', () => {
    assert.equal(formatDetailTimestamp(instant, 'UTC', ru), '17 сент. 2026, 14:32:06');
    assert.equal(formatDetailTimestamp(instant, 'UTC', en), '17 Sep 2026, 14:32:06');
    assert.equal(formatDetailTimestamp('2026-05-05T00:02:06Z', 'UTC', ru), '5 мая 2026, 00:02:06');
    assert.equal(formatTimestamp(instant, 'UTC'), '2026-09-17 14:32:06');
  });

  it('use the table ICU gives for Russian, month by month', () => {
    assert.deepEqual(ru.months, [
      'янв.',
      'февр.',
      'мар.',
      'апр.',
      'мая',
      'июн.',
      'июл.',
      'авг.',
      'сент.',
      'окт.',
      'нояб.',
      'дек.',
    ]);

    for (const [index, month] of ru.months.entries()) {
      const date = `2026-${String(index + 1).padStart(2, '0')}-17T12:00:00Z`;

      assert.equal(formatDetailTimestamp(date, 'UTC', ru), `17 ${month} 2026, 12:00:00`);
    }
  });

  it('meet an invalid time and the last day a Date holds as English does', () => {
    assert.throws(() => formatDetailTimestamp('not a time', 'UTC', ru), RangeError);
    assert.throws(() => formatDetailTimestamp('not a time', 'UTC', en), RangeError);
    assert.equal(
      formatDetailTimestamp('+275760-09-13T00:00:00Z', 'UTC', ru),
      '13 сент. 275760, 00:00:00',
    );
  });

  it('head the home page’s days with the same month, and count their sessions', () => {
    const at = Date.parse('2026-10-03T12:00:00Z');
    const [day] = groupByDay([{ at }, { at }, { at }], 'UTC', ru);

    assert.equal(day?.label, '3 окт. 2026');
    assert.equal(day?.count, `3${NBSP}сессии`);
    assert.equal(groupByDay([{ at }], 'UTC', en)[0]?.label, '3 Oct 2026');
    assert.deepEqual(formatRowMeta({ requestsCount: 0, lastRequestAt: null }, 'UTC', ru), {
      count: `0${NBSP}запросов`,
      last: 'запросов пока нет',
    });
    assert.deepEqual(formatListCount(5, 12, ru), {
      text: `5 из 12${NBSP}сессий в этом браузере`,
      showAll: true,
    });
  });

  it('title the tab in the language shown, the unread count first', () => {
    assert.equal(formatDocumentTitle(0, ru), 'Webhook Inspector — проверка вебхуков');
    assert.equal(formatDocumentTitle(5, ru), '(5) Webhook Inspector — проверка вебхуков');
    assert.equal(formatDocumentTitle(0, en), 'Webhook Inspector');
    assert.equal(formatDocumentTitle(5, en), '(5) Webhook Inspector');
  });
});

describe('which language a page opens in', () => {
  it('takes the first Russian or English entry of the browser’s languages, else English', () => {
    assert.equal(browserLanguage(['ru-RU', 'en-US']), 'ru');
    assert.equal(browserLanguage(['en-US', 'ru-RU']), 'en');
    assert.equal(browserLanguage(['de-DE', 'ru']), 'ru');
    assert.equal(browserLanguage(['de-DE']), 'en');
    assert.equal(browserLanguage(['de-DE', 'fr-FR', 'uk-UA']), 'en');
    assert.equal(browserLanguage([]), 'en');
  });

  it('reads a tag by its primary subtag, case aside, and nothing else as a language', () => {
    for (const tag of ['ru', 'RU', 'ru-RU', 'Ru-ru', 'ru-RU-x-priv', 'ru_RU']) {
      assert.equal(languageOfTag(tag), 'ru', tag);
    }

    for (const tag of ['en', 'en-GB', 'EN-us']) {
      assert.equal(languageOfTag(tag), 'en', tag);
    }

    for (const tag of ['', '*', 'rus', 'eng', 'r', 'ru1', '-ru', ' ru', 'de-DE', null, 7, {}, []]) {
      assert.equal(languageOfTag(tag), null, String(tag));
    }

    assert.equal(browserLanguage(['', '*', 'ru-RU-x-priv']), 'ru');
  });

  it('falls back to navigator.language, and to English, where the list is missing, empty or not a list', () => {
    assert.equal(browserLanguage(undefined, 'ru-RU'), 'ru');
    assert.equal(browserLanguage([], 'ru-RU'), 'ru');
    assert.equal(browserLanguage(['de-DE'], 'ru-RU'), 'en');
    assert.equal(browserLanguage(undefined), 'en');
    assert.equal(browserLanguage(null, null), 'en');
    assert.equal(browserLanguage('ru-RU'), 'en');
    assert.equal(browserLanguage({ length: 1, 0: 'ru' }), 'en');
  });

  it('finds the first matching entry among a thousand', () => {
    const many = Array.from({ length: 1000 }, (_unused, index) => (index === 999 ? 'ru' : 'de'));

    assert.equal(browserLanguage(many), 'ru');
    assert.equal(browserLanguage(['en', ...many]), 'en');
  });

  it('lets a stored choice win, and counts anything else stored as no choice', () => {
    const stored = (raw: string | null) => ({ getItem: () => raw });

    assert.equal(initialLanguage(stored('{"v":1,"lang":"ru"}'), { languages: ['en-US'] }), 'ru');
    assert.equal(initialLanguage(stored('{"v":1,"lang":"en"}'), { languages: ['ru-RU'] }), 'en');
    assert.equal(initialLanguage(stored(null), { languages: ['ru-RU'] }), 'ru');
    assert.equal(initialLanguage(null, undefined), 'en');

    for (const raw of [
      'xx',
      '',
      'ru',
      '"ru"',
      '__proto__',
      'constructor',
      'toString',
      'null',
      '[1]',
      '{}',
      '{"v":2,"lang":"ru"}',
      '{"v":"1","lang":"ru"}',
      '{"v":1,"lang":"de"}',
      '{"v":1,"lang":"RU"}',
      '{"v":1,"lang":"__proto__"}',
      '{"v":1,"lang":"constructor"}',
      '{"__proto__":{"v":1,"lang":"ru"}}',
      '{"v":1,"lang":["ru"]}',
      '{"v":1,"lang":"ru"',
      `{"v":1,"lang":"ru","pad":"${'x'.repeat(100)}"}`,
      'x'.repeat(1024 * 1024),
      `{"v":1,"lang":"${'r'.repeat(1024 * 1024)}"}`,
    ]) {
      assert.equal(readStoredLanguage(stored(raw)), null, raw.slice(0, 40));
      assert.equal(initialLanguage(stored(raw), { languages: ['ru-RU'] }), 'ru', raw.slice(0, 40));
    }
  });

  it('reads storage that throws, or answers what is no string, as no choice, with no error', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };

    assert.equal(readStoredLanguage(throwing), null);
    assert.equal(readStoredLanguage(null), null);
    assert.equal(readStoredLanguage({ getItem: () => 7 as unknown as string }), null);
    assert.equal(initialLanguage(throwing, { languages: ['ru'] }), 'ru');
  });

  it('remembers a choice as {"v":1,"lang":…}, and storage that refuses keeps nothing, with no error', () => {
    const written = new Map<string, string>();
    const storage = {
      getItem: (key: string) => written.get(key) ?? null,
      setItem: (key: string, value: string) => void written.set(key, value),
    };

    storeLanguage(storage, 'ru');
    assert.equal(written.get('qa-tools:language'), '{"v":1,"lang":"ru"}');
    assert.equal(readStoredLanguage(storage), 'ru');
    storeLanguage(storage, 'en');
    assert.equal(readStoredLanguage(storage), 'en');
    assert.equal(LANGUAGE_KEY, 'qa-tools:language');

    assert.doesNotThrow(() =>
      storeLanguage(
        {
          setItem: () => {
            throw new Error('QuotaExceededError');
          },
        },
        'ru',
      ),
    );
    assert.doesNotThrow(() => storeLanguage(null, 'ru'));
  });

  /**
   * Issue #109, D226: `/ru/` is always Russian, whatever is stored or asked
   * for; `/` follows the rule above. The stored values of the attack list,
   * and storage that throws, on both home pages.
   */
  it('opens the Russian home page in Russian whatever is stored, and / by the rule above', () => {
    const stored = (raw: string | null) => ({ getItem: () => raw });
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    const english = { languages: ['en-US'] };
    const values: [raw: string | null, chosen: 'en' | 'ru' | null][] = [
      ['{"v":1,"lang":"ru"}', 'ru'],
      ['{"v":1,"lang":"en"}', 'en'],
      ['ru', null],
      ['en', null],
      ['RU', null],
      ['"ru"', null],
      ['de', null],
      ['{"v":1,"lang":"de"}', null],
      ['{"v":1,"lang":"RU"}', null],
      ['', null],
      [null, null],
      ['x'.repeat(1024 * 1024), null],
    ];

    for (const [raw, chosen] of values) {
      const label = String(raw).slice(0, 30);

      assert.equal(initialLanguage(stored(raw), english, fixedLanguage('/ru/')), 'ru', label);
      assert.equal(initialLanguage(stored(raw), english, fixedLanguage('/ru')), 'ru', label);
      assert.equal(
        initialLanguage(stored(raw), english, fixedLanguage('/')),
        chosen ?? 'en',
        label,
      );
      assert.equal(
        initialLanguage(stored(raw), { languages: ['ru-RU'] }, fixedLanguage('/')),
        chosen ?? 'ru',
        label,
      );
    }

    assert.equal(initialLanguage(throwing, english, fixedLanguage('/ru/')), 'ru');
    assert.equal(initialLanguage(null, english, fixedLanguage('/ru/')), 'ru');
    assert.equal(initialLanguage(throwing, english, fixedLanguage('/')), 'en');
    // Only the Russian home page fixes a language: not a session page, not an
    // address beside /ru/.
    for (const path of ['/v/G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA', '/RU/', '/ru/x']) {
      assert.equal(initialLanguage(stored(null), english, fixedLanguage(path)), 'en', path);
    }
  });

  it('offers English and Russian, each with its tag for <html lang>', () => {
    assert.deepEqual(LANGUAGES, ['en', 'ru']);
    assert.equal(MESSAGES.en, en);
    assert.equal(MESSAGES.ru, ru);
    assert.equal(MESSAGES.en.lang, 'en');
    assert.equal(MESSAGES.ru.lang, 'ru');
  });
});

describe('where the language is decided and kept (structural guards)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('is decided before the first render, and <html lang> set with it', () => {
    const main = read('../main.tsx');
    const decided = main.indexOf(
      'initialLanguage(storage, navigator, fixedLanguage(window.location.pathname))',
    );
    const lang = main.indexOf('document.documentElement.lang = MESSAGES[language].lang;');
    const render = main.indexOf('createRoot(container).render(');

    assert.ok(decided > 0 && decided < lang && lang < render);
    assert.match(main, /<LanguageProvider initial=\{language\} storage=\{storage\}>/);
  });

  /**
   * The Russian home page's choice is stored by the provider's own
   * `setLanguage`, before the next paint, whenever the address fixes it
   * (D226); the switch leads to the paired home page through `switchAddress`,
   * after storing the choice; and the wordmark leads to the language's own
   * home page. Each rule is unit-tested in `not-found.test.ts`.
   */
  it('stores what /ru/ fixes, leads the switch between the home pages, and takes the wordmark home', () => {
    const app = read('../App.tsx');
    const choice = read('../components/LanguageSwitch.tsx');
    const header = read('../components/AppHeader.tsx');

    assert.match(
      app,
      /useLayoutEffect\(\(\) => \{\n\s*if \(fixed !== null\) \{\n\s*setLanguage\(fixed\);\n\s*\}\n\s*\}, \[fixed, setLanguage\]\);/,
    );
    assert.match(
      choice,
      /const target = switchAddress\(pathname, code\);\n\n\s*setLanguage\(code\);\n\n\s*if \(target !== null\) \{\n\s*void navigate\(target\);/,
    );
    assert.match(choice, /onClick=\{\(\) => choose\(code\)\}/);
    assert.match(header, /<Link\n\s*to=\{homeAddress\(m\.lang\)\}/);
  });

  it('is named by the Privacy Policy among what the browser keeps (Decision 2)', () => {
    const section = PRIVACY_PAGE.sections.find((entry) => entry.label === 'In your browser');
    const lines = section?.lines.filter((line): line is string => typeof line === 'string') ?? [];

    assert.ok(lines.some((line) => line.includes('the interface language you\u00a0chose')));
  });

  /**
   * Amended by D255 (issue #170): `/ru/about` draws the header and the band
   * in Russian, so `site-chrome.mjs` and `about.mjs` now read Russian; every
   * English static page is still drawn in English alone, and the changelog
   * and the legal pages read no Russian at all (#237 brings theirs).
   */
  it('leaves the English static pages English: only /ru/about draws Russian', () => {
    for (const script of ['legal.mjs', 'changelog.mjs']) {
      assert.doesNotMatch(
        read(`../../scripts/${script}`),
        /i18n\/ru|about-copy-ru|from '\.\/ru/,
        script,
      );
    }

    const cyrillic = /[\u0400-\u04ff]/;

    for (const page of ['/changelog', '/about', '/terms', '/privacy']) {
      assert.doesNotMatch(siteHeader(page), cyrillic, page);
      assert.doesNotMatch(siteFooter(page), cyrillic, page);
    }

    assert.doesNotMatch(renderAboutBody(), cyrillic);
    assert.match(siteHeader('/ru/about', 'ru'), cyrillic);
    assert.match(siteFooter('/ru/about', 'ru'), cyrillic);
  });
});
