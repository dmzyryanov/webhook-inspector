import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  ErrorCode,
  MAX_RESPONSE_RULES,
  RESPONSE_RULE_METHODS,
  type ResponseConfig,
  type ResponseRule,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import { DEFAULT_RESPONSE_FORM, formFromResponse } from './response-config.ts';
import {
  addRule,
  asksToRemoveRules,
  canRemoveRules,
  describeRuleRow,
  describeRulesFailure,
  duplicateRule,
  editRulesDraft,
  evaluateRules,
  formatRuleMethod,
  formatRulesCount,
  formatRulesFallback,
  formatRulesSavedToast,
  formatRulesSuffix,
  formFromRule,
  heldRules,
  MAX_TYPED_METHOD_LENGTH,
  moveRule,
  newRuleForm,
  OTHER_RULE_METHODS,
  placeRulesRefusal,
  removeRule,
  rowUnderPointer,
  RULE_EXAMPLE_CHIPS,
  RULE_METHOD_CHIPS,
  ruleMethodValue,
  rulePathWarning,
  rulesDialogForms,
  rulesErrorsWithRefusal,
  rulesFailureAfterEdit,
  rulesFooterView,
  rulesSectionFocusTarget,
  rulesSectionRemoval,
  rulesSectionRow,
  rulesSectionView,
  selectionAfterMove,
  shownRulesFailure,
  validateRuleMethod,
  validateRulePath,
  type RuleForm,
} from './response-rules.ts';
import { formatRecordedRule } from './response-summary.ts';

/**
 * The response rules in the interface (issue #226 over D246): the quick
 * switch's section, the label, the Response rules dialog - its list, its
 * order, its checks mirroring the API's, its footer and its failures - and
 * the rule tag of the Response tab. Made-up input built to break the path
 * and the method checks, at growing sizes, is answered here at once.
 */

function response(overrides: Partial<ResponseConfig> = {}): ResponseConfig {
  return { status: 200, headers: [], body: null, delayMs: 0, template: false, ...overrides };
}

function rule(method: string | null, path: string, overrides: Partial<ResponseConfig> = {}) {
  return { method, path, response: response(overrides) } satisfies ResponseRule;
}

const ORDERS = rule('POST', '/orders', { status: 201, body: '{"id":"ord_1"}' });
const STATUS = rule('GET', '/status', { status: 200, body: '{"ok":true}' });
const ITEMS = rule(null, '/items/*', { status: 404, delayMs: 2000 });

function stateOf(
  rules: ResponseRule[] | undefined,
  overrides: Partial<SessionResponseState> = {},
): SessionResponseState {
  return {
    response: response({ status: 200 }),
    customResponse: response({ status: 200 }),
    queue: null,
    ...(rules === undefined ? {} : { rules }),
    ...overrides,
  } as SessionResponseState;
}

function form(overrides: Partial<RuleForm> = {}): RuleForm {
  return { ...newRuleForm(null), ...overrides };
}

describe('the rules a session holds', () => {
  it('reads none for a state without rules, from a backend before 1.3.0, and for []', () => {
    assert.deepEqual(heldRules(stateOf(undefined)), []);
    assert.deepEqual(heldRules(stateOf([])), []);
    assert.deepEqual(heldRules(stateOf([ORDERS])), [ORDERS]);
  });

  it('adds `3 rules` to the label, `1 rule` for one, nothing for none', () => {
    assert.equal(formatRulesSuffix([]), null);
    assert.equal(formatRulesSuffix([ORDERS]), '1 rule');
    assert.equal(formatRulesSuffix([ORDERS, STATUS, ITEMS]), '3 rules');
    assert.equal(formatRulesSuffix([ORDERS, STATUS, ITEMS], ru), '3\u00a0правила');
  });

  it('writes any method as Any, in the language shown', () => {
    assert.equal(formatRuleMethod(null), 'Any');
    assert.equal(formatRuleMethod(null, ru), 'Любой');
    assert.equal(formatRuleMethod('M-SEARCH'), 'M-SEARCH');
  });
});

describe('the quick switch section (R2, R3, R7)', () => {
  it('shows the examples and no rule while the session has none', () => {
    assert.deepEqual(rulesSectionView(stateOf([])), { kind: 'none' });
    assert.deepEqual(rulesSectionView(stateOf(undefined)), { kind: 'none' });
    assert.deepEqual(RULE_EXAMPLE_CHIPS, ['POST /orders', 'GET /status']);
  });

  it('lists the rules in order - number, method, path, status and delay - and what every other request gets (R7)', () => {
    const view = rulesSectionView(stateOf([ORDERS, STATUS, ITEMS]));

    assert.equal(view.kind, 'rules');
    assert.ok(view.kind === 'rules');
    assert.equal(view.count, '3 rules');
    assert.deepEqual(view.rows, [
      { place: 1, method: 'POST', any: false, path: '/orders', answer: '201', template: false },
      { place: 2, method: 'GET', any: false, path: '/status', answer: '200', template: false },
      {
        place: 3,
        method: 'Any',
        any: true,
        path: '/items/*',
        answer: '404 · 2 s',
        template: false,
      },
    ]);
    assert.equal(view.fallback, 'Every other request → the session response.');
  });

  it('names the queue in the fallback while it has steps left, and not once used up', () => {
    const queue = { steps: [response({ status: 503 })], next: 1, total: 1 };

    const fallback = (state: SessionResponseState) => {
      const view = rulesSectionView(state);

      return view.kind === 'rules' ? view.fallback : null;
    };

    assert.equal(
      fallback(stateOf([ORDERS], { queue })),
      'Every other request → the queue, then the session response.',
    );
    assert.equal(
      fallback(stateOf([ORDERS], { queue: { ...queue, next: null } })),
      'Every other request → the session response.',
    );
    assert.equal(
      formatRulesFallback(stateOf([], { queue })),
      '→ the queue, then the session response, Custom 200',
    );
    assert.equal(
      formatRulesFallback(stateOf([], { response: null })),
      '→ the session response, Default 200',
    );
  });

  it('says it in Russian', () => {
    const view = rulesSectionView(stateOf([ITEMS]), ru);

    assert.ok(view.kind === 'rules');
    assert.equal(view.count, '1\u00a0правило');
    assert.equal(view.rows[0]?.method, 'Любой');
    assert.equal(view.rows[0]?.answer, '404 · 2\u00a0с');
    assert.equal(view.fallback, 'Остальные запросы → ответ сессии.');
  });
});

