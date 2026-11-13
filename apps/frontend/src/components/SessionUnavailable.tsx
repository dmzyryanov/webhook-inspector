import { AppFooter } from './AppFooter.tsx';
import { AppHeader } from './AppHeader.tsx';
import { Button } from './ui/button.tsx';

interface SessionUnavailableProps {
  title: string;
  lines: string[];
  action: { label: string; onClick: () => void };
}

/**
 * Shown when the session page could not be loaded for a reason other than the
 * session itself: a network failure or a server error (D072). Its layout,
 * wording and `Try again` are unchanged since v0.7.0.
 *
 * A session the API says is not available has its own screen, `Session not
 * found` (`NotFound.tsx`, D147), which replaced this layout's other use and the
 * `Generate new URL` button that went with it.
 *
 * Below 1024 px the margins close in and the title steps down, so the page
 * never runs wider than the screen (frame 2E of the Figma page `Webhook
 * Inspector · Tablet and phone`, D157).
 *
 * It closes with the footer band every page carries (D177); it has no frame of
 * its own there, and shares the not-found screens' shell.
 */
export function SessionUnavailable({ title, lines, action }: SessionUnavailableProps) {
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <AppHeader />
      <main className="flex flex-1 flex-col items-center gap-[18px] bg-white px-60 pt-[210px] max-lg:pb-8 max-md:px-6 max-md:pt-[120px] md:max-lg:px-[124px] md:max-lg:pt-40">
        <h1 className="text-[32px] font-semibold text-ink max-lg:text-center max-md:text-[26px] md:max-lg:text-[28px]">
          {title}
        </h1>
        <div className="text-center text-[15px] text-ink-muted max-lg:leading-[22px]">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <Button onClick={action.onClick}>{action.label}</Button>
      </main>
      <AppFooter />
    </div>
  );
}
