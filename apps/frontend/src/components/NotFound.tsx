import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import * as api from '../api/client.ts';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { keepAccessKey } from '../lib/access-keys.ts';
import { cn } from '../lib/cn.ts';
import { pageNotFoundView, sessionNotFoundView, type NotFoundView } from '../lib/not-found.ts';
import { createAccessPaste, type AccessPaste } from '../lib/open-with-access.ts';
import { browserStorage } from '../lib/read-state.ts';
import { readPastedAccess, withoutFragment } from '../lib/request-link.ts';
import { AppFooter } from './AppFooter.tsx';
import { AppHeader } from './AppHeader.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

/**
 * The layout both not-found screens share: frames `2A` and `2B` of the Figma
 * page `Webhook Inspector · Not found` (D147).
 *
 * The block uses the surface of the inspector's code blocks - code background,
 * line border, radius 8 - at the frames' 13/22 monospace. It is an illustration,
 * not a capture, so it has no copy control (a named exception to D122). It
 * wraps rather than scrolling sideways, as `Raw` does (D134), so a long address
 * makes the block taller and never the page wider.
 *
 * Below 1024 px the type steps down and the block takes the column's width:
 * 520 px on a tablet (7F), the screen less 16 px each side on a phone (6A,
 * 6B, D157).
 *
 * The footer band closes both screens, as every page (frames A7–A12 of the
 * Figma page `Webhook Inspector · Privacy footer`, D177).
 */
function NotFoundScreen({ view, children }: { view: NotFoundView; children?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <AppHeader />
      <main className="flex flex-1 flex-col items-center gap-6 bg-white px-6 pt-[170px] pb-16 max-lg:gap-5 max-lg:pb-8 max-md:px-4 max-md:pt-14 md:max-lg:px-[124px] md:max-lg:pt-40">
        <h1 className="text-center text-[32px] leading-[normal] font-semibold text-ink max-md:text-[24px] md:max-lg:text-[28px]">
          {view.title}
        </h1>
        <pre className="w-[522px] max-w-full rounded-lg border border-line bg-code px-5 py-[18px] font-mono text-[13px] leading-[22px] break-words whitespace-pre-wrap text-ink-muted max-lg:w-full max-lg:px-4 max-lg:py-3.5 max-lg:text-[12px] max-lg:leading-[20px]">
          {view.request.join('\n')}
          {'\n\n'}
          <span className="text-ink">{view.answer}</span>
        </pre>
        <p className="w-[520px] max-w-full text-center text-[15px] leading-[22px] text-ink-muted max-md:text-[13px] max-md:leading-[20px] md:max-lg:text-[14px] md:max-lg:leading-[21px]">
          {view.body}
        </p>
        {/* A link, so it works with the keyboard and a middle click like the
            wordmark does, and it creates no session by itself (D107). */}
        <Button asChild>
          <Link to={view.action.href}>{view.action.label}</Link>
        </Button>
        {children}
      </main>
      <AppFooter />
    </div>
  );
}

/**
 * Screen B: an address the application does not serve (D146). Rendered from
 * the address alone, with no API call and no WebSocket; nginx has already
 * answered it with `404`.
 */
export function PageNotFound() {
  const m = useMessages();
  const { pathname, search } = useLocation();

  return (
    <NotFoundScreen view={pageNotFoundView({ pathname, search, host: window.location.host }, m)} />
  );
}

/**
 * Screen A: an address shaped like a session whose session the API says is
 * not available, on load or later while the page is open (D133, D147). A
 * private session opened without its key is refused as a missing one is
 * (D245 point 6), so it shows this very screen, in every state: nothing on it
 * tells the two apart. Both offer the field that opens a session with a link
 * with access or its key (R6-R8, D259).
 */
export function SessionNotFound({
  sessionId,
  onReopen,
}: {
  sessionId: string;
  /** Opens this session's page afresh, once the field has kept its key. */
  onReopen: () => void;
}) {
  const m = useMessages();
  const { pathname, search } = useLocation();

  return (
    <NotFoundScreen
      view={sessionNotFoundView({ pathname, search, sessionId, host: window.location.host }, m)}
    >
      <OpenWithAccess sessionId={sessionId} onReopen={onReopen} />
    </NotFoundScreen>
  );
}

