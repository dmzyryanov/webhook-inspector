import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  closesOnTraversal,
  countArrivedSince,
  focusOnViewChange,
  formatArrivedBadge,
  formatOpenPosition,
  historyStep,
  isOpenRequestEntry,
  OPEN_REQUEST_ENTRY,
  OPEN_REQUEST_ENTRY_BEFORE_RENAME,
  openRequestEntryState,
  pushView,
  scrollOnViewChange,
  scrollRestorationFor,
  type SessionLayout,
} from './push-flow.ts';
import {
  readRequestLink,
  removesFragment,
  resolveRequestLink,
  withoutFragment,
  type RequestLinkOutcome,
} from './request-link.ts';

describe('pushView', () => {
  it('shows the list when nothing is open and the request when one is (D157)', () => {
    assert.equal(pushView(null), 'list');
    assert.equal(pushView('req-1'), 'detail');
  });
});

describe('the open-request entry', () => {
  it('is told from the list entry by its marker alone', () => {
    assert.equal(isOpenRequestEntry({ [OPEN_REQUEST_ENTRY]: true }), true);
    assert.equal(isOpenRequestEntry({ usr: null, key: 'a1', idx: 0 }), false);
    assert.equal(isOpenRequestEntry(null), false);
    assert.equal(isOpenRequestEntry(undefined), false);
    assert.equal(isOpenRequestEntry('webhookInspectorOpenRequest'), false);
    assert.equal(isOpenRequestEntry('qaToolsOpenRequest'), false);
    assert.equal(isOpenRequestEntry([true]), false);
    assert.equal(isOpenRequestEntry({ [OPEN_REQUEST_ENTRY]: 'yes' }), false);
  });

  it('is marked webhookInspectorOpenRequest, and an entry a page before the rename marked qaToolsOpenRequest is one too (D278)', () => {
    assert.equal(OPEN_REQUEST_ENTRY, 'webhookInspectorOpenRequest');
    assert.equal(OPEN_REQUEST_ENTRY_BEFORE_RENAME, 'qaToolsOpenRequest');

    const router = { usr: null, key: 'k3x9', idx: 2 };

    // An entry pushed by this page, and one pushed by the page before 1.18.2
    // in a tab that stayed open across the deployment.
    assert.equal(isOpenRequestEntry({ ...router, webhookInspectorOpenRequest: true }), true);
    assert.equal(isOpenRequestEntry({ ...router, qaToolsOpenRequest: true }), true);
    assert.equal(
      isOpenRequestEntry({
        ...router,
        qaToolsOpenRequest: true,
        webhookInspectorOpenRequest: true,
      }),
      true,
    );

    // Either marker counts only as `true`, and only as its own key.
    for (const value of ['true', 1, 'yes', {}, null]) {
      assert.equal(isOpenRequestEntry({ webhookInspectorOpenRequest: value }), false);
      assert.equal(isOpenRequestEntry({ qaToolsOpenRequest: value }), false);
    }
    assert.equal(isOpenRequestEntry({ qaToolsopenrequest: true }), false);
    assert.equal(isOpenRequestEntry({ WebhookInspectorOpenRequest: true }), false);
    assert.equal(
      isOpenRequestEntry({ qaToolsOpenRequest: false, webhookInspectorOpenRequest: false }),
      false,
    );

    // The page pushes the new marker alone.
    assert.deepEqual(openRequestEntryState({ ...router, qaToolsOpenRequest: true }), {
      ...router,
      qaToolsOpenRequest: true,
      webhookInspectorOpenRequest: true,
    });
    assert.equal(
      Object.hasOwn(openRequestEntryState(router), OPEN_REQUEST_ENTRY_BEFORE_RENAME),
      false,
    );
  });

  it("keeps the router's own fields, so Back lands on the address the router already shows", () => {
    const router = { usr: null, key: 'k3x9', idx: 2 };

    assert.deepEqual(openRequestEntryState(router), { ...router, [OPEN_REQUEST_ENTRY]: true });
    assert.deepEqual(router, { usr: null, key: 'k3x9', idx: 2 });
    assert.deepEqual(openRequestEntryState(null), { [OPEN_REQUEST_ENTRY]: true });
  });
});

