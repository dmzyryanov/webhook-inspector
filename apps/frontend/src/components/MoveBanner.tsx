import type { MouseEvent } from 'react';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import {
  BUILT_MOVE,
  buildMoveLink,
  collectMove,
  formatMoveDay,
  moveBannerShown,
  originHost,
} from '../lib/move-link.ts';
import { browserStorage } from '../lib/read-state.ts';

/**
 * The move banner (issue #321, D276; Figma `Webhook Inspector · Move banner
 * (#321)`, direction C1, frames `895:20`, `895:135`, `895:222` and
 * `895:308`): a light-blue bar across the page above the header, on every
 * page of the inspector's old address - the home page, a session's and
 * `Page not found` - and on no page of any other. It cannot be dismissed.
 *
 * `Webhook Inspector is moving to webhook.qa-tools.ru on 1 Dec 2026`, 13 px
 * in the brand colour, then the one action, `Move with my sessions →`, 13 px
 * Semi Bold, underlined, in the link colour; the host and the day are the
 * build's (`BUILT_MOVE`), the day written with the interface's months. One
 * centred line from 768 px, 9 px above and below, the bar 35 px with its 1 px
 * line; below 768 px the text and the action are centred lines of their own,
 * 4 px apart, 10 px above and below.
 *
 * The `→` is the system font's: the Inter subsets the page loads have no
 * U+2192, which unlike `↗` (D158) has no emoji form, and as text it is
 * underlined with the words, as the frames draw it.
 *
 * The action leads, in the same tab, to the new address with this browser's
 * sessions, keys, language and section states in the fragment
 * (`buildMoveLink`). The link is built from storage as it is clicked and
 * followed at once, so it is never in the page: the `href` is the new
 * address alone, which a middle click or a copied link address opens with
 * nothing carried.
 */
export function MoveBanner() {
  const m = useMessages();
  const move = BUILT_MOVE;

  if (!moveBannerShown(window.location.origin, move)) {
    return null;
  }

  const to = move.to;

  function follow(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    window.location.assign(buildMoveLink(to, collectMove(browserStorage())));
  }

  return (
    <div
      data-testid="move-banner"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-move-line bg-row-selected px-7 py-[9px] text-center text-[13px] leading-4 max-md:flex-col max-md:gap-1 max-md:px-4 max-md:py-[10px] md:max-lg:px-6"
    >
      <p className="text-brand">{m.move.notice(originHost(move.to), formatMoveDay(move.day, m))}</p>
      {/* Below 1024 px its tap area is 44 px high, drawn no differently (D157). */}
      <a
        href={`${to}/`}
        onClick={follow}
        className="rounded-[4px] font-semibold text-link underline decoration-from-font [text-underline-position:from-font] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-[14px]"
      >
        {m.move.action}
        {/* The arrow is drawn, not said: the action is named by its words. */}
        <span aria-hidden="true">{'\u00a0→'}</span>
      </a>
    </div>
  );
}
