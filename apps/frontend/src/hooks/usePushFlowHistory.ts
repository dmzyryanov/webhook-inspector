import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { withoutFragment } from '../lib/request-link.ts';
import {
  closesOnTraversal,
  historyStep,
  isOpenRequestEntry,
  openRequestEntryState,
  scrollRestorationFor,
  type SessionLayout,
} from '../lib/push-flow.ts';

interface PushFlowHistoryOptions {
  layout: SessionLayout;
  /**
   * The request open on screen, or `null`. `null` too while the page shows no
   * requests at all - loading, `Session not found`, the error screen - so an
   * entry left under such a screen is taken off rather than left for a Back
   * that would change nothing.
   */
  openId: string | null;
  /** Back took the open request's entry away: close the request. */
  onBack: () => void;
  /** Whether the page is showing requests, rather than loading or a notice. */
  showingRequests: boolean;
}

/**
 * The one history entry of the push flow (D157): pushed when a request opens
 * below 1024 px, so that the browser's or the OS's Back returns to the list
 * rather than leaving the session, and taken off again whenever nothing is
 * open. The decisions are `historyStep` and `closesOnTraversal`, which are
 * unit-tested; this only carries them out.
 *
 * It uses the History API directly rather than the router. The entry has the
 * page's own address, so the router has nothing to route: it is told about
 * neither the push nor the removal, and a Back onto the list's entry reaches it
 * as a `popstate` for the address it already shows, which renders the same
 * page. The router's fields in `history.state` are carried over untouched.
 *
 * While the page shows requests the browser's own scroll restoration is off.
 * The page puts the list back where it was left itself; a browser restoring a
 * position of its own on the same Back races it, and when the entry used to be
 * pushed after the open request had scrolled to its top, that race put the
 * list back at the top. The setting belongs to the history entry that is
 * current when it is written, so it is put back to `auto` - the only value the
 * application otherwise uses - rather than to what it was: by the time the
 * page unmounts, the current entry may be the landing page's, reached by Back.
 *
 * It also removes a request link's fragment from the address, once the page
 * has read it (D182), which is the one other change the session page makes to
 * the tab's history: `removeAddressFragment` replaces the current entry's
 * address with the same address less its `#…`, keeping `history.state` - the
 * router's fields and, were it there, this page's marker - as it is. The page
 * calls it before it opens the linked request, so the entry pushed for that
 * request below 1024 px copies the address without the fragment.
 */
export function usePushFlowHistory({
  layout,
  openId,
  onBack,
  showingRequests,
}: PushFlowHistoryOptions): { removeAddressFragment: () => void } {
  const entryOnTop = useRef(isOpenRequestEntry(window.history.state));
  const backPending = useRef(false);
  const latest = useRef({ layout, openId, onBack });

  useLayoutEffect(() => {
    latest.current = { layout, openId, onBack };
  });

  const reconcile = useCallback((): void => {
    const step = historyStep({
      layout: latest.current.layout,
      openId: latest.current.openId,
      entryOnTop: entryOnTop.current,
      backPending: backPending.current,
    });

    if (step === 'push') {
      window.history.pushState(openRequestEntryState(window.history.state), '');
      entryOnTop.current = true;
    } else if (step === 'back') {
      backPending.current = true;
      window.history.back();
    }
  }, []);

  // A layout effect declared before the one that may call `history.back()`,
  // so the listener is in place before any traversal the page asks for.
  useLayoutEffect(() => {
    function onPopState(): void {
      const wasOnTop = entryOnTop.current;
      const isOnTop = isOpenRequestEntry(window.history.state);
      const ownBack = backPending.current;

      entryOnTop.current = isOnTop;
      backPending.current = false;

      if (closesOnTraversal({ wasOnTop, isOnTop, openId: latest.current.openId, ownBack })) {
        // The render this causes reconciles, with the request closed.
        latest.current.onBack();

        return;
      }

      reconcile();
    }

    window.addEventListener('popstate', onPopState);

    return () => window.removeEventListener('popstate', onPopState);
  }, [reconcile]);

  // Before paint, so the entry is there by the time the open request is on
  // screen: a Back pressed as it appears - or as a tablet is rotated - finds
  // it, and the list's entry is saved before the open request scrolls to the
  // top.
  //
  // After every render rather than only when the layout or the open request
  // changes: a Back that ended picking for a comparison (D186) took the entry
  // off and left the request open, and only this puts the entry back. The
  // step is decided from refs and is `none` whenever history is as it should
  // be, so the extra runs change nothing.
  useLayoutEffect(() => {
    reconcile();
  });

  useEffect(() => {
    window.history.scrollRestoration = scrollRestorationFor(showingRequests);

    return () => {
      window.history.scrollRestoration = scrollRestorationFor(false);
    };
  }, [showingRequests]);

  const removeAddressFragment = useCallback((): void => {
    window.history.replaceState(window.history.state, '', withoutFragment(window.location.href));
  }, []);

  return { removeAddressFragment };
}