describe('historyStep', () => {
  const base = { layout: 'push', openId: null, entryOnTop: false, backPending: false } as const;

  it('pushes an entry for a request open in the push layout', () => {
    assert.equal(historyStep({ ...base, openId: 'a' }), 'push');
  });

  it('never pushes one in the split layout: the desktop keeps its Back', () => {
    assert.equal(historyStep({ ...base, layout: 'split', openId: 'a' }), 'none');
  });

  it('takes the entry off when nothing is open, in either layout', () => {
    assert.equal(historyStep({ ...base, entryOnTop: true }), 'back');
    assert.equal(historyStep({ ...base, layout: 'split', entryOnTop: true }), 'back');
  });

  it('leaves an entry that has a request open under it', () => {
    assert.equal(historyStep({ ...base, openId: 'a', entryOnTop: true }), 'none');
    assert.equal(historyStep({ ...base, layout: 'split', openId: 'a', entryOnTop: true }), 'none');
  });

  it('decides nothing while a Back it asked for is still in flight', () => {
    assert.equal(historyStep({ ...base, entryOnTop: true, backPending: true }), 'none');
    assert.equal(historyStep({ ...base, openId: 'a', backPending: true }), 'none');
  });
});

describe('closesOnTraversal', () => {
  const back = { wasOnTop: true, isOnTop: false, ownBack: false };

  it('closes the request when Back takes its entry away', () => {
    assert.equal(closesOnTraversal({ ...back, openId: 'a' }), true);
  });

  it('does nothing when nothing is open', () => {
    assert.equal(closesOnTraversal({ ...back, openId: null }), false);
  });

  it('never closes on the Back the page asked for itself', () => {
    assert.equal(closesOnTraversal({ ...back, openId: 'b', ownBack: true }), false);
  });

  it('does nothing for a traversal that did not start on the entry', () => {
    assert.equal(closesOnTraversal({ ...back, wasOnTop: false, openId: 'a' }), false);
    assert.equal(
      closesOnTraversal({ ...back, wasOnTop: false, isOnTop: true, openId: null }),
      false,
    );
  });
});

/**
 * One browser tab running the rules above the way `usePushFlowHistory` does:
 * a history stack of addresses, the page's tracked idea of whether its entry is
 * on top, and a `history.back()` that arrives later, as `popstate` does.
 */
class Tab {
  readonly stack: { address: string; marked: boolean }[] = [{ address: '/', marked: false }];
  index = 0;
  layout: SessionLayout = 'push';
  openId: string | null = null;
  /** `false` while the page shows `Session not found` or the error screen. */
  ready = true;
  private entryOnTop = false;
  private backPending = false;
  /** Traversals the page asked for that the browser has not delivered yet. */
  private queued = 0;
  mounted = false;

  get address(): string {
    return (this.stack[this.index] as { address: string }).address;
  }

  get depth(): number {
    return this.index;
  }

  /** Follows a link to the session page and mounts it. */
  visit(address: string): void {
    this.navigate(address);
    this.mount();
  }

  /** A navigation to another address, which unmounts the page. */
  navigate(address: string): void {
    this.stack.splice(this.index + 1, this.stack.length, { address, marked: false });
    this.index += 1;
    this.mounted = false;
  }

  /** The page mounts, with nothing open, reading whatever entry is on top. */
  mount(): void {
    this.mounted = true;
    this.openId = null;
    this.entryOnTop = (this.stack[this.index] as { marked: boolean }).marked;
    this.backPending = false;
    this.reconcile();
  }

  reload(): void {
    this.mount();
  }

