/**
 * The response rules in the interface (issue #226 over #134's API, D246; Figma
 * page `Webhook Inspector · Response rules (#134) — A APPROVED 2026-10-19`,
 * direction A): the quick switch's section under the queue's, the `· N rules`
 * of the endpoint label, the Response rules dialog and its toasts. The frames
 * its comments cite by a bare label - R2 to R7, RT2, RP2 and RP3 - are frames
 * of that page; a frame of another page says which.
 *
 * Every one of these is a decision about text or about which rules show,
 * rather than about layout, so it lives here, away from the DOM, where a unit
 * test reaches it (D070). Nothing here is worded as a delivery (D103, D113):
 * a rule is what the session *answers*, never what a sender received.
 *
 * The dialog checks a rule as the API does (`PUT .../rules`, D246 point 4),
 * so a rule the server would refuse is said at its field before Save: the
 * method, one of the receiver's methods or any; the path, at most 1024
 * characters of visible ASCII, no `?`, `*` only last; the response, by the
 * response editor's own checks (D150). A refusal the server still makes is
 * placed by its `field` (D257): the rule it names is selected and marked, the
 * server's message shown at the field, and the footer names the rule counted
 * from 1; a refusal it cannot place is said with its own message (D106), as
 * the queue dialog says its own.
 *
 * Every text takes the interface's words, `m`, English by default (D222).
 */
import {
  ErrorCode,
  MAX_RESPONSE_RULES,
  MAX_RULE_PATH_BYTES,
  RESPONSE_RULE_METHODS,
  type ResponseConfig,
  type ResponseRule,
  type SessionResponseState,
} from '@webhook-inspector/shared';
import { ApiError } from '../api/client.ts';
import { en, type Messages } from '../i18n/en.ts';
import {
  formFromResponse,
  validateResponseForm,
  type CreateSessionBody,
  type FormErrors,
  type ResponseForm,
} from './response-config.ts';
import {
  describeQueueStepRow,
  formatSessionResponse,
  formatStepChip,
  heldQueue,
  stepsLeft,
} from './response-queue.ts';
import { isTemplate } from './response-template.ts';
import {
  namesAField,
  placeResponseRefusal,
  refusedListPlace,
  withRefusedErrors,
  type PlacedRefusal,
} from './refused-field.ts';
import { classifySessionError } from './session-lifetime.ts';

/**
 * The rules a session holds, in their order, `[]` for none. A backend from
 * before 1.3.0 sends no `rules` at all, which says nothing about them; the
 * page keeps what it held for such a state (`session-response.ts`), and a
 * state that never said any is read as none.
 */
export function heldRules(state: {
  rules?: readonly ResponseRule[] | null;
}): readonly ResponseRule[] {
  return state.rules ?? [];
}

/** The endpoint label's part, `3 rules`, or `null` with none (#226). */
export function formatRulesSuffix(rules: readonly ResponseRule[], m: Messages = en): string | null {
  return rules.length === 0 ? null : m.rules.count(rules.length);
}

/**
 * The grey example beside the section's title while the session has no rules
 * (R2): a method and a path each, which read the same in every language, so
 * they are not the dictionary's.
 */
export const RULE_EXAMPLE_CHIPS: readonly string[] = ['POST /orders', 'GET /status'];

/** The methods offered as chips (R5); any other the receiver captures is typed under `Other`. */
export const RULE_METHOD_CHIPS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type RuleMethodChip = (typeof RULE_METHOD_CHIPS)[number];

/** The methods `Other` suggests: every method a rule may name but the chips' (D246 point 2). */
export const OTHER_RULE_METHODS: readonly string[] = RESPONSE_RULE_METHODS.filter(
  (method) => !(RULE_METHOD_CHIPS as readonly string[]).includes(method),
);

/**
 * The most characters the method typed under `Other` takes: the longest a
 * rule may name, `UNSUBSCRIBE`, is 11, and a space or two typed around it is
 * trimmed. Anything longer is refused anyway; the bound keeps a pasted run
 * from being drawn in the list's row and the field.
 */
export const MAX_TYPED_METHOD_LENGTH = 16;