describe('the dialog: the form a rule opens on, and what Save sends', () => {
  it('opens a rule on its method chip, Any, or Other with the method typed, and its path after the slash', () => {
    assert.deepEqual(formFromRule(ORDERS), {
      method: 'POST',
      otherMethod: '',
      path: 'orders',
      response: formFromResponse(ORDERS.response),
    });
    assert.equal(formFromRule(ITEMS).method, 'any');
    assert.equal(formFromRule(ITEMS).path, 'items/*');
    assert.deepEqual(
      [formFromRule(rule('OPTIONS', '/')).method, formFromRule(rule('OPTIONS', '/')).otherMethod],
      ['other', 'OPTIONS'],
    );
    assert.equal(formFromRule(rule('GET', '/')).path, '');
  });

  it('saves an untouched rule as it was: method, path and response', () => {
    for (const saved of [ORDERS, STATUS, ITEMS, rule('PROPFIND', '/a/'), rule('HEAD', '/')]) {
      const evaluation = evaluateRules([formFromRule(saved)]);

      assert.equal(evaluation.canSave, true, saved.path);
      assert.equal(evaluation.request?.rules[0]?.method, saved.method);
      assert.equal(evaluation.request?.rules[0]?.path, saved.path);
      assert.equal(evaluation.request?.rules[0]?.response.status, saved.response.status);
    }
  });

  it('sends the whole list in its order, none included (R4)', () => {
    const forms = [ORDERS, STATUS, ITEMS].map(formFromRule);
    const evaluation = evaluateRules(forms);

    assert.deepEqual(
      evaluation.request?.rules.map((sent) => [sent.method, sent.path, sent.response.status]),
      [
        ['POST', '/orders', 201],
        ['GET', '/status', 200],
        [null, '/items/*', 404],
      ],
    );
    assert.deepEqual(evaluation.request?.rules[0]?.response, {
      status: 201,
      body: '{"id":"ord_1"}',
    });
    assert.deepEqual(evaluateRules([]).request, { rules: [] });
    assert.equal(evaluateRules([]).canSave, true);
  });

  it('adds a rule for any method on the session URL with a copy of the session response, none past 20', () => {
    const added = addRule([], response({ status: 202, delayMs: 100 }));

    assert.deepEqual(added, [
      {
        method: 'any',
        otherMethod: '',
        path: '',
        response: formFromResponse(response({ status: 202, delayMs: 100 })),
      },
    ]);
    assert.deepEqual(addRule([], null)[0]?.response, DEFAULT_RESPONSE_FORM);
    assert.equal(evaluateRules(added).request?.rules[0]?.path, '/');

    const full = Array.from({ length: MAX_RESPONSE_RULES }, () => form());

    assert.equal(addRule(full, null).length, MAX_RESPONSE_RULES);
    assert.equal(duplicateRule(full, 0).length, MAX_RESPONSE_RULES);
    assert.equal(formatRulesCount(3), '3 / 20');
  });

  it('duplicates a rule right after it, its headers copied rather than shared, and removes one', () => {
    const first = form({
      method: 'POST',
      path: 'a',
      response: { ...DEFAULT_RESPONSE_FORM, headers: [{ name: 'X-A', value: '1' }] },
    });
    const second = form({ path: 'b' });
    const copied = duplicateRule([first, second], 0);

    assert.deepEqual(
      copied.map((each) => each.path),
      ['a', 'a', 'b'],
    );
    assert.notEqual(copied[1]?.response.headers, first.response.headers);
    assert.notEqual(copied[1]?.response.headers[0], first.response.headers[0]);
    assert.deepEqual(
      removeRule(copied, 1).map((each) => each.path),
      ['a', 'b'],
    );
    assert.deepEqual(duplicateRule([first], 5), [first]);
  });

  it('follows the session until the first edit, and keeps the viewer’s rules after it (D152)', () => {
    const before = stateOf([ORDERS]);
    const after = stateOf([ORDERS, STATUS]);

    assert.equal(rulesDialogForms(null, before).length, 1);
    assert.equal(rulesDialogForms(null, after).length, 2);

    const draft = editRulesDraft(null, before, (list) => removeRule(list, 0));

    assert.deepEqual(rulesDialogForms(draft, after), []);
  });
});

describe('a template kept through the rules dialog (D251, criterion 10)', () => {
  const TEMPLATE = rule('POST', '/orders', {
    status: 201,
    body: '{"order":"{{request.body.order.id}}"}',
    template: true,
  });

  it('saves the rules it opened on with their flags, moved, duplicated or not', () => {
    const forms = rulesDialogForms(null, stateOf([STATUS, TEMPLATE]));

    assert.deepEqual(
      evaluateRules(forms).request?.rules.map((sent) => sent.response.template ?? false),
      [false, true],
    );
    assert.deepEqual(evaluateRules(forms).request?.rules[1]?.response, {
      status: 201,
      body: '{"order":"{{request.body.order.id}}"}',
      template: true,
    });
    assert.deepEqual(
      evaluateRules(moveRule(forms, 1, 0)).request?.rules.map(
        (sent) => sent.response.template ?? false,
      ),
      [true, false],
    );
    assert.deepEqual(
      evaluateRules(duplicateRule(forms, 1)).request?.rules.map(
        (sent) => sent.response.template ?? false,
      ),
      [false, true, true],
    );
    assert.equal(evaluateRules(removeRule(forms, 0)).request?.rules[0]?.response.template, true);
  });

  it('adds a rule copying a templated session response, flag included', () => {
    const added = addRule([], TEMPLATE.response);

    assert.equal(added[0]?.response.template, true);
    assert.equal(evaluateRules(added).request?.rules[0]?.response.template, true);
  });
});

