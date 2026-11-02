/**
 * Which language the interface is shown in (issue #108, D222), decided before
 * the first render so that nothing is drawn in the other one first.
 *
 * A choice made with the `EN | RU` switch is remembered in this browser under
 * `qa-tools:language`, as `{"v":1,"lang":"ru"}`, and wins. Without one the
 * browser's own languages decide: the first entry of `navigator.languages`,
 * or `navigator.language` where that list is missing or empty, that is
 * Russian or English, by its primary subtag; a browser that asks for neither
 * gets English (Decision 7). Anything stored that this version did
 * not write - another language, malformed JSON, a value of another shape or
 * size - counts as no choice, and storage that cannot be read or written is
 * no choice and no error, as the read state's is (D156).
 *
 * Pure, with storage and the browser's languages handed in, so every rule is
 * unit-tested (`i18n.test.ts`). Open tabs keep their language until they are
 * reloaded: nothing listens for another tab's choice.
 *
 * The move link from the inspector's old address to its new one carries the
 * stored choice in the fragment no server receives, and the new address
 * stores it only where it stores no choice of its own, before the language is
 * decided (issue #321, D276, `lib/move-link.ts`).
 *
 * One address decides before all of these: the Russian home page, `/ru/`, is
 * always Russian, and opening it stores Russian as the choice (issue #109,
 * D226), so `Generate URL` there and every page after it are Russian too.
 * `/` follows the rule above.
 */
import { en, type Messages } from './en.ts';
import { ru } from './ru.ts';

export type Language = 'en' | 'ru';

/** The languages offered, in the switch's order. */
export const LANGUAGES: readonly Language[] = ['en', 'ru'];

/** Each language's words. */
export const MESSAGES: Readonly<Record<Language, Messages>> = { en, ru };

/** Where the choice is kept in `localStorage`. */
export const LANGUAGE_KEY = 'qa-tools:language';

/**
 * The longest stored value read at all: what this version writes is 19
 * characters, so anything much longer is not its own and is not parsed.
 */
const MAX_STORED_LENGTH = 64;

function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ru';
}

/**
 * The language a tag names, by its primary subtag, case aside: `ru`, `ru-RU`,
 * `RU`, `ru-RU-x-priv` and the malformed `ru_RU` are Russian, `en-GB` is
 * English; anything else - `de-DE`, `*`, `''`, `rus`, a value that is not a
 * string - is neither.
 */
export function languageOfTag(tag: unknown): Language | null {
  if (typeof tag !== 'string') {
    return null;
  }

  const primary = /^[A-Za-z]+/.exec(tag)?.[0].toLowerCase() ?? '';
  const rest = tag.slice(primary.length);

  if (rest !== '' && rest[0] !== '-' && rest[0] !== '_') {
    return null;
  }

  return isLanguage(primary) ? primary : null;
}

/**
 * The browser's choice: the first of its languages that is Russian or
 * English, else English. `languages` is `navigator.languages`; where that is
 * missing or empty, `language`, `navigator.language`, is the one entry.
 */
export function browserLanguage(languages: unknown, language?: unknown): Language {
  const tags = Array.isArray(languages) && languages.length > 0 ? languages : [language];

  for (const tag of tags) {
    const found = languageOfTag(tag);

    if (found !== null) {
      return found;
    }
  }

  return 'en';
}

/** The stored choice, or `null` for none, for anything else stored, and for storage that throws. */
export function readStoredLanguage(storage: Pick<Storage, 'getItem'> | null): Language | null {
  if (storage === null) {
    return null;
  }

  let raw: string | null;

  try {
    raw = storage.getItem(LANGUAGE_KEY);
  } catch {
    return null;
  }

  if (typeof raw !== 'string' || raw.length > MAX_STORED_LENGTH) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(raw);

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;

    return Object.hasOwn(record, 'v') &&
      record.v === 1 &&
      Object.hasOwn(record, 'lang') &&
      isLanguage(record.lang)
      ? record.lang
      : null;
  } catch {
    return null;
  }
}

/** Remembers the choice; storage that is blocked or full keeps nothing, with no error. */
export function storeLanguage(storage: Pick<Storage, 'setItem'> | null, language: Language): void {
  if (storage === null) {
    return;
  }

  try {
    storage.setItem(LANGUAGE_KEY, JSON.stringify({ v: 1, lang: language }));
  } catch {
    // Not remembered: this tab still shows the language chosen.
  }
}

/**
 * The language a page opens in: the language its address fixes, else the
 * stored choice, else the browser's. Only the Russian home page fixes one
 * (`fixedLanguage` in `lib/not-found.ts`); every other address gives `null`.
 */
export function initialLanguage(
  storage: Pick<Storage, 'getItem'> | null,
  browser: { languages?: unknown; language?: unknown } | undefined,
  fixed: Language | null = null,
): Language {
  return (
    fixed ?? readStoredLanguage(storage) ?? browserLanguage(browser?.languages, browser?.language)
  );
}

/**
 * Each language's home page (issue #109, D226): English at `/`, where the
 * page search engines indexed first stays, and Russian at `/ru/`. The
 * wordmark and `Go to home page` lead to the home page of the language shown,
 * so a visitor who came from `/ru/` goes back to it. The static pages'
 * wordmark does the same: the English static pages lead to `/`, and
 * `/ru/about` to `/ru/` (D255).
 */
export const HOME_ADDRESSES: Readonly<Record<Language, string>> = { en: '/', ru: '/ru/' };

/** The home page of a language, by its tag (`Messages['lang']`); English's for anything else. */
export function homeAddress(language: string): string {
  return isLanguage(language) ? HOME_ADDRESSES[language] : HOME_ADDRESSES.en;
}