  /**
   * The page's first list load, and the request link read after it, as
   * `SessionPage` reads it (D182): the fragment leaves the address first, by a
   * `replaceState` of the entry on top, and a request the list holds is then
   * opened as a click opens it.
   */
  readLink(listed: readonly { id: string }[]): RequestLinkOutcome {
    const link = resolveRequestLink(readRequestLink(`https://qa-tools.ru${this.address}`), listed);

    if (removesFragment(link)) {
      const entry = this.stack[this.index] as { address: string; marked: boolean };

      this.stack[this.index] = { ...entry, address: withoutFragment(entry.address) };
    }

    if (link.kind === 'open') {
      this.open(link.requestId);
    }

    return link;
  }

  /** Every address in the tab's history, oldest first. */
  get addresses(): string[] {
    return this.stack.map((entry) => entry.address);
  }

  open(id: string): void {
    this.openId = id;
    this.reconcile();
  }

  /** The request goes away on its own, or the in-page `‹ Requests` closes it. */
  close(): void {
    this.openId = null;
    this.reconcile();
  }

  rotate(layout: SessionLayout): void {
    this.layout = layout;
    this.reconcile();
  }

  unavailable(): void {
    this.ready = false;
    this.reconcile();
  }

  /** The browser or OS Back; returns where the tab is afterwards. */
  back(): string {
    this.index -= 1;
    this.popstate();
    this.settle();

    return this.address;
  }

  forward(): string {
    this.index += 1;
    this.popstate();
    this.settle();

    return this.address;
  }

  /** Delivers every traversal the page asked for, one `popstate` each. */
  settle(): void {
    while (this.queued > 0) {
      this.queued -= 1;
      this.index -= 1;
      this.popstate();
    }
  }

  private popstate(): void {
    if (!this.mounted || !this.address.startsWith('/v/')) {
      this.mounted = false;
      return;
    }

    const wasOnTop = this.entryOnTop;
    const isOnTop = (this.stack[this.index] as { marked: boolean }).marked;
    const ownBack = this.backPending;

    this.entryOnTop = isOnTop;
    this.backPending = false;

    if (closesOnTraversal({ wasOnTop, isOnTop, openId: this.shownOpenId(), ownBack })) {
      this.openId = null;
    }

    this.reconcile();
  }

  private shownOpenId(): string | null {
    return this.ready ? this.openId : null;
  }

  private reconcile(): void {
    const step = historyStep({
      layout: this.layout,
      openId: this.shownOpenId(),
      entryOnTop: this.entryOnTop,
      backPending: this.backPending,
    });

    if (step === 'push') {
      const { address } = this.stack[this.index] as { address: string };

      this.stack.splice(this.index + 1, this.stack.length, { address, marked: true });
      this.index += 1;
      this.entryOnTop = true;
    } else if (step === 'back') {
      this.backPending = true;
      this.queued += 1;
    }
  }
}

const SESSION = '/v/G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

function onSession(layout: SessionLayout = 'push'): Tab {
  const tab = new Tab();

  tab.layout = layout;
  tab.visit(SESSION);

  return tab;
}