describe('the dialog: the order (R6)', () => {
  it('moves a rule to another place, the nearest end for a place outside, nothing from no rule', () => {
    const list = ['a', 'b', 'c', 'd'];

    assert.deepEqual(moveRule(list, 0, 2), ['b', 'c', 'a', 'd']);
    assert.deepEqual(moveRule(list, 3, 0), ['d', 'a', 'b', 'c']);
    assert.deepEqual(moveRule(list, 1, 1), list);
    assert.deepEqual(moveRule(list, 1, -5), ['b', 'a', 'c', 'd']);
    assert.deepEqual(moveRule(list, 1, 99), ['a', 'c', 'd', 'b']);
    assert.deepEqual(moveRule(list, 7, 0), list);
    assert.deepEqual(moveRule([], 0, 0), []);
  });

  it('keeps the selection on the rule it was on', () => {
    // The selected rule moved itself.
    assert.equal(selectionAfterMove(1, 1, 3, 4), 3);
    // Another rule moved past it, down then up.
    assert.equal(selectionAfterMove(2, 0, 3, 4), 1);
    assert.equal(selectionAfterMove(1, 3, 0, 4), 2);
    // Another rule moved on one side of it.
    assert.equal(selectionAfterMove(0, 2, 3, 4), 0);
    assert.equal(selectionAfterMove(null, 0, 1, 4), null);
  });

  it('finds the row under the pointer: the first whose bottom is below it, the ends past either end', () => {
    const rows = [
      { top: 100, bottom: 149 },
      { top: 153, bottom: 202 },
      { top: 206, bottom: 255 },
    ];

    assert.equal(rowUnderPointer(rows, 0), 0);
    assert.equal(rowUnderPointer(rows, 120), 0);
    assert.equal(rowUnderPointer(rows, 150), 1);
    assert.equal(rowUnderPointer(rows, 254), 2);
    assert.equal(rowUnderPointer(rows, 10_000), 2);
    assert.equal(rowUnderPointer([], 50), 0);
    assert.equal(rowUnderPointer(rows, Number.NaN), 2);
  });

  it('carries a dragged rule along every row it passes, as the dialog does on each move', () => {
    let list = ['a', 'b', 'c', 'd', 'e'];
    let at = 0;

    for (const target of [1, 2, 3, 4, 3]) {
      list = moveRule(list, at, target);
      at = target;
    }

    assert.deepEqual(list, ['b', 'c', 'd', 'a', 'e']);
  });
});