/**
 * `Open with a link with access or a key…` under `Go to home page` (R6), a
 * quiet link that opens the field in its place (R7, R8): a hint, the field and
 * `Open` on one row from 375 px, the field filling the rest; at 320 px `Open`
 * may wrap under it, and nothing scrolls sideways.
 *
 * The value is read by `readPastedAccess`: the key alone is tried on this
 * page's session, a link with access on the session it names. The server is
 * asked once, `GET /api/sessions/<id>` with the key (`createAccessPaste`);
 * only a session that opens keeps its key - held in this tab and stored - and
 * is then opened: this page afresh, or the link's session, at the request it
 * names. A value that is no key or link, or a session the server says is
 * missing or gone, changes nothing and says R7's sentence under the field,
 * which is then marked invalid; a failure that says nothing about the key -
 * `429`, a server error, no connection - changes nothing either and says the
 * session page's own failure, leaving the field unmarked. Empty does nothing.
 * An answer that comes once the screen has gone - `Go to home page` clicked
 * meanwhile - is ignored, and so is a submit while a check is in flight. The
 * value is never shown anywhere else, nor logged.
 */
function OpenWithAccess({ sessionId, onReopen }: { sessionId: string; onReopen: () => void }) {
  const m = useMessages();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [failure, setFailure] = useState<'refused' | 'unreachable' | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const paste = useRef<AccessPaste | null>(null);
  const fieldId = useId();
  const errorId = useId();

  // One check at a time, and none heeded once the screen has gone. Made in
  // the effect, so a remount - React's development double mount included -
  // gets a check of its own.
  useEffect(() => {
    const own = createAccessPaste((id, key) => api.getSession(id, key));

    paste.current = own;

    return () => {
      own.dispose();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (paste.current === null) {
      return;
    }

    const pasted = readPastedAccess(value, sessionId, window.location.origin);
    const checking = paste.current.check(pasted);

    if (pasted.kind === 'open') {
      setBusy(true);
    }

    const outcome = await checking;

    if (outcome === null) {
      return;
    }

    if (outcome.kind === 'empty') {
      field.current?.focus();

      return;
    }

    if (outcome.kind !== 'opened') {
      setBusy(false);
      setFailure(outcome.kind);

      return;
    }

    if (outcome.private) {
      keepAccessKey(browserStorage(), outcome.sessionId, outcome.key);
    }

    const fragment = outcome.requestId === null ? '' : `#${outcome.requestId}`;

    if (outcome.sessionId === sessionId) {
      window.history.replaceState(
        window.history.state,
        '',
        `${withoutFragment(window.location.href)}${fragment}`,
      );
      onReopen();
    } else {
      void navigate(`/v/${outcome.sessionId}${fragment}`);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // Once the field is on screen, it takes focus.
          window.setTimeout(() => field.current?.focus(), 0);
        }}
        className="rounded-[4px] text-[13px] font-medium leading-[18px] text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:relative max-lg:before:absolute max-lg:before:inset-x-0 max-lg:before:-inset-y-[13px]"
      >
        {m.access.openWith}
      </button>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex w-[436px] max-w-full flex-col items-center"
    >
      <div aria-hidden="true" className="h-px w-[360px] max-w-full bg-line" />
      <label
        htmlFor={fieldId}
        className="mt-[26px] text-center text-[13px] leading-[18px] text-ink-muted max-lg:mt-5"
      >
        {m.access.pasteHint}
      </label>
      <div className="mt-2.5 flex w-full flex-wrap justify-center gap-2">
        <Input
          ref={field}
          id={fieldId}
          type="text"
          value={value}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={failure === 'refused'}
          aria-describedby={failure === null ? undefined : errorId}
          onChange={(event) => {
            setValue(event.target.value);
            setFailure(null);
          }}
          className={cn(
            'h-9 min-w-[200px] flex-1 border-line-strong bg-white max-lg:h-11',
            failure === 'refused' && 'border-danger',
          )}
        />
        <Button type="submit" variant="quiet" disabled={busy} className="h-9 py-0 max-lg:h-11">
          {m.access.open}
        </Button>
      </div>
      {failure !== null ? (
        <p
          id={errorId}
          role="alert"
          // One line at 1440 px, as R7 draws it, wider than the field's row.
          className="mt-2.5 w-[520px] max-w-[calc(100vw-32px)] text-center text-[12px] leading-[17px] text-danger"
        >
          {failure === 'refused'
            ? m.access.pasteFailed
            : // The key may be right: the session page's own failure, which
              // says so, rather than R7's sentence.
              m.session.errorLines.join(' ')}
        </p>
      ) : null}
    </form>
  );
}
