import { Fragment } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../i18n/LanguageProvider.tsx';
import { LANGUAGES, type Language } from '../i18n/index.ts';
import { cn } from '../lib/cn.ts';
import { switchAddress } from '../lib/not-found.ts';

/**
 * Each language as the switch names it, in its own words whatever the
 * interface's language: the code drawn, and the name said after it.
 */
const NAMES: Record<Language, { code: string; name: string }> = {
  en: { code: 'EN', name: 'English' },
  ru: { code: 'RU', name: 'Русский' },
};

/**
 * Whether an event happened on the switch: a non-modal surface - the quick
 * switch, `Check signature…` - does not take it for a click or focus away from
 * itself, so it stays open while its words change.
 */
export function isLanguageSwitch(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-testid="language-switch"]') !== null;
}

/**
 * `EN | RU` (issue #108, D222; direction A of the Figma page `Webhook
 * Inspector · Language switch (#108)`, frames A-R1, A-T1/A-T2 and the phone
 * close-ups `792:51`, `792:54`): the language shown in ink, Semi Bold; the
 * other in the link blue, Medium; a muted `|` between them, 6 px either side.
 * From 768 px it closes the header's links, after `API docs ↗` and a divider
 * (`AppHeader.tsx`); below 768 px, where the header has no room, it is one of
 * the footer band's links, before the contact (`AppFooter.tsx`). Exactly one
 * of the two is drawn at any width.
 *
 * Buttons, not links: a choice changes no address but on the two home pages.
 * There it also leads to the home page of the language chosen - `RU` to
 * `/ru/`, `EN` to `/` - which a search engine indexes in that language
 * (issue #109, D226, `switchAddress`); everywhere else the language changes
 * in place. Either way the choice is remembered. Each says whether it is the
 * language shown with `aria-pressed`, and its name is its code followed by
 * the language's own name, `EN English`, `RU Русский`, each in its own
 * `lang`. Below 1024 px each target reaches 8 px to either side, short of the
 * other's, and is as tall as the header's or the band's links' (D157), drawn
 * no differently.
 */
export function LanguageSwitch({
  place,
  className,
}: {
  place: 'header' | 'footer';
  className?: string;
}) {
  const { language, messages: m, setLanguage } = useLanguage();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  /** Remembers the choice, and on a home page goes to that language's own. */
  function choose(code: Language): void {
    const target = switchAddress(pathname, code);

    setLanguage(code);

    if (target !== null) {
      void navigate(target);
    }
  }

  return (
    <span
      role="group"
      aria-label={m.language.label}
      data-testid="language-switch"
      className={cn(
        'inline-flex items-baseline gap-1.5 whitespace-nowrap',
        place === 'header' ? 'text-[13px] leading-4' : 'text-[12px] leading-[17px]',
        className,
      )}
    >
      {LANGUAGES.map((code, index) => {
        const current = code === language;

        return (
          <Fragment key={code}>
            {index === 0 ? null : (
              <span aria-hidden="true" className="font-normal text-ink-muted">
                |
              </span>
            )}
            <button
              type="button"
              lang={code}
              aria-pressed={current}
              onClick={() => choose(code)}
              className={cn(
                'rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                'max-lg:relative max-lg:before:absolute max-lg:before:-inset-x-2',
                place === 'header' ? 'max-lg:before:-inset-y-[14px]' : 'max-lg:before:-inset-y-2',
                current ? 'font-semibold text-ink' : 'font-medium text-link hover:underline',
              )}
            >
              {NAMES[code].code}
              <span className="sr-only"> {NAMES[code].name}</span>
            </button>
          </Fragment>
        );
      })}
    </span>
  );
}