describe('the dialog: the checks, as the API makes them (D246 point 4)', () => {
  it('takes an exact path, a prefix ending in *, the session URL and the visible ASCII the API takes', () => {
    for (const typed of [
      '',
      'orders',
      'items/*',
      '*',
      'a/b/c/',
      '%6Frders',
      'a/../b',
      'a;v=1',
      '~!$&\'()+,=:@[]^_`{|}"<>\\',
    ]) {
      assert.equal(validateRulePath(typed), undefined, typed);
    }
  });

  it('refuses a path too long, a character no stored path holds, a ? and a * before the end', () => {
    assert.equal(validateRulePath('a'.repeat(1023)), undefined);
    assert.equal(validateRulePath('a'.repeat(1024)), 'The path is longer than 1,024 characters.');
    assert.equal(validateRulePath('a'.repeat(1024), ru), 'Путь длиннее 1\u00a0024 символов.');

    for (const typed of [
      'a b',
      'é',
      '\u0000',
      '\u007f',
      'a\tb',
      '\r\n',
      '😀',
      '\ud800',
      '\u00a0',
    ]) {
      assert.equal(validateRulePath(typed), en.rules.pathCharacters, JSON.stringify(typed));
    }

    assert.equal(validateRulePath('orders?x=1'), en.rules.pathQuery);
    assert.equal(validateRulePath('?'), en.rules.pathQuery);
    assert.equal(validateRulePath('items/*/x'), en.rules.pathStar);
    assert.equal(validateRulePath('**'), en.rules.pathStar);
    assert.equal(validateRulePath('*a'), en.rules.pathStar);
  });

  it('judges the length before a character is read, as the API does', () => {
    assert.equal(validateRulePath('é'.repeat(2000)), en.rules.pathTooLong('1,024'));
    assert.equal(validateRulePath('?'.repeat(1023)), en.rules.pathQuery);
  });

  it('answers made-up paths at growing sizes at once, without a value in its message', () => {
    const shapes = [
      (size: number) => '*'.repeat(size),
      (size: number) => '?'.repeat(size),
      (size: number) => '%'.repeat(size),
      (size: number) => '(a+)+$'.repeat(Math.ceil(size / 6)).slice(0, size),
      (size: number) => '\u0000'.repeat(size),
      (size: number) => 'é'.repeat(size),
      (size: number) => '\ud800'.repeat(size),
      (size: number) => 'a'.repeat(size - 1) + '?',
      (size: number) => 'a'.repeat(size - 1) + ' ',
      (size: number) => '/'.repeat(size),
    ];

    // Every refusal is one of four fixed texts: none quotes what was typed.
    const fixed = new Set([
      en.rules.pathTooLong('1,024'),
      en.rules.pathCharacters,
      en.rules.pathQuery,
      en.rules.pathStar,
      undefined,
    ]);

    for (const size of [1, 1024, 64 * 1024, 1024 * 1024]) {
      for (const shape of shapes) {
        const typed = shape(size);
        const started = performance.now();
        const said = validateRulePath(typed);
        const elapsed = performance.now() - started;

        assert.ok(elapsed < 500, `${elapsed.toFixed(1)} ms for ${size} characters`);
        assert.ok(fixed.has(said), `${size}: ${said}`);
        // Over the bound, only the length is said, whatever the rest holds.
        assert.equal(said === en.rules.pathTooLong('1,024'), size >= 1024, `${size}: ${said}`);
      }
    }
  });

  it('takes a / typed first and a full URL, as the API does, and says what each matches', () => {
    // Valid for the API, so Save takes them, but what they match is said at
    // the field: the field's own slash comes first, `/orders` saves
    // `//orders`, and a URL pasted whole is a path no sender calls.
    const typed = evaluateRules([
      form({ path: '/orders' }),
      form({ path: 'https://hook.qa-tools.ru/s/abc/orders' }),
    ]);

    assert.equal(typed.canSave, true);
    assert.deepEqual(
      typed.request?.rules.map((sent) => sent.path),
      ['//orders', '/https://hook.qa-tools.ru/s/abc/orders'],
    );
    assert.equal(describeRuleRow(form({ path: '/orders' }), { response: {} }).path, '//orders');

    for (const leading of ['/orders', '/', '//', '/s/abc/orders', '/https://x', '/*']) {
      assert.equal(validateRulePath(leading), undefined, leading);
      assert.equal(rulePathWarning(leading), en.rules.pathLeadingSlash, leading);
      assert.equal(rulePathWarning(leading, ru), ru.rules.pathLeadingSlash, leading);
    }

    for (const url of [
      'https://hook.qa-tools.ru/s/abc/orders',
      'http://localhost:3000/s/abc/',
      'HTTPS://X',
      'Http://',
    ]) {
      assert.equal(rulePathWarning(url), en.rules.pathFullUrl, url);
      assert.equal(rulePathWarning(url, ru), ru.rules.pathFullUrl, url);
    }

    for (const plain of [
      '',
      'orders',
      'items/*',
      'a//b',
      'orders/',
      'http',
      'https:/x',
      'https:x',
      'ftp://x',
      'xhttps://x',
      'orders/https://x',
      '%2Forders',
      '*',
    ]) {
      assert.equal(rulePathWarning(plain), undefined, plain);
    }
  });

  it('opens a saved //orders as /orders with the same words, and saves it back unchanged', () => {
    const doubled = formFromRule(rule('GET', '//orders'));

    assert.equal(doubled.path, '/orders');
    assert.equal(rulePathWarning(doubled.path), en.rules.pathLeadingSlash);
    assert.equal(evaluateRules([doubled]).request?.rules[0]?.path, '//orders');
    // A saved path with one slash opens with none, and says nothing.
    assert.equal(rulePathWarning(formFromRule(ORDERS).path), undefined);
  });

  it('warns about made-up paths at growing sizes at once, with one of two fixed texts', () => {
    const shapes = [
      (size: number) => '/'.repeat(size),
      (size: number) => 'h'.repeat(size),
      (size: number) => 'http:/'.repeat(Math.ceil(size / 6)).slice(0, size),
      (size: number) => ('https://' + 'a'.repeat(size)).slice(0, Math.max(size, 8)),
      (size: number) => 'a'.repeat(size - 1) + '/',
      (size: number) => '\u0000'.repeat(size),
    ];
    const fixed = new Set([en.rules.pathLeadingSlash, en.rules.pathFullUrl, undefined]);

    for (const size of [1, 1024, 64 * 1024, 1024 * 1024]) {
      for (const shape of shapes) {
        const typed = shape(size);
        const started = performance.now();
        const said = rulePathWarning(typed);
        const elapsed = performance.now() - started;

        assert.ok(elapsed < 500, `${elapsed.toFixed(1)} ms for ${size} characters`);
        assert.ok(fixed.has(said), `${size}: ${said}`);
      }
    }
  });

  it('bounds the method typed under Other a little above the longest the receiver captures', () => {
    const longest = Math.max(...RESPONSE_RULE_METHODS.map((method) => method.length));

    assert.equal(longest, 'UNSUBSCRIBE'.length);
    assert.equal(MAX_TYPED_METHOD_LENGTH, 16);

    // Every method fits, with a space typed on either side of it.
    for (const method of RESPONSE_RULE_METHODS) {
      const typed = ` ${method.toLowerCase()} `;

      assert.ok(typed.length <= MAX_TYPED_METHOD_LENGTH, method);
      assert.equal(validateRuleMethod({ method: 'other', otherMethod: typed }), undefined, method);
    }

    // The field holds the bound: a pasted run is cut there by the browser,
    // and what is cut there is still refused.
    const dialog = readFileSync(
      new URL('../components/ResponseRulesDialog.tsx', import.meta.url),
      'utf8',
    );

    assert.match(dialog, /maxLength=\{MAX_TYPED_METHOD_LENGTH\}/);
    assert.equal(
      validateRuleMethod({ method: 'other', otherMethod: 'A'.repeat(MAX_TYPED_METHOD_LENGTH) }),
      en.rules.methodUnknown,
    );
  });

  it('takes the five chips, Any and every method the receiver captures under Other, in upper case', () => {
    for (const chip of RULE_METHOD_CHIPS) {
      assert.equal(validateRuleMethod({ method: chip, otherMethod: '' }), undefined);
      assert.equal(ruleMethodValue({ method: chip, otherMethod: 'ignored' }), chip);
    }

    assert.equal(ruleMethodValue({ method: 'any', otherMethod: 'GET' }), null);

    for (const method of RESPONSE_RULE_METHODS) {
      assert.equal(validateRuleMethod({ method: 'other', otherMethod: method }), undefined, method);
      assert.equal(
        validateRuleMethod({ method: 'other', otherMethod: method.toLowerCase() }),
        undefined,
        method,
      );
      assert.equal(
        ruleMethodValue({ method: 'other', otherMethod: ` ${method.toLowerCase()} ` }),
        method,
      );
    }

    assert.equal(
      OTHER_RULE_METHODS.length,
      RESPONSE_RULE_METHODS.length - RULE_METHOD_CHIPS.length,
    );
    assert.ok(!OTHER_RULE_METHODS.includes('GET'));
    assert.ok(OTHER_RULE_METHODS.includes('PROPFIND'));
  });

  it('refuses no method, CONNECT, an unknown one and letters that only look like ASCII', () => {
    assert.equal(validateRuleMethod({ method: 'other', otherMethod: '' }), en.rules.methodRequired);
    assert.equal(
      validateRuleMethod({ method: 'other', otherMethod: '   ' }),
      en.rules.methodRequired,
    );

    for (const typed of [
      'CONNECT',
      'FOO',
      'G ET',
      'lınk', // a dotless ı, whose upper case is an ASCII I
      'ſearch', // a long s, whose upper case is an ASCII S
      'Ｇｅｔ',
      'GET\u0000',
      'M'.repeat(10_000),
      '%47ET',
    ]) {
      assert.equal(
        validateRuleMethod({ method: 'other', otherMethod: typed }),
        en.rules.methodUnknown,
        JSON.stringify(typed.slice(0, 20)),
      );
    }

    const started = performance.now();

    validateRuleMethod({ method: 'other', otherMethod: 'g'.repeat(1024 * 1024) });
    assert.ok(performance.now() - started < 500);

    // Spaces and line ends around a method are not part of it.
    assert.equal(ruleMethodValue({ method: 'other', otherMethod: '\tget\r\n' }), 'GET');
  });

  // The letters are raised a run at a time, not one by
  // one, which a megabyte of them under a loaded machine took past the bound
  // above. Whatever the shape, the method is the one raising each ASCII letter
  // alone gives, and nothing else is touched.
  for (const size of [1_000, 10_000, 100_000]) {
    it(`raises a typed method of ${size} characters as letter by letter, whatever its shape`, () => {
      for (const unit of ['gE', 'g-', 'gı', 'ſg', 'aZ9\u0000', 'Ｇg ']) {
        const typed = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
        const letterByLetter = typed
          .trim()
          .split('')
          .map((character) =>
            character >= 'a' && character <= 'z' ? character.toUpperCase() : character,
          )
          .join('');

        assert.equal(
          ruleMethodValue({ method: 'other', otherMethod: typed }),
          letterByLetter,
          JSON.stringify(unit),
        );
      }
    });
  }

  it('checks each rule’s response by the response editor’s rules', () => {
    const broken = form({ response: { ...DEFAULT_RESPONSE_FORM, status: '700' } });
    const evaluation = evaluateRules([form(), broken]);

    assert.equal(evaluation.canSave, false);
    assert.equal(evaluation.request, null);
    assert.deepEqual(evaluation.broken, [2]);
    assert.ok(evaluation.errors[1]?.response.status !== undefined);
    assert.equal(evaluation.footerError, 'Fix rule 2 to save the rules.');
  });

  it('names every rule in error, at its field, and Save waits for them', () => {
    const evaluation = evaluateRules([
      form({ method: 'other', otherMethod: 'FOO' }),
      form(),
      form({ path: 'a?b' }),
    ]);

    assert.deepEqual(evaluation.broken, [1, 3]);
    assert.equal(evaluation.errors[0]?.method, en.rules.methodUnknown);
    assert.equal(evaluation.errors[0]?.path, undefined);
    assert.equal(evaluation.errors[2]?.path, en.rules.pathQuery);
    assert.equal(evaluation.footerError, 'Fix rules 1 and 3 to save the rules.');
    assert.equal(evaluation.canSave, false);
  });

  it('refuses more than 20 rules, whatever they hold', () => {
    const many = Array.from({ length: MAX_RESPONSE_RULES + 1 }, () => form());

    assert.equal(evaluateRules(many).canSave, false);
    assert.equal(evaluateRules(many.slice(1)).canSave, true);
  });
});