describe('Back in the push flow (D157)', () => {
  it('returns from an open request to the list without leaving the session', () => {
    const tab = onSession();

    tab.open('a');
    assert.equal(tab.back(), SESSION);
    assert.equal(tab.openId, null);
    assert.equal(tab.back(), '/', 'a second Back leaves the session, as today');
  });

  it('makes the in-page ‹ Requests the same step as Back', () => {
    const tab = onSession();

    tab.open('a');
    tab.close();
    tab.settle();
    assert.equal(tab.address, SESSION);
    assert.equal(tab.back(), '/');
  });

  it('opens the next request with an entry of its own after the first was closed', () => {
    const tab = onSession();

    tab.open('a');
    tab.back();
    tab.open('b');
    assert.equal(tab.back(), SESSION);
    assert.equal(tab.openId, null);
    assert.equal(tab.back(), '/');
  });

  it('leaves no dead Back press when the open request closes on its own', () => {
    // Deleted here or in another tab, `Delete all`, or not found on the server:
    // each of them clears the selection.
    const tab = onSession();

    tab.open('a');
    tab.close();
    tab.settle();
    assert.equal(tab.depth, 1);
    assert.equal(tab.back(), '/');
  });

  it('takes the entry off when the session becomes unavailable under an open request', () => {
    const tab = onSession();

    tab.open('a');
    tab.unavailable();
    tab.settle();
    assert.equal(tab.address, SESSION);
    assert.equal(tab.back(), '/');
  });

  it('shows the list after a reload and consumes the entry the reload landed on', () => {
    const tab = onSession();

    tab.open('a');
    tab.reload();
    tab.settle();
    assert.equal(tab.openId, null);
    assert.equal(tab.address, SESSION);
    assert.equal(tab.back(), '/');
  });

  it('bounces a Forward onto the entry back to the list, with nothing to reopen', () => {
    const tab = onSession();

    tab.open('a');
    tab.back();
    assert.equal(tab.forward(), SESSION);
    assert.equal(tab.openId, null);
    assert.equal(tab.back(), '/');
  });

  it('returns to the list from a page left through the wordmark while a request was open', () => {
    const tab = onSession();

    tab.open('a');
    tab.navigate('/');
    assert.equal(tab.back(), SESSION);
    // The page mounted on its own entry, with nothing open, and took it off.
    tab.mount();
    tab.settle();
    assert.equal(tab.address, SESSION);
    assert.equal(tab.back(), '/');
  });

  it('keeps a request opened while its own Back is still on its way, with an entry of its own', () => {
    const tab = onSession();

    tab.open('a');
    tab.close();
    // The next row is tapped before the Back that took the entry off arrives.
    tab.open('b');
    tab.settle();
    assert.equal(tab.openId, 'b');
    assert.equal(tab.depth, 2);
    assert.equal(tab.back(), SESSION);
    assert.equal(tab.openId, null);
    assert.equal(tab.back(), '/');
  });

  it('never asks for the same Back twice when the page decides twice before it arrives', () => {
    const tab = onSession();

    tab.open('a');
    tab.reload();
    // React's development double-invoke runs the mount effect again.
    tab.rotate('push');
    tab.settle();
    assert.equal(tab.address, SESSION);
    assert.equal(tab.back(), '/');
  });
});

describe('Back across the 1024 px boundary (D157)', () => {
  it('keeps Back of the desktop exactly as it was: it leaves the session', () => {
    const tab = onSession('split');

    tab.open('a');
    tab.open('b');
    assert.equal(tab.depth, 1);
    assert.equal(tab.back(), '/');
  });

  it('gives a request opened on the desktop an entry when the page turns narrow', () => {
    const tab = onSession('split');

    tab.open('a');
    tab.rotate('push');
    assert.equal(tab.openId, 'a', 'the selection is kept');
    assert.equal(tab.back(), SESSION);
    assert.equal(tab.openId, null);
    assert.equal(tab.back(), '/');
  });

  it('keeps the entry of a request opened narrow when the page turns wide', () => {
    const tab = onSession('push');

    tab.open('a');
    tab.rotate('split');
    assert.equal(tab.openId, 'a');
    // On the desktop that entry's Back closes the request, and the next leaves.
    assert.equal(tab.back(), SESSION);
    assert.equal(tab.openId, null);
    assert.equal(tab.back(), '/');
  });

  it('takes a leftover entry off on the desktop too when the request closes on its own', () => {
    const tab = onSession('push');

    tab.open('a');
    tab.rotate('split');
    tab.close();
    tab.settle();
    assert.equal(tab.address, SESSION);
    assert.equal(tab.back(), '/');
  });

  it('adds no second entry when a request opened narrow is rotated wide and back', () => {
    const tab = onSession('push');

    tab.open('a');
    tab.rotate('split');
    tab.rotate('push');
    assert.equal(tab.depth, 2);
    assert.equal(tab.back(), SESSION);
    assert.equal(tab.back(), '/');
  });
});

