import { ChevronDown, CircleCheck, CircleX, Eye, EyeOff, Info } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { RequestDetails } from '@webhook-inspector/shared';
import { useMessages } from '../i18n/LanguageProvider.tsx';
import { cn } from '../lib/cn.ts';
import { receivedBodyBytes } from '../lib/received-body.ts';
import {
  checkBeforeComputing,
  checkSignature,
  chooseAlgorithm,
  chooseHeader,
  describeCheck,
  headerOptionLabel,
  SIGNATURE_ALGORITHMS,
  signatureChoice,
  signatureHeaders,
  type SignatureCheck,
  type SignatureMemory,
} from '../lib/signature.ts';
import { CopyCodeButton } from './CopyCodeButton.tsx';
import { SegmentedControl } from './ui/segmented.tsx';

/*
 * The title of the popover and of the phone's sheet (B1-B5) is the
 * dictionary's `signature.title`; the request action that opens it (C2, C5 of
 * `Webhook Inspector · Request actions`) is `actions.checkSignature`.
 */

/**
 * What the check remembers, owned by the session page for as long as it is
 * open and read and written by every opening (D197). A ref rather than state:
 * typing in the check re-renders the check, not the page and its list.
 */
export type SignatureMemoryRef = RefObject<SignatureMemory>;

const ALGORITHM_OPTIONS = SIGNATURE_ALGORITHMS.map((algorithm) => ({
  value: algorithm,
  label: algorithm,
}));

/**
 * A field's frame (B1, B4, B3): 32 px on the desktop and 44 px below 1024 px,
 * `line-strong`, the text 13 px and 16 px on a phone, where iOS Safari would
 * otherwise zoom into it (D157). Focused, the border turns accent and 1.5 px
 * (S2).
 */
const FIELD =
  'h-8 w-full rounded-[6px] border border-line-strong bg-white px-[10px] text-[13px] leading-[18px] text-ink ' +
  'outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_0.5px_var(--color-accent)] ' +
  'max-lg:h-11 max-md:text-[16px] max-md:leading-[22px]';

const LABEL = 'text-[13px] leading-[18px] text-ink-muted';

interface SignatureCheckFormProps {
  details: RequestDetails;
  memory: SignatureMemoryRef;
}

/**
 * The check itself (Figma `Webhook Inspector · Check signature`, direction B):
 * the signature header, the secret with its warning, the algorithm, and the
 * result, computed as the tester types. The same form is the desktop's and
 * tablet's popover and the phone's sheet.
 *
 * On mount it takes focus: the secret field while it is empty, else the
 * header (B notes).
 */
