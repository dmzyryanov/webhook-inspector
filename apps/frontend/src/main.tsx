import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './index.css';
import { App } from './App.tsx';
import { LanguageProvider } from './i18n/LanguageProvider.tsx';
import { initialLanguage, MESSAGES } from './i18n/index.ts';
import { watchAccessKeyRemovals } from './lib/access-keys.ts';
import { holdsMoveFragment, takeMoveFromAddress } from './lib/move-link.ts';
import { fixedLanguage } from './lib/not-found.ts';
import { browserStorage } from './lib/read-state.ts';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container #root not found');
}

// The language is decided before the first render - the one the address
// fixes, Russian on /ru/ (D226), else the remembered choice, else the
// browser's languages - so nothing is drawn in the other one first (issue
// #108, D222). `App` stores the choice /ru/ makes.
const storage = browserStorage();

// A move link from the inspector's old address (issue #321, D276) is read
// first, before the language is decided, so a language it brings is the one
// the page opens in: its fragment leaves the address at once, whatever it
// held, and what it carries is added to this address's storage.
const moveArrival = takeMoveFromAddress(storage, {
  href: window.location.href,
  replace: (href) => window.history.replaceState(window.history.state, '', href),
});

// One opened over a page already shown - the same address with only its
// fragment changed, which loads no new document - is read the same way by
// loading the page again, so it never stays in the address unread. A session
// page's own readings of its fragment leave it in the address for that load -
// on `hashchange` (`takeKeyUnlessMove`, issue #345) and once its first list
// load has answered (`resolveRequestLinkUnlessMove`, issue #362) - however
// late the browser takes the address to load.
window.addEventListener('hashchange', () => {
  if (holdsMoveFragment(window.location.href)) {
    window.location.reload();
  }
});

const language = initialLanguage(storage, navigator, fixedLanguage(window.location.pathname));

document.documentElement.lang = MESSAGES[language].lang;
document.title = MESSAGES[language].title.base;

// A private session's key another tab of this browser removes is let go of
// here too, for as long as the tab lives (D259).
watchAccessKeyRemovals(window, storage);

createRoot(container).render(
  <StrictMode>
    <LanguageProvider initial={language} storage={storage}>
      <BrowserRouter>
        <App moveArrival={moveArrival} />
      </BrowserRouter>
    </LanguageProvider>
  </StrictMode>,
);