/** A rule's method as a row writes it: the method, or `Any` for any. */
export function formatRuleMethod(method: string | null, m: Messages = en): string {
  return method ?? m.rules.anyMethod;
}

// ---------------------------------------------------------------------------
// The quick switch's section (R2, R3, R7).

/** One rule as the expanded section lists it: `1  POST  /orders  → 201`. */
export interface RuleSectionRow {
  place: number;
  method: string;
  /** Whether the rule takes any method, which is written in grey. */
  any: boolean;
  path: string;
  /** The status and, when it has one, the delay, `404 · 2 s`. */
  answer: string;
  /**
   * Whether the rule's response is a template: the tag after the answer (issue
   * #236, frame T13 of the Figma page `Webhook Inspector · Response body
   * templates (#236) — approved A`).
   */
  template: boolean;
}

export type RulesSectionView =
  | { kind: 'none' }
  | {
      kind: 'rules';
      /** `3 rules`, on the right of the heading row. */
      count: string;
      rows: RuleSectionRow[];
      /** What every other request gets: the session response, or the queue first while it has steps left. */
      fallback: string;
    };

export function rulesSectionView(state: SessionResponseState, m: Messages = en): RulesSectionView {
  const rules = heldRules(state);

  if (rules.length === 0) {
    return { kind: 'none' };
  }

  return {
    kind: 'rules',
    count: m.rules.count(rules.length),
    rows: rules.map((rule, index) => ({
      place: index + 1,
      method: formatRuleMethod(rule.method, m),
      any: rule.method === null,
      path: rule.path,
      answer: formatStepChip(rule.response, m),
      template: isTemplate(rule.response),
    })),
    fallback: stepsLeft(heldQueue(state)) > 0 ? m.rules.everyOtherQueue : m.rules.everyOther,
  };
}

/** The line under the dialog's list (R4-R6): what every other request gets, and from what. */
export function formatRulesFallback(state: SessionResponseState, m: Messages = en): string {
  const session = formatSessionResponse(state.response, m);

  return stepsLeft(heldQueue(state)) > 0
    ? m.rules.fallbackQueue(session)
    : m.rules.fallbackSession(session);
}

// ---------------------------------------------------------------------------
// The Response rules dialog (R4-R6, RT2, RP2, RP3).

/** Which method a rule takes, as the dialog's chips choose it. */
export type RuleMethodChoice = 'any' | RuleMethodChip | 'other';

/** Every field of a rule as the dialog holds it while it is edited: what was typed, not a parse of it. */
export interface RuleForm {
  method: RuleMethodChoice;
  /** The method typed under `Other`, as typed. */
  otherMethod: string;
  /**
   * The path after the session's URL and its slash, as typed: `orders` for
   * the rule's `/orders`, the empty text for `/`, the session's own URL. The
   * field draws `/s/<id…>/` before it (R5). A `/` typed first is kept, not
   * stripped: `/orders` is the rule `//orders`, which `rulePathWarning` says.
   */
  path: string;
  response: ResponseForm;
}

/** The form a saved rule opens on: the inverse of what Save sends, so an untouched rule saves what it was. */
export function formFromRule(rule: ResponseRule): RuleForm {
  const chip = RULE_METHOD_CHIPS.find((candidate) => candidate === rule.method);

  return {
    method: rule.method === null ? 'any' : (chip ?? 'other'),
    otherMethod: rule.method !== null && chip === undefined ? rule.method : '',
    // Every path the API holds starts with `/` (D246 point 4).
    path: rule.path.startsWith('/') ? rule.path.slice(1) : rule.path,
    response: formFromResponse(rule.response),
  };
}

/** `+ Add rule`: any method, the session's own URL, a copy of the session response (R4). */
export function newRuleForm(sessionResponse: ResponseConfig | null): RuleForm {
  return { method: 'any', otherMethod: '', path: '', response: formFromResponse(sessionResponse) };
}

/**
 * The dialog's rules as the viewer has edited them, or `null` until the
 * first edit. Selecting a rule is not an edit.
 */
export interface RulesDraft {
  rules: RuleForm[];
}