describe('A request opened from a link (D182)', () => {
  const REQUEST = '3f2b8c1e-9d4a-4e7b-a1c6-5e8f0d2b7a94';
  const LINK = `${SESSION}#${REQUEST}`;
  const listed = [{ id: 'b8f1c2d3-0000-4000-8000-000000000000' }, { id: REQUEST }];

  function onLink(layout: SessionLayout): Tab {
    const tab = new Tab();

    tab.layout = layout;
    tab.visit(LINK);

    return tab;
  }

  it('pushes the entry below 1024 px, so Back returns to the list and the next leaves', () => {
    const tab = onLink('push');

    assert.deepEqual(tab.readLink(listed), { kind: 'open', requestId: REQUEST });
    assert.equal(tab.openId, REQUEST);
    assert.equal(tab.depth, 2, 'the push flow pushed its entry');
    // Both the session's entry and the one pushed over it read without the
    // fragment: it was removed before the push copied the address.
    assert.deepEqual(tab.addresses, ['/', SESSION, SESSION]);
    assert.equal(tab.back(), SESSION);
    assert.equal(tab.openId, null);
    assert.equal(tab.back(), '/');
  });

  it('pushes no entry on the desktop, whose Back leaves the session', () => {
    const tab = onLink('split');

    tab.readLink(listed);
    assert.equal(tab.openId, REQUEST);
    assert.equal(tab.depth, 1);
    assert.deepEqual(tab.addresses, ['/', SESSION]);
    assert.equal(tab.back(), '/');
  });

  it('shows the list on a reload, since the address no longer names the request', () => {
    const tab = onLink('push');

    tab.readLink(listed);
    tab.reload();
    tab.settle();
    assert.equal(tab.openId, null);
    assert.deepEqual(tab.readLink(listed), { kind: 'none' });
    assert.equal(tab.openId, null);
    assert.equal(tab.address, SESSION);
    assert.equal(tab.back(), '/');
  });

  it('opens nothing and adds no entry for a request the list does not hold', () => {
    for (const layout of ['push', 'split'] as const) {
      const tab = onLink(layout);

      assert.deepEqual(tab.readLink([{ id: 'b8f1c2d3-0000-4000-8000-000000000000' }]), {
        kind: 'stale',
      });
      assert.equal(tab.openId, null);
      assert.deepEqual(tab.addresses, ['/', SESSION]);
      assert.equal(tab.back(), '/');
    }
  });

  it('ignores and removes a fragment that is not a request id', () => {
    for (const fragment of ['#', '#not-a-request', `#${REQUEST}x`]) {
      const tab = new Tab();

      tab.visit(`${SESSION}${fragment}`);
      assert.deepEqual(tab.readLink(listed), { kind: 'ignore' });
      assert.equal(tab.openId, null);
      assert.deepEqual(tab.addresses, ['/', SESSION]);
    }
  });
});

describe('formatOpenPosition', () => {
  const list = [{ id: 'd' }, { id: 'c' }, { id: 'b' }, { id: 'a' }];

  it('counts from 1 in the order the list shows, newest first', () => {
    assert.equal(formatOpenPosition(list, 'd'), '1 of 4');
    assert.equal(formatOpenPosition(list, 'c'), '2 of 4');
    assert.equal(formatOpenPosition(list, 'a'), '4 of 4');
  });

  it('follows the list as it changes around the open request', () => {
    assert.equal(formatOpenPosition([{ id: 'e' }, ...list], 'c'), '3 of 5');
    assert.equal(formatOpenPosition([{ id: 'c' }, { id: 'a' }], 'c'), '1 of 2');
  });

  it('says nothing with nothing open, or for a request the list no longer holds', () => {
    assert.equal(formatOpenPosition(list, null), null);
    assert.equal(formatOpenPosition(list, 'gone'), null);
  });
});