describe('the dialog: a row of the list (R5, R6, RP2)', () => {
  it('says the method, the path, the status, its name and the delay', () => {
    const row = describeRuleRow(formFromRule(ITEMS), { response: {} });

    assert.deepEqual(row, {
      method: 'Any',
      any: true,
      path: '/items/*',
      code: '404',
      name: 'Not Found',
      delay: '2 s',
      invalid: false,
    });
    assert.equal(describeRuleRow(formFromRule(ORDERS), { response: {} }).name, 'Created');
    assert.equal(
      describeRuleRow(form({ method: 'other', otherMethod: '' }), { response: {} }).method,
      '—',
    );
    assert.equal(
      describeRuleRow(form({ method: 'other', otherMethod: 'propfind' }), { response: {} }).method,
      'PROPFIND',
    );
  });

  it('marks a rule in error, by its method, its path or its response', () => {
    const errors = evaluateRules([form({ path: 'a b' })]).errors[0] ?? { response: {} };
    const row = describeRuleRow(form({ path: 'a b' }), errors);

    assert.equal(row.invalid, true);
    assert.equal(row.name, 'has an error');
    assert.equal(
      describeRuleRow(form({ response: { ...DEFAULT_RESPONSE_FORM, status: 'x' } }), {
        response: { status: 'bad' },
      }).name,
      'not a status code',
    );
  });

  it('names the place a rule is checked at, first to twentieth', () => {
    assert.equal(en.rules.checked(1), 'checked first');
    assert.equal(en.rules.checked(2), 'checked second');
    assert.equal(en.rules.checked(20), 'checked twentieth');
    assert.equal(ru.rules.checked(3), 'проверяется третьим');
  });
});