/**
 * The rules the open dialog shows (D152's rule for an open surface): the
 * session's rules as the page holds them now while nothing has been edited,
 * so a save from another tab moves an untouched dialog; from the first edit
 * on, the viewer's own, which a change from elsewhere never resets - last
 * write wins.
 */
export function rulesDialogForms(
  draft: RulesDraft | null,
  state: SessionResponseState,
): RuleForm[] {
  return draft?.rules ?? heldRules(state).map(formFromRule);
}

/** The draft after one edit, starting from what the dialog shows at that moment. */
export function editRulesDraft(
  draft: RulesDraft | null,
  state: SessionResponseState,
  edit: (rules: RuleForm[]) => RuleForm[],
): RulesDraft {
  return { rules: edit(rulesDialogForms(draft, state)) };
}

/** `+ Add rule`: a new rule last, none past 20. */
export function addRule(
  rules: readonly RuleForm[],
  sessionResponse: ResponseConfig | null,
): RuleForm[] {
  return rules.length >= MAX_RESPONSE_RULES ? [...rules] : [...rules, newRuleForm(sessionResponse)];
}

function copyRule(rule: RuleForm): RuleForm {
  return {
    ...rule,
    response: { ...rule.response, headers: rule.response.headers.map((row) => ({ ...row })) },
  };
}

/** `Duplicate`: a copy of the rule right after it, none past 20. */
export function duplicateRule(rules: readonly RuleForm[], index: number): RuleForm[] {
  const rule = rules[index];

  if (rule === undefined || rules.length >= MAX_RESPONSE_RULES) {
    return [...rules];
  }

  return [...rules.slice(0, index + 1), copyRule(rule), ...rules.slice(index + 1)];
}

/** `Remove rule`. */
export function removeRule(rules: readonly RuleForm[], index: number): RuleForm[] {
  return rules.filter((_unused, position) => position !== index);
}

/**
 * A rule moved from one place to another by its `⋮⋮` (R6): dragged, or
 * moved a place up or down from the keyboard. A place outside the list is
 * the nearest end; a move from a place that holds no rule changes nothing.
 */
export function moveRule<T>(rules: readonly T[], from: number, to: number): T[] {
  const moved = rules[from];

  if (moved === undefined) {
    return [...rules];
  }

  const target = Math.min(Math.max(to, 0), rules.length - 1);
  const rest = rules.filter((_unused, position) => position !== from);

  return [...rest.slice(0, target), moved, ...rest.slice(target)];
}

/** Where the selected rule is after a move: it follows the rule it was on. */
export function selectionAfterMove(
  selected: number | null,
  from: number,
  to: number,
  count: number,
): number | null {
  if (selected === null || count === 0) {
    return selected;
  }

  const target = Math.min(Math.max(to, 0), count - 1);

  if (selected === from) {
    return target;
  }

  if (from < selected && target >= selected) {
    return selected - 1;
  }

  if (from > selected && target <= selected) {
    return selected + 1;
  }

  return selected;
}

/**
 * The place a dragged rule is over: the first row whose bottom is below the
 * pointer, the last row past the end, the first above the start. `bounds`
 * are the rows' tops and bottoms in their order on screen.
 */
export function rowUnderPointer(
  bounds: readonly { top: number; bottom: number }[],
  y: number,
): number {
  for (const [index, bound] of bounds.entries()) {
    if (y < bound.bottom) {
      return index;
    }
  }

  return Math.max(bounds.length - 1, 0);
}

/** The method a rule sends: `null` for any, a chip's, or the typed one in upper case. */
export function ruleMethodValue(form: Pick<RuleForm, 'method' | 'otherMethod'>): string | null {
  if (form.method === 'any') {
    return null;
  }

  // Only ASCII letters are raised: a letter whose upper case is ASCII
  // without being ASCII itself - `ı`, `ſ` - stays as typed and is refused.
  // A run of them at a time, not a letter: a pasted megabyte is one call.
  return form.method === 'other'
    ? form.otherMethod.trim().replace(/[a-z]+/g, (letters) => letters.toUpperCase())
    : form.method;
}