export function SignatureCheckForm({ details, memory: memoryRef }: SignatureCheckFormProps) {
  const m = useMessages();
  const [memory, setMemory] = useState(memoryRef.current);
  const [shown, setShown] = useState(false);
  const headerField = useRef<HTMLSelectElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  const headerId = useId();
  const secretId = useId();
  const warningId = useId();

  const headers = useMemo(() => signatureHeaders(details.headers), [details.headers]);
  const body = useMemo(() => receivedBodyBytes(details), [details]);
  const { header, algorithm } = signatureChoice(headers, memory);
  const early = checkBeforeComputing({ header, secret: memory.secret });
  const [computed, setComputed] = useState<SignatureCheck | null>(null);

  function remember(next: SignatureMemory): void {
    memoryRef.current = next;
    setMemory(next);
  }

  // Taken once, as the form opens.
  const focusSecret = useRef(memory.secret === '');

  useEffect(() => {
    (focusSecret.current ? secretField : headerField).current?.focus();
  }, []);

  // The HMAC is asynchronous: the answer for the latest input wins, and the
  // previous result stays on screen meanwhile rather than flickering.
  useEffect(() => {
    if (early !== null) {
      return undefined;
    }

    let current = true;

    checkSignature({ header, secret: memory.secret, algorithm, body }).then(
      (result) => {
        if (current) {
          setComputed(result);
        }
      },
      () => {
        if (current) {
          setComputed({ kind: 'unavailable' });
        }
      },
    );

    return () => {
      current = false;
    };
  }, [early, header, memory.secret, algorithm, body]);

  const result = early ?? computed;

  return (
    <>
      <div className="flex flex-col gap-3 max-lg:gap-3.5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={headerId} className={LABEL}>
            {m.signature.headerLabel}
          </label>
          <div className="relative">
            <select
              ref={headerField}
              id={headerId}
              value={header?.key ?? ''}
              onChange={(event) => {
                const chosen = headers.find((entry) => entry.key === event.target.value);

                if (chosen !== undefined) {
                  remember(chooseHeader(memory, chosen));
                }
              }}
              className={cn(
                FIELD,
                'cursor-pointer appearance-none truncate pr-9',
                header === null && 'text-placeholder',
              )}
            >
              {header === null ? (
                <option value="" disabled>
                  {m.signature.chooseHeader}
                </option>
              ) : null}
              {headers.map((entry) => (
                <option key={entry.key} value={entry.key} className="text-ink">
                  {headerOptionLabel(entry, m)}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-[11px] top-1/2 size-4 -translate-y-1/2 text-ink-muted"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={secretId} className={LABEL}>
            {m.signature.secretLabel}
          </label>
          <div className="relative">
            {/*
              Never in a form, never autocompleted, and marked for the password
              managers that read these attributes, so the browser has nothing
              to offer to save: the secret is in memory only (D197).
            */}
            <input
              ref={secretField}
              id={secretId}
              type={shown ? 'text' : 'password'}
              value={memory.secret}
              placeholder={m.signature.secretPlaceholder}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              data-form-type="other"
              aria-describedby={warningId}
              onChange={(event) => remember({ ...memory, secret: event.target.value })}
              className={cn(FIELD, 'pr-10 placeholder:text-placeholder max-lg:pr-12')}
            />
            <button
              type="button"
              aria-label={shown ? m.signature.hideSecret : m.signature.showSecret}
              onClick={() => setShown((current) => !current)}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-[6px] text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-lg:w-11"
            >
              {shown ? (
                <EyeOff aria-hidden="true" className="size-4" />
              ) : (
                <Eye aria-hidden="true" className="size-4" />
              )}
            </button>
          </div>
          <p id={warningId} className="text-[12px] leading-[17px] text-ink-muted">
            {m.signature.warning}
          </p>
        </div>

        <div className="flex flex-col items-start gap-1.5">
          <span className={LABEL} aria-hidden="true">
            {m.signature.algorithm}
          </span>
          <SegmentedControl
            label={m.signature.algorithm}
            options={ALGORITHM_OPTIONS}
            value={algorithm}
            onChange={(next) => remember(chooseAlgorithm(memory, header, next))}
            size="check"
          />
        </div>
      </div>

      <SignatureResult result={result} />
    </>
  );
}

/**
 * The grey box under the form: `Match` or `No match` with what was compared,
 * or what the check still needs.
 *
 * Only the verdict and the line under it - or what the check still needs -
 * are a live region, so the verdict is said as well as shown, politely, once
 * the typing pauses. The computed value, its copy icon and the hint sit in the
 * same box but outside it: the copy icon says `Copied` from a live region of
 * its own (`CopyStatus`), which nested in this one some screen readers would
 * say twice, and a value that changes with every keystroke is not read out
 * with every keystroke. The region is always in the document, only its
 * content changing, as `CopyStatus` explains.
 */
function SignatureResult({ result }: { result: SignatureCheck | null }) {
  return (
    <div
      data-testid="signature-result"
      className={cn(
        'mt-3.5 flex flex-col gap-1.5 rounded-[6px] bg-panel-note p-3 max-md:mt-4',
        result === null && 'hidden',
      )}
    >
      <div role="status" className="flex flex-col gap-1.5">
        {result === null ? null : <Announcement result={result} />}
      </div>
      {result?.kind === 'no-match' ? <Computed value={result.computed} /> : null}
    </div>
  );
}

/** What the live region says: what the check still needs, or the verdict and what was compared. */
function Announcement({ result }: { result: SignatureCheck }) {
  const m = useMessages();

  if (result.kind === 'match' || result.kind === 'no-match') {
    return (
      <>
        <Verdict matched={result.kind === 'match'} />
        {/*
          The line names the header, whose name can be one long run with no
          hyphen to break at: it wraps inside the box rather than widening the
          popover or the phone's sheet into a sideways scroll.
        */}
        <p className="text-[12px] leading-[17px] text-ink-muted wrap-anywhere">
          {describeCheck(result, m)}
        </p>
      </>
    );
  }

  return (
    <p className="flex items-start gap-2 text-[13px] leading-[18px] text-ink-muted">
      <Info aria-hidden="true" className="mt-px size-4 shrink-0" />
      {result.kind === 'no-header'
        ? m.signature.noHeader
        : result.kind === 'no-secret'
          ? m.signature.noSecret
          : m.signature.unavailable}
    </p>
  );
}

/** Under `No match`: the computed value with its copy icon, and the hint. */
function Computed({ value }: { value: string }) {
  const m = useMessages();

  return (
    <>
      <div className="flex items-start gap-1 pt-1">
        <div className="min-w-0 flex-1 text-[12px]">
          <p className="leading-[17px] text-ink-muted">{m.signature.computed}</p>
          <p
            data-testid="signature-computed"
            className="mt-0.5 break-all font-mono leading-[20px] text-ink"
          >
            {value}
          </p>
        </div>
        <CopyCodeButton
          text={value}
          label={m.signature.copyComputed}
          className="shrink-0 bg-panel-note"
        />
      </div>
      <p className="flex items-start gap-2 pt-1 text-[12px] leading-[17px] text-ink-muted">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {m.signature.hint}
      </p>
    </>
  );
}

function Verdict({ matched }: { matched: boolean }) {
  const m = useMessages();
  const Icon = matched ? CircleCheck : CircleX;

  return (
    <p
      className={cn(
        'flex items-center gap-2 text-[13px] font-semibold leading-[18px] max-md:text-[15px] max-md:leading-[21px]',
        matched ? 'text-ok' : 'text-danger',
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {matched ? m.signature.match : m.signature.noMatch}
    </p>
  );
}