describe('the dialog: Remove all rules and the footer', () => {
  const held = stateOf([ORDERS, STATUS, ITEMS]);

  it('offers removal only while the session has saved rules', () => {
    assert.equal(canRemoveRules(held), true);
    assert.equal(canRemoveRules(stateOf([])), false);
    assert.equal(canRemoveRules(stateOf(undefined)), false);
    assert.equal(asksToRemoveRules(true, held), true);
    assert.equal(asksToRemoveRules(true, stateOf([])), false);
  });

  it('asks once in the footer, says a rule in error outside it, and drops the question with the rules gone', () => {
    const asking = rulesFooterView({
      confirming: true,
      state: held,
      busy: null,
      failure: null,
      footerError: 'Fix rule 2 to save the rules.',
    });

    assert.deepEqual(asking, {
      asking: true,
      text: 'Remove all 3 rules? Requests will be answered by the queue, when set, then the session response.',
      alert: false,
      main: { label: 'Remove all rules', call: 'remove' },
    });

    const gone = rulesFooterView({
      confirming: true,
      state: stateOf([]),
      busy: null,
      failure: null,
      footerError: null,
    });

    assert.equal(gone.asking, false);
    assert.equal(gone.text, null);
    assert.deepEqual(gone.main, { label: 'Save rules', call: 'save' });

    const broken = rulesFooterView({
      confirming: false,
      state: held,
      busy: null,
      failure: null,
      footerError: 'Fix rule 2 to save the rules.',
    });

    assert.equal(broken.text, 'Fix rule 2 to save the rules.');
    assert.equal(broken.alert, true);
  });

  it('says Saving… and Removing… in flight, and Try again for the call that failed', () => {
    const saveFailed = shownRulesFailure({ action: 'save', error: new Error('network') });
    const removeFailed = shownRulesFailure({ action: 'remove', error: new Error('network') });

    assert.equal(
      rulesFooterView({
        confirming: false,
        state: held,
        busy: 'saving',
        failure: null,
        footerError: null,
      }).main.label,
      'Saving…',
    );
    assert.equal(
      rulesFooterView({
        confirming: true,
        state: held,
        busy: 'removing',
        failure: null,
        footerError: null,
      }).main.label,
      'Removing…',
    );

    const afterSave = rulesFooterView({
      confirming: false,
      state: held,
      busy: null,
      failure: saveFailed,
      footerError: null,
    });

    assert.equal(afterSave.main.label, 'Try again');
    assert.equal(afterSave.text, 'Could not save the rules. Your rules are kept — try again.');
    assert.equal(afterSave.alert, true);

    const afterRemove = rulesFooterView({
      confirming: true,
      state: held,
      busy: null,
      failure: removeFailed,
      footerError: null,
    });

    assert.deepEqual(afterRemove.main, { label: 'Try again', call: 'remove' });
    assert.equal(afterRemove.text, 'Could not remove the rules. Try again.');

    // Out of the row that asked, a failed removal says nothing, and the save is not retried by it.
    const outside = rulesFooterView({
      confirming: false,
      state: held,
      busy: null,
      failure: removeFailed,
      footerError: null,
    });

    assert.equal(outside.text, null);
    assert.deepEqual(outside.main, { label: 'Save rules', call: 'save' });
  });

  it('drops a failure that offers no retry, and a removal’s, once the rules change', () => {
    const tooLarge = shownRulesFailure({
      action: 'save',
      error: new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'too large'),
    });
    const failed = shownRulesFailure({ action: 'save', error: new Error('x') });
    const removal = shownRulesFailure({ action: 'remove', error: new Error('x') });

    assert.equal(tooLarge?.retry, false);
    assert.equal(rulesFailureAfterEdit(tooLarge), null);
    assert.equal(rulesFailureAfterEdit(removal), null);
    assert.equal(rulesFailureAfterEdit(failed), failed);
    assert.equal(rulesFailureAfterEdit(null), null);
  });
});

describe('a failed save or removal', () => {
  it('shows a refused rule with the server’s message, which names it, after a lead-in (D106)', () => {
    const message = 'rules[1].path may contain * only as its last character';
    const refused = describeRulesFailure(
      new ApiError(400, ErrorCode.INVALID_RESPONSE_CONFIG, message),
      'save',
    );

    assert.deepEqual(refused, {
      kind: 'shown',
      action: 'save',
      text: `The server rejected these rules: ${message}`,
      retry: true,
    });
    assert.equal(
      (
        describeRulesFailure(
          new ApiError(400, ErrorCode.INVALID_RESPONSE_CONFIG, message),
          'save',
          ru,
        ) as { text: string }
      ).text,
      `Сервер отклонил эти правила: ${message}`,
    );
  });

  it('says a list over 1 MiB is too large, with no retry, and a busy server with one', () => {
    assert.deepEqual(
      describeRulesFailure(new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'x'), 'save'),
      { kind: 'shown', action: 'save', text: en.rules.tooLarge, retry: false },
    );
    assert.deepEqual(
      describeRulesFailure(new ApiError(429, ErrorCode.LARGE_BODIES_BUSY, 'x'), 'save'),
      { kind: 'shown', action: 'save', text: en.rules.serverBusy, retry: true },
    );
  });

  it('moves the page to Session not found when the session is gone, and holds nothing then', () => {
    for (const code of [ErrorCode.SESSION_NOT_FOUND, ErrorCode.SESSION_EXPIRED]) {
      const error = new ApiError(404, code, 'gone');

      assert.deepEqual(describeRulesFailure(error, 'save'), { kind: 'unavailable' });
      assert.equal(shownRulesFailure({ action: 'remove', error }), null);
    }

    assert.equal(shownRulesFailure(null), null);
  });

  it('says the same held failure in the language it is shown in', () => {
    const held = { action: 'remove' as const, error: new Error('network') };

    assert.equal(shownRulesFailure(held, en)?.text, 'Could not remove the rules. Try again.');
    assert.equal(
      shownRulesFailure(held, ru)?.text,
      'Не удалось удалить правила. Попробуйте ещё раз.',
    );
  });
});