/** What is wrong with a rule's method, if anything: only a typed one can be (D246 point 2). */
export function validateRuleMethod(
  form: Pick<RuleForm, 'method' | 'otherMethod'>,
  m: Messages = en,
): string | undefined {
  if (form.method !== 'other') {
    return undefined;
  }

  const method = ruleMethodValue(form) ?? '';

  if (method === '') {
    return m.rules.methodRequired;
  }

  return RESPONSE_RULE_METHODS.includes(method) ? undefined : m.rules.methodUnknown;
}

/** Visible ASCII, `!` to `~`: all a stored path is ever made of (D246 point 4). */
const VISIBLE_ASCII = /^[!-~]*$/;

/**
 * What is wrong with a rule's path, if anything, in the API's order (D246
 * point 4): its length first, judged before a character is read, then its
 * characters, a `?`, and a `*` before its end. `typed` is what follows the
 * session's URL and its slash.
 */
export function validateRulePath(typed: string, m: Messages = en): string | undefined {
  if (typed.length + 1 > MAX_RULE_PATH_BYTES) {
    return m.rules.pathTooLong(m.number(MAX_RULE_PATH_BYTES));
  }

  if (!VISIBLE_ASCII.test(typed)) {
    return m.rules.pathCharacters;
  }

  if (typed.includes('?')) {
    return m.rules.pathQuery;
  }

  const star = typed.indexOf('*');

  return star === -1 || star === typed.length - 1 ? undefined : m.rules.pathStar;
}

/** `http://` or `https://` at the start, in any case: a URL pasted whole. */
const FULL_URL = /^https?:\/\//i;

/**
 * What a valid path typed after the session's URL most likely means other
 * than it says, if anything: a full URL pasted whole, which the API takes as
 * a path no sender calls; or a leading `/`, which, after the field's own
 * slash, matches only a path that starts with `//` - `/orders` saves
 * `//orders`. Said under the field without holding Save, so a doubled slash,
 * which a request may carry (D173), stays a rule the dialog can write, and a
 * saved `//orders` opens as `/orders` with the same words (`formFromRule`).
 */
export function rulePathWarning(typed: string, m: Messages = en): string | undefined {
  if (FULL_URL.test(typed)) {
    return m.rules.pathFullUrl;
  }

  return typed.startsWith('/') ? m.rules.pathLeadingSlash : undefined;
}

/** The errors of one rule: its method, its path and its response, as the editor reports them. */
export interface RuleErrors {
  method?: string;
  path?: string;
  response: FormErrors;
  /**
   * The server's refusal of the rule as a whole (D257): no field draws it,
   * it marks the rule's row, and the footer says it.
   */
  refused?: string;
}

/** One rule as `PUT /api/sessions/:sessionId/rules` takes it (D246). */
export interface RuleBody {
  method: string | null;
  path: string;
  response: CreateSessionBody['response'];
}

export interface RulesEvaluation {
  /** The errors of each rule, in order. */
  errors: RuleErrors[];
  /** The places, 1-based, of the rules in error. */
  broken: number[];
  canSave: boolean;
  /** `Fix rule 2 to save the rules.`, or `null`. */
  footerError: string | null;
  /** What Save sends, the whole list in order, or `null` while it cannot be sent. */
  request: { rules: RuleBody[] } | null;
}

/**
 * The dialog's rules checked one by one. Save sends the whole list, none
 * included (R4), and is unavailable while a rule is in error or past 20.
 */
export function evaluateRules(rules: readonly RuleForm[], m: Messages = en): RulesEvaluation {
  const checked = rules.map((form) => ({
    method: validateRuleMethod(form, m),
    path: validateRulePath(form.path, m),
    response: validateResponseForm(form.response, m),
  }));
  const errors = checked.map((rule): RuleErrors => {
    const ruleErrors: RuleErrors = { response: rule.response.errors };

    if (rule.method !== undefined) {
      ruleErrors.method = rule.method;
    }

    if (rule.path !== undefined) {
      ruleErrors.path = rule.path;
    }

    return ruleErrors;
  });
  const broken = checked.flatMap((rule, index) =>
    rule.method !== undefined || rule.path !== undefined || rule.response.body === null
      ? [index + 1]
      : [],
  );
  const canSave = broken.length === 0 && rules.length <= MAX_RESPONSE_RULES;

  return {
    errors,
    broken,
    canSave,
    footerError: broken.length === 0 ? null : m.rules.fixRules(broken),
    request: canSave
      ? {
          rules: rules.map((form, index) => ({
            method: ruleMethodValue(form),
            path: `/${form.path}`,
            response: (checked[index]?.response.body as CreateSessionBody).response,
          })),
        }
      : null,
  };
}