describe('countArrivedSince and formatArrivedBadge', () => {
  const known = new Set(['c', 'b', 'a']);

  it('counts the requests the list gained after the request was opened (6C)', () => {
    assert.equal(countArrivedSince([{ id: 'c' }, { id: 'b' }, { id: 'a' }], known), 0);
    assert.equal(countArrivedSince([{ id: 'd' }, { id: 'c' }, { id: 'b' }, { id: 'a' }], known), 1);
    assert.equal(formatArrivedBadge(1), '1 new');
    assert.equal(formatArrivedBadge(12), '12 new');
  });

  it('stops counting one that was deleted again, and never counts a deletion', () => {
    assert.equal(countArrivedSince([{ id: 'c' }, { id: 'a' }], known), 0);
    assert.equal(countArrivedSince([{ id: 'e' }, { id: 'c' }], known), 1);
  });

  it('shows no badge for none', () => {
    assert.equal(formatArrivedBadge(0), null);
  });
});

describe('scrollOnViewChange', () => {
  it('opens a request at its top and returns the list to where it was left', () => {
    assert.equal(
      scrollOnViewChange({ layout: 'push', from: 'list', to: 'detail', listScroll: 1200 }),
      0,
    );
    assert.equal(
      scrollOnViewChange({ layout: 'push', from: 'detail', to: 'list', listScroll: 1200 }),
      1200,
    );
  });

  it('scrolls nothing on the desktop, whose page does not scroll', () => {
    assert.equal(
      scrollOnViewChange({ layout: 'split', from: 'list', to: 'detail', listScroll: 1200 }),
      null,
    );
    assert.equal(
      scrollOnViewChange({ layout: 'split', from: 'detail', to: 'list', listScroll: 1200 }),
      null,
    );
  });

  it('scrolls nothing when the screen did not change, as on a rotation', () => {
    assert.equal(
      scrollOnViewChange({ layout: 'push', from: 'detail', to: 'detail', listScroll: 1200 }),
      null,
    );
    assert.equal(
      scrollOnViewChange({ layout: 'push', from: 'list', to: 'list', listScroll: 1200 }),
      null,
    );
  });
});

describe('focusOnViewChange (WCAG 2.4.3)', () => {
  const open = { layout: 'push', from: 'list', to: 'detail' } as const;
  const close = { layout: 'push', from: 'detail', to: 'list' } as const;

  it('moves focus to the Back button when a request opens, wherever it was', () => {
    assert.equal(
      focusOnViewChange({ ...open, focusLost: true, openRowListed: true }),
      'back-button',
    );
    assert.equal(
      focusOnViewChange({ ...open, focusLost: false, openRowListed: true }),
      'back-button',
    );
  });

  it('returns focus to the row the request was opened from when it closes', () => {
    assert.equal(focusOnViewChange({ ...close, focusLost: true, openRowListed: true }), 'open-row');
  });

  it('falls back to the list heading when that row is gone', () => {
    assert.equal(
      focusOnViewChange({ ...close, focusLost: true, openRowListed: false }),
      'list-heading',
    );
  });

  it('leaves focus on a control that is still shown, such as the wordmark', () => {
    assert.equal(focusOnViewChange({ ...close, focusLost: false, openRowListed: true }), 'none');
    assert.equal(focusOnViewChange({ ...close, focusLost: false, openRowListed: false }), 'none');
  });

  it('never moves focus on the desktop', () => {
    for (const change of [open, close]) {
      for (const focusLost of [true, false]) {
        assert.equal(
          focusOnViewChange({ ...change, layout: 'split', focusLost, openRowListed: true }),
          'none',
        );
      }
    }
  });

  it('moves nothing when the screen did not change, as on a rotation', () => {
    assert.equal(
      focusOnViewChange({
        layout: 'push',
        from: 'detail',
        to: 'detail',
        focusLost: true,
        openRowListed: true,
      }),
      'none',
    );
  });
});

describe('scrollRestorationFor', () => {
  it("turns the browser's restoration off only while the page shows requests", () => {
    assert.equal(scrollRestorationFor(true), 'manual');
  });

  it('leaves it on for loading and notice screens, and for the pages left to', () => {
    assert.equal(scrollRestorationFor(false), 'auto');
  });
});