describe("the section's Remove rules", () => {
  const held = stateOf([ORDERS, STATUS]);

  it('asks once in place of the links, and goes with the rules', () => {
    assert.deepEqual(
      rulesSectionRemoval({ confirming: false, state: held, removing: false, failure: null }),
      { offered: true, asking: false, text: null, alert: false, label: 'Remove' },
    );
    assert.deepEqual(
      rulesSectionRemoval({ confirming: true, state: held, removing: false, failure: null }),
      { offered: true, asking: true, text: 'Remove all 2 rules?', alert: false, label: 'Remove' },
    );
    assert.equal(
      rulesSectionRemoval({
        confirming: true,
        state: stateOf([ORDERS]),
        removing: false,
        failure: null,
      }).text,
      'Remove the rule?',
    );
    assert.equal(
      rulesSectionRemoval({ confirming: true, state: held, removing: true, failure: null }).label,
      'Removing…',
    );
    assert.deepEqual(
      rulesSectionRemoval({ confirming: true, state: stateOf([]), removing: false, failure: null }),
      { offered: false, asking: false, text: null, alert: false, label: 'Remove' },
    );
  });

  it('says a failure in place of the question, with Try again, and never a failed save', () => {
    const removal = shownRulesFailure({ action: 'remove', error: new Error('x') });
    const save = shownRulesFailure({ action: 'save', error: new Error('x') });
    const failed = rulesSectionRemoval({
      confirming: true,
      state: held,
      removing: false,
      failure: removal,
    });

    assert.deepEqual(failed, {
      offered: true,
      asking: true,
      text: 'Could not remove the rules. Try again.',
      alert: true,
      label: 'Try again',
    });
    assert.equal(
      rulesSectionRemoval({ confirming: true, state: held, removing: false, failure: save }).alert,
      false,
    );
  });

  it('moves focus lost with a row to Keep rules, Remove rules or the heading row', () => {
    assert.equal(rulesSectionRow('none', { asking: false }), 'none');
    assert.equal(rulesSectionRow('rules', { asking: true }), 'asking');
    assert.equal(rulesSectionRow('rules', { asking: false }), 'rules');
    assert.equal(rulesSectionFocusTarget('rules', 'asking'), 'keep');
    assert.equal(rulesSectionFocusTarget('asking', 'rules'), 'remove');
    assert.equal(rulesSectionFocusTarget('asking', 'none'), 'heading');
    assert.equal(rulesSectionFocusTarget('none', 'rules'), 'heading');
    assert.equal(rulesSectionFocusTarget('rules', 'none'), 'heading');
    assert.equal(rulesSectionFocusTarget('rules', 'rules'), null);
  });
});

describe('the toasts and the Response tab’s tag', () => {
  it('says how many rules were saved, and that none were', () => {
    assert.equal(
      formatRulesSavedToast(stateOf([ORDERS, STATUS])),
      '2 rules saved. Requests captured from now on are checked against them first.',
    );
    assert.equal(formatRulesSavedToast(stateOf([])), en.rules.savedNone);
    assert.equal(formatRulesSavedToast(stateOf(undefined)), en.rules.savedNone);
    assert.match(formatRulesSavedToast(stateOf([ORDERS]), ru), /^Сохранено: 1\u00a0правило\./);
  });

  it('never words a toast as a delivery (D103)', () => {
    for (const text of [
      formatRulesSavedToast(stateOf([ORDERS])),
      en.rules.savedNone,
      en.rules.removed,
    ]) {
      assert.doesNotMatch(text, /deliver|received|got /i);
    }
  });

  it('names the rule a request recorded, as it was then, and nothing where none answered (R8)', () => {
    assert.equal(
      formatRecordedRule({ index: 1, method: 'POST', path: '/orders' }),
      'Rule 1 · POST /orders',
    );
    assert.equal(
      formatRecordedRule({ index: 3, method: null, path: '/items/*' }),
      'Rule 3 · Any /items/*',
    );
    assert.equal(
      formatRecordedRule({ index: 1, method: 'POST', path: '/orders' }, ru),
      'Правило 1 · POST /orders',
    );
    assert.equal(formatRecordedRule(null), null);
    // A record from a backend before 1.3.0 has no `rule` at all.
    assert.equal(formatRecordedRule(undefined), null);

    const long = `/${'a'.repeat(1023)}`;

    assert.equal(
      formatRecordedRule({ index: 20, method: 'UNSUBSCRIBE', path: long }),
      `Rule 20 · UNSUBSCRIBE ${long}`,
    );
  });
});