/** What a row of the dialog's list says about one rule (R5, R6, RP2). */
export interface RuleRow {
  /** `POST`, `Any`, a typed method, or `—` while none is typed. */
  method: string;
  any: boolean;
  path: string;
  /** The status as typed, `—` when empty. */
  code: string;
  /** `Created`, `not a status code`, `has an error`, or `null` for an unregistered status. */
  name: string | null;
  /** `2 s`, or the empty string. */
  delay: string;
  invalid: boolean;
}

export function describeRuleRow(form: RuleForm, errors: RuleErrors, m: Messages = en): RuleRow {
  const response = describeQueueStepRow(form.response, errors.response, m);
  const ruleInvalid =
    errors.method !== undefined || errors.path !== undefined || errors.refused !== undefined;
  const method = ruleMethodValue(form);

  return {
    method:
      form.method === 'any' ? m.rules.anyMethod : method === null || method === '' ? '—' : method,
    any: form.method === 'any',
    path: `/${form.path}`,
    code: response.code,
    name: ruleInvalid && !response.invalid ? m.queue.hasError : response.name,
    delay: response.delay,
    invalid: ruleInvalid || response.invalid,
  };
}

/** `3 / 20` under the list. */
export function formatRulesCount(count: number): string {
  return `${count} / ${MAX_RESPONSE_RULES}`;
}

/** Whether `Remove all rules` and `Remove rules` are offered: only while the session has saved rules. */
export function canRemoveRules(state: SessionResponseState): boolean {
  return heldRules(state).length > 0;
}

/**
 * Whether a surface asks to remove the rules: only while the viewer asked
 * and the session still has rules. Rules removed meanwhile - by another
 * viewer, say - take the question with them.
 */
export function asksToRemoveRules(confirming: boolean, state: SessionResponseState): boolean {
  return confirming && canRemoveRules(state);
}

/** The two calls the dialog and the section make: a save, and a removal, which saves none. */
export type RulesCall = 'save' | 'remove';

/** A failure shown: the call that failed, its words, and whether `Try again` is offered. */
export interface ShownRulesFailure {
  action: RulesCall;
  text: string;
  retry: boolean;
  /** Set when the refusal is placed at a rule, whose mark an edit takes away with it (D257). */
  placed?: true;
}

/**
 * A save's `1005` placed at the rule its `field` names, among the rules sent
 * (D257): `rules[1]` the rule as a whole, `.method`, `.path`, and its
 * response's fields (`placeResponseRefusal`); `null` for any other error and
 * for a field the dialog cannot place, which keeps the refusal's footer as
 * it was before the field existed.
 */
export function placeRulesRefusal(
  error: unknown,
  rules: readonly RuleForm[],
): PlacedRefusal<RuleErrors> | null {
  const place = refusedListPlace(error, 'rules', rules.length);
  const rule = place === null ? undefined : rules[place.index];

  if (place === null || rule === undefined) {
    return null;
  }

  const { index, rest, message } = place;

  if (rest === '') {
    return { index, errors: { response: {}, refused: message }, marked: false };
  }

  if (rest === '.method') {
    return { index, errors: { response: {}, method: message }, marked: true };
  }

  if (rest === '.path') {
    return { index, errors: { response: {}, path: message }, marked: true };
  }

  if (!rest.startsWith('.response')) {
    return null;
  }

  const response = placeResponseRefusal(rest.slice('.response'.length), rule.response, message);

  return response === null ? null : { index, errors: { response }, marked: namesAField(response) };
}

/**
 * The errors the dialog draws: its own checks', with a placed refusal's laid
 * under the rule it names. Save still reads the dialog's own checks alone, so
 * a mark never holds it back.
 */
