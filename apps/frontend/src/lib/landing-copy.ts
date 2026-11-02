/**
 * The home page's copy in English, which `index.html` repeats as plain HTML
 * in its `<noscript>` for a reader without JavaScript, a search engine among
 * them (issue #69, D183). The words live in the dictionary, `en.landing`
 * (D222); these names keep them where `search-engines.test.ts` compares the
 * `<noscript>` with them, so the two cannot drift apart silently: a change
 * there has to be made in `index.html` too. The `<noscript>` stays English
 * whatever the interface's language: a crawler sees no client-side switch.
 * The Russian home page, `ru/index.html`, has its own `<noscript>` in the
 * Russian words, `ru.landing`, which `search-engines.test.ts` compares the
 * same way (issue #109, D226).
 *
 * A reader without JavaScript has no list of sessions either, so the
 * `<noscript>` is always the first-visit page (F): the heading, the lead and
 * the three steps, the security note folded into step 01 since the
 * `Temporary and anonymous` block was removed (issue #92, D199).
 */
import { en } from '../i18n/en.ts';

export const LANDING_EYEBROW = en.landing.eyebrow;

export const LANDING_HEADING = en.landing.heading;

export const LANDING_LEAD = en.landing.lead;

/** The dashed tile's label, on both states of the page. */
export const GENERATE_URL_LABEL = en.landing.generate;

/** Beside the label from 768 px up: the first visit's, then the returning visitor's. */
export const GENERATE_URL_HINT_FIRST_VISIT = en.landing.hintFirstVisit;
export const GENERATE_URL_HINT_RETURNING = en.landing.hintReturning;

/*
 * Under the tile when `Generate URL` could not create a session (issue #128),
 * chosen by `createSessionFailureText` in `lib/create-session-failure.ts`.
 * The spaces of each second sentence are no-break spaces, so `Please try
 * again.` and `Try again in 40 s.` move to the next line whole rather than
 * break inside. The `<noscript>` has no tile to fail, so it repeats neither.
 */

/** Any failure: no answer, any status but `429` / `1015` with its `Retry-After`. */
export const SESSION_NOT_CREATED = en.landing.notCreated;

/** `429` / `1015 RATE_LIMIT_EXCEEDED` with a `Retry-After` of `seconds`. */
export function formatTooManySessions(seconds: number): string {
  return en.landing.tooManySessions(seconds);
}

export const LANDING_STEPS_TITLE = en.landing.stepsTitle;

export const LANDING_STEPS = en.landing.steps;