describe('a refusal placed at the rule its field names (issue #232, D257)', () => {
  /** The rules sent: two, the second with blank header rows before its pairs. */
  const SENT: RuleForm[] = [
    formFromRule(ORDERS),
    {
      ...formFromRule(STATUS),
      response: {
        ...formFromRule(STATUS).response,
        headers: [
          { name: '', value: '' },
          { name: 'x-a', value: '1' },
          { name: '', value: '' },
          { name: 'x-b', value: '2' },
        ],
      },
    },
  ];
  const MESSAGE = 'rules[1].path must contain no ?: the query of a request is never matched';

  function refusal(field: unknown, message = MESSAGE): ApiError {
    return new ApiError(
      400,
      ErrorCode.INVALID_RESPONSE_CONFIG,
      message,
      undefined,
      field as string,
    );
  }

  it('marks the path of rule 2 and names it in the footer, counted from 1 (criterion 4)', () => {
    const error = refusal('rules[1].path');
    const placed = placeRulesRefusal(error, SENT);

    assert.deepEqual(placed, { index: 1, errors: { response: {}, path: MESSAGE }, marked: true });
    assert.deepEqual(describeRulesFailure(error, 'save', en, placed), {
      kind: 'shown',
      action: 'save',
      text: 'The server rejected rule 2. Fix the marked field and save again.',
      retry: true,
      placed: true,
    });
    assert.deepEqual(shownRulesFailure({ action: 'save', error, placed }, ru), {
      action: 'save',
      text: 'Сервер отклонил правило 2. Исправьте отмеченное поле и сохраните снова.',
      retry: true,
      placed: true,
    });
  });

  it('marks the method, the status, the delay, the body and the header list of the rule’s response', () => {
    const cases: [string, unknown][] = [
      ['rules[0].method', { response: {}, method: 'm' }],
      ['rules[1].response.status', { response: { status: 'm' } }],
      ['rules[1].response.delayMs', { response: { delayMs: 'm' } }],
      ['rules[1].response.body', { response: { body: 'm' } }],
      ['rules[1].response.headers', { response: { headers: 'm' } }],
    ];

    for (const [field, errors] of cases) {
      assert.deepEqual(placeRulesRefusal(refusal(field, 'm'), SENT)?.errors, errors, field);
      assert.equal(placeRulesRefusal(refusal(field, 'm'), SENT)?.marked, true, field);
    }
  });

  it('maps the k-th header pair sent to its row, its name at [0] and its value at [1] (criterion 6)', () => {
    assert.deepEqual(placeRulesRefusal(refusal('rules[1].response.headers[1][1]', 'm'), SENT), {
      index: 1,
      errors: { response: { rows: { 3: { value: 'm' } } } },
      marked: true,
    });
    assert.deepEqual(
      placeRulesRefusal(refusal('rules[1].response.headers[0][0]', 'm'), SENT)?.errors,
      { response: { rows: { 1: { name: 'm' } } } },
    );
    assert.deepEqual(
      placeRulesRefusal(refusal('rules[1].response.headers[0]', 'm'), SENT)?.errors,
      { response: { rows: { 1: { name: 'm' } } } },
    );
    assert.equal(placeRulesRefusal(refusal('rules[1].response.headers[2][0]'), SENT), null);
  });

  it('marks the row of a rule refused as a whole, its response or its template, and says the message', () => {
    for (const field of ['rules[1]', 'rules[1].response', 'rules[1].response.template']) {
      const message = `${field} may contain no key other than "method", "path" and "response"`;
      const error = refusal(field, message);
      const placed = placeRulesRefusal(error, SENT);

      assert.equal(placed?.index, 1, field);
      assert.equal(placed?.marked, false, field);
      assert.equal(
        shownRulesFailure({ action: 'save', error, placed }, en)?.text,
        `The server rejected rule 2: ${message}`,
      );
      assert.equal(
        shownRulesFailure({ action: 'save', error, placed }, ru)?.text,
        `Сервер отклонил правило 2: ${message}`,
      );

      const errors = rulesErrorsWithRefusal(evaluateRules(SENT).errors, placed);
      const row = describeRuleRow(SENT[1] as RuleForm, errors[1] ?? { response: {} });

      assert.equal(row.invalid, true, field);
      assert.equal(row.name, 'has an error', field);
      assert.equal(
        describeRuleRow(SENT[0] as RuleForm, errors[0] ?? { response: {} }).invalid,
        false,
      );
    }
  });

  it('keeps today’s footer and marks nothing for a field it cannot place (criterion 7)', () => {
    const fallbacks: unknown[] = [
      undefined,
      'steps[1].delayMs',
      'queue.steps[1].status',
      'rules',
      'rules[20].path',
      'rules[2]',
      'rules[-1].path',
      'rules[99999999999999999999].path',
      'rules[1].unknown',
      'rules[1].response.unknown',
      'rules[1].pathx',
      1,
      { path: 'rules[1].path' },
      `rules[1].path${'x'.repeat(1024 * 1024)}`,
    ];

    for (const field of fallbacks) {
      const error = refusal(field);
      const placed = placeRulesRefusal(error, SENT);

      assert.equal(placed, null, JSON.stringify(field)?.slice(0, 40));
      assert.deepEqual(describeRulesFailure(error, 'save', en, placed), {
        kind: 'shown',
        action: 'save',
        text: `The server rejected these rules: ${MESSAGE}`,
        retry: true,
      });
      assert.deepEqual(
        rulesErrorsWithRefusal(evaluateRules(SENT).errors, placed),
        evaluateRules(SENT).errors,
      );
    }
  });

  it('reads the field and never the message: rules[0] in the message beside rules[1] marks rule 2', () => {
    const message = 'rules[0].path must contain no ?: the query of a request is never matched';
    const placed = placeRulesRefusal(refusal('rules[1].path', message), SENT);

    assert.equal(placed?.index, 1);
    assert.equal(placed?.errors.path, message);
    assert.equal(placeRulesRefusal(refusal(undefined, message), SENT), null);
  });

  it('places nothing for an error other than 1005, whatever its field', () => {
    for (const error of [
      new ApiError(404, ErrorCode.SESSION_NOT_FOUND, 'x', undefined, 'rules[1].path'),
      new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'x', undefined, 'rules[1].path'),
      new Error('rules[1].path'),
      null,
    ]) {
      assert.equal(placeRulesRefusal(error, SENT), null);
    }
  });

  it('marks the rule refused without holding Save back, and goes with the first edit', () => {
    const error = refusal('rules[1].path');
    const placed = placeRulesRefusal(error, SENT);
    const evaluation = evaluateRules(SENT);
    const errors = rulesErrorsWithRefusal(evaluation.errors, placed);

    assert.equal(evaluation.canSave, true);
    assert.deepEqual(errors[1], { response: {}, path: MESSAGE });
    assert.equal(describeRuleRow(SENT[1] as RuleForm, errors[1] ?? { response: {} }).invalid, true);

    const shown = shownRulesFailure({ action: 'save', error, placed });

    assert.equal(rulesFailureAfterEdit(shown), null);
    // A refusal the dialog could not place stays until the next call, as before.
    const unplaced = shownRulesFailure({ action: 'save', error, placed: null });

    assert.equal(rulesFailureAfterEdit(unplaced), unplaced);
  });
});