export function rulesErrorsWithRefusal(
  errors: readonly RuleErrors[],
  placed: PlacedRefusal<RuleErrors> | null,
): RuleErrors[] {
  return errors.map((own, index) =>
    placed === null || index !== placed.index
      ? own
      : {
          ...placed.errors,
          ...own,
          response: withRefusedErrors(own.response, placed.errors.response),
        },
  );
}

export type RulesFailure = { kind: 'unavailable' } | ({ kind: 'shown' } & ShownRulesFailure);

/**
 * What a failed save or removal says, as the queue dialog's (frame E2 of the
 * Figma page `Webhook Inspector · Response queue (#106) — chosen, review 2`):
 * the session gone moves the page; the server's refusal of a rule, placed at it
 * (`placeRulesRefusal`), names the rule counted from 1 - and its message when
 * no field of it shows that - and otherwise says its own message after a
 * lead-in, never parsed (D106, D257); a list over 1 MiB offers no retry,
 * since it would fail the same way; a busy server and anything else do.
 */
export function describeRulesFailure(
  error: unknown,
  action: RulesCall,
  m: Messages = en,
  placed: PlacedRefusal<RuleErrors> | null = null,
): RulesFailure {
  if (classifySessionError(error) === 'unavailable') {
    return { kind: 'unavailable' };
  }

  if (error instanceof ApiError && error.errorCode === ErrorCode.INVALID_RESPONSE_CONFIG) {
    if (placed !== null) {
      const rule = placed.index + 1;

      return {
        kind: 'shown',
        action,
        text: placed.marked
          ? m.rules.rejectedRule(rule)
          : m.rules.rejectedRuleWithReason(rule, error.message),
        retry: true,
        placed: true,
      };
    }

    return { kind: 'shown', action, text: m.rules.rejected(error.message), retry: true };
  }

  if (error instanceof ApiError && error.errorCode === ErrorCode.PAYLOAD_TOO_LARGE) {
    return { kind: 'shown', action, text: m.rules.tooLarge, retry: false };
  }

  if (error instanceof ApiError && error.errorCode === ErrorCode.LARGE_BODIES_BUSY) {
    return { kind: 'shown', action, text: m.rules.serverBusy, retry: true };
  }

  return {
    kind: 'shown',
    action,
    text: action === 'save' ? m.rules.saveFailed : m.rules.removeFailed,
    retry: true,
  };
}

/** A failed call as a surface holds it: the call and its error, described in the language shown (D222). */
export interface HeldRulesFailure {
  action: RulesCall;
  error: unknown;
  /** Where a save's refusal was placed among the rules it sent (D257), if anywhere. */
  placed?: PlacedRefusal<RuleErrors> | null;
}

export function shownRulesFailure(
  held: HeldRulesFailure | null,
  m: Messages = en,
): ShownRulesFailure | null {
  if (held === null) {
    return null;
  }

  const described = describeRulesFailure(held.error, held.action, m, held.placed ?? null);

  return described.kind === 'shown'
    ? {
        action: described.action,
        text: described.text,
        retry: described.retry,
        ...(described.placed === true ? { placed: true as const } : {}),
      }
    : null;
}

/**
 * What the dialog's footer shows (R4-R6, and frames E1-E3 of the Figma page
 * `Webhook Inspector · Response queue (#106) — chosen, review 2`).
 */
export interface RulesFooterView {
  /** The row that asks to remove every rule, in place of `Remove all rules`, `Cancel` and `Save rules`. */
  asking: boolean;
  /** The line beside the buttons, or `null` for the hint. */
  text: string | null;
  /** Whether the line is an error: red, and announced. */
  alert: boolean;
  /** The main button's label and the call it makes. */
  main: { label: string; call: RulesCall };
}

/**
 * The footer from what the dialog holds, as the queue dialog's footer is
 * worked out (`queueFooterView`): a failure is said in place of the question
 * or of the line naming a rule in error; a failed removal only in the row
 * that asked, which goes with the rules; the main button retries the call
 * that failed.
 */
