import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PageNotFound } from './components/NotFound.tsx';
import { Toast, type ToastMessage } from './components/Toast.tsx';
import { useLanguage } from './i18n/LanguageProvider.tsx';
import { BUILT_MOVE, moveArrivedToast, type MoveArrival } from './lib/move-link.ts';
import { classifyAddress, type AddressScreen } from './lib/not-found.ts';
import { LandingPage } from './pages/LandingPage.tsx';
import { SessionPage } from './pages/SessionPage.tsx';

/**
 * Chooses the page from the address (D146).
 *
 * The choice is `classifyAddress` rather than a route table, because it has to
 * agree with the one nginx makes before the page loads: `200` for `/`, for the
 * Russian home page `/ru/` and for an address shaped like a session, `404`
 * with this application for everything else. As one pure function it is unit-tested against nginx's own pattern,
 * the trailing slash and an extra segment included, where a route table would
 * decide those out of sight of any test.
 *
 * An address that cannot be a session renders `Page not found` here, before
 * `SessionPage` is mounted, so nothing is asked of the API and no WebSocket is
 * opened for it. There is no redirect to `/` any more.
 *
 * The View page is keyed by the session it shows. React reuses a component
 * whose position and type are unchanged, so moving from one session to another
 * would otherwise keep the previous session's requests, read state and
 * selection while the new session loads (D080). The key makes that impossible:
 * a different session is a different page, with state of its own.
 *
 * The tab's title is the interface's language's (D222): the session page
 * writes it with its unread count, and every other screen writes it here.
 * The landing page's is the head's `<title>` in its language (D226) - the
 * English one of `index.html`, the Russian one of `ru/index.html` - so a
 * crawler that runs the script reads the title the head gives.
 *
 * The Russian home page, `/ru/`, is always Russian and remembers Russian as
 * the choice (issue #109, D226): `main.tsx` opens it in Russian, and the
 * layout effect below stores the choice, and switches to Russian before the
 * next paint when the page arrives there in English - by the browser's Back,
 * say, after `EN` had led to `/`. `/` follows the visitor's language.
 *
 * A move link read as the page opened (`main.tsx`, issue #321, D276) is
 * answered with a toast over whichever page it opened, saying how many
 * sessions came and how many of them are private. It is set once the page is
 * drawn, so the toast's live region is there before its words and announces
 * them.
 */
export function App({ moveArrival = null }: { moveArrival?: MoveArrival | null }) {
  const { messages: m, setLanguage } = useLanguage();
  const { pathname } = useLocation();
  const address = classifyAddress(pathname);
  const screen = address.screen;
  const fixed = address.screen === 'landing' ? address.language : null;

  useLayoutEffect(() => {
    if (fixed !== null) {
      setLanguage(fixed);
    }
  }, [fixed, setLanguage]);

  useEffect(() => {
    if (screen !== 'session') {
      document.title = screen === 'landing' ? m.title.home : m.title.base;
    }
  }, [screen, m]);

  const [moveToast, setMoveToast] = useState<ToastMessage | null>(null);
  const dismissMoveToast = useCallback(() => setMoveToast(null), []);

  useEffect(() => {
    if (moveArrival !== null) {
      setMoveToast({ id: 1, text: moveArrivedToast(moveArrival, BUILT_MOVE), icon: 'dot' });
    }
  }, [moveArrival]);

  return (
    <>
      <Page address={address} />
      <Toast message={moveToast} onDismiss={dismissMoveToast} />
    </>
  );
}

/** The page the address names. */
function Page({ address }: { address: AddressScreen }) {
  switch (address.screen) {
    case 'landing':
      return <LandingPage />;
    case 'session':
      return <SessionPage key={address.sessionId} sessionId={address.sessionId} />;
    case 'not-found':
      return <PageNotFound />;
  }
}
