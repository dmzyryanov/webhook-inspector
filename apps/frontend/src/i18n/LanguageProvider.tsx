import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en, type Messages } from './en.ts';
import { MESSAGES, storeLanguage, type Language } from './index.ts';

/** The interface's language, its words, and the switch's way to change it (D222). */
export interface LanguageState {
  language: Language;
  messages: Messages;
  setLanguage: (language: Language) => void;
}

const LanguageContext = createContext<LanguageState>({
  language: 'en',
  messages: en,
  setLanguage: () => undefined,
});

interface LanguageProviderProps {
  /** The language decided before the first render (`initialLanguage`, `main.tsx`). */
  initial: Language;
  /** Where a choice is remembered; `null` where storage cannot be had. */
  storage: Pick<Storage, 'setItem'> | null;
  children: ReactNode;
}

/**
 * The interface's language for every component under it (issue #108, D222).
 * Created once in `main.tsx`, around the router, with the language already
 * decided, so the first render is in it and nothing flashes in the other.
 *
 * A choice from the `EN | RU` switch is remembered and redraws the page at
 * once: no reload, no API call, no change of address, and every state the
 * page holds - the open request, its tab, the filter, a dialog - stays, since
 * only the words change. `<html lang>` follows it.
 */
export function LanguageProvider({ initial, storage, children }: LanguageProviderProps) {
  const [language, setShown] = useState<Language>(initial);

  const setLanguage = useCallback(
    (next: Language): void => {
      storeLanguage(storage, next);
      setShown(next);
    },
    [storage],
  );

  useLayoutEffect(() => {
    document.documentElement.lang = MESSAGES[language].lang;
  }, [language]);

  const value = useMemo(
    () => ({ language, messages: MESSAGES[language], setLanguage }),
    [language, setLanguage],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/** The interface's language and the way to change it. */
export function useLanguage(): LanguageState {
  return useContext(LanguageContext);
}

/** The words of the interface's language. */
export function useMessages(): Messages {
  return useContext(LanguageContext).messages;
}