export function rulesFooterView(
  {
    confirming,
    state,
    busy,
    failure,
    footerError,
  }: {
    confirming: boolean;
    state: SessionResponseState;
    busy: 'saving' | 'removing' | null;
    failure: ShownRulesFailure | null;
    footerError: string | null;
  },
  m: Messages = en,
): RulesFooterView {
  const asking = asksToRemoveRules(confirming, state);
  const shown = failure?.action === 'remove' && !asking ? null : failure;
  const text =
    shown?.text ?? (asking ? m.rules.removeQuestion(heldRules(state).length) : footerError);
  const retry = (call: RulesCall) => shown?.action === call && shown.retry;

  return {
    asking,
    text,
    alert: shown !== null || (!asking && footerError !== null),
    main: asking
      ? {
          label:
            busy === 'removing'
              ? m.queue.removing
              : retry('remove')
                ? m.queue.tryAgain
                : m.rules.removeAll,
          call: 'remove',
        }
      : {
          label:
            busy === 'saving' ? m.queue.saving : retry('save') ? m.queue.tryAgain : m.rules.save,
          call: 'save',
        },
  };
}

/**
 * The failure still shown once the rules change: one that offers no retry -
 * a list too large - a refusal placed at a rule, whose mark no longer
 * describes the list once it changes (D257), and a failed removal, whose row
 * an edit leaves, go; any other stays until the next call.
 */
export function rulesFailureAfterEdit(failure: ShownRulesFailure | null): ShownRulesFailure | null {
  return failure === null ||
    failure.action === 'remove' ||
    !failure.retry ||
    failure.placed === true
    ? null
    : failure;
}

// ---------------------------------------------------------------------------
// `Remove rules` in the quick switch's section (R7), as `Remove queue` is (D206).

/** What the section's links row shows about removing the rules. */
export interface RulesSectionRemovalView {
  /** Whether `Remove rules` ends the links: only while the session has rules. */
  offered: boolean;
  /** The row that asks, in place of the links. */
  asking: boolean;
  /** The question or the failure, or `null` while the row does not ask. */
  text: string | null;
  alert: boolean;
  /** The removal's button: `Remove`, `Removing…` in flight, `Try again` after a failure. */
  label: string;
}

export function rulesSectionRemoval(
  {
    confirming,
    state,
    removing,
    failure,
  }: {
    confirming: boolean;
    state: SessionResponseState;
    removing: boolean;
    failure: ShownRulesFailure | null;
  },
  m: Messages = en,
): RulesSectionRemovalView {
  const asking = asksToRemoveRules(confirming, state);
  const shown = asking && failure?.action === 'remove' ? failure : null;

  return {
    offered: canRemoveRules(state),
    asking,
    text: asking ? (shown?.text ?? m.rules.removeShort(heldRules(state).length)) : null,
    alert: shown !== null,
    label: removing ? m.queue.removing : shown?.retry === true ? m.queue.tryAgain : m.rules.remove,
  };
}

/** Which row ends the section: `Set up rules…`, the question, or the rules' links. */
export type RulesSectionRow = 'none' | 'asking' | 'rules';

export function rulesSectionRow(
  view: RulesSectionView['kind'],
  removal: Pick<RulesSectionRemovalView, 'asking'>,
): RulesSectionRow {
  if (view === 'none') {
    return 'none';
  }

  return removal.asking ? 'asking' : 'rules';
}

/**
 * The control that takes focus lost as one row takes another's place, as
 * the queue's section moves it (issue #143): `Keep rules` as the question
 * appears, `Remove rules` as it goes and the rules stay, and the heading row
 * as the rules go or come.
 */
export function rulesSectionFocusTarget(
  previous: RulesSectionRow,
  row: RulesSectionRow,
): 'keep' | 'remove' | 'heading' | null {
  if (previous === row) {
    return null;
  }

  if (row === 'asking') {
    return 'keep';
  }

  return previous === 'asking' && row === 'rules' ? 'remove' : 'heading';
}

// ---------------------------------------------------------------------------
// The toasts.

/**
 * The toast after a save (#226), worded from the state the page hands
 * back for it (`ownChangeState`): how many rules the session holds now.
 */
export function formatRulesSavedToast(state: SessionResponseState, m: Messages = en): string {
  const count = heldRules(state).length;

  return count === 0 ? m.rules.savedNone : m.rules.saved(count);
}
