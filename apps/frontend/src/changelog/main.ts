/**
 * The script of `/changelog` (issue #97, D184), a static page of its own like
 * `/docs` (D155). The versions are `<details>` written at build time
 * (`scripts/changelog.mjs`), so every line opens without this script; it adds
 * only the filter, `All versions` / `Breaking only`, and `Expand all` ↔
 * `Collapse all`. Everything it loads is on this origin: Inter from the
 * bundle, no other request.
 */
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
// The header and the footer band every static page shares, then the page's own.
import '../static-pages/site-chrome.css';
import './changelog.css';
import {
  expandLabel,
  expandTarget,
  filterDays,
  type ChangelogFilter,
} from '../lib/changelog-controls.ts';

function start(): void {
  const days = Array.from(document.querySelectorAll<HTMLElement>('.day'));
  const versions = (day: HTMLElement) =>
    Array.from(day.querySelectorAll<HTMLDetailsElement>('details.version'));
  const all = () => days.flatMap(versions);
  const chips = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-filter]'));
  const expand = document.querySelector<HTMLButtonElement>('[data-expand]');

  const updateExpand = () => {
    if (expand) {
      expand.textContent = expandLabel(all().map((details) => details.open));
    }
  };

  const applyFilter = (filter: ChangelogFilter) => {
    const shown = filterDays(
      days.map((day) => versions(day).map((details) => details.hasAttribute('data-breaking'))),
      filter,
    );

    days.forEach((day, index) => {
      const view = shown[index];

      day.hidden = !view?.day;
      versions(day).forEach((details, position) => {
        details.hidden = !view?.versions[position];
      });
    });

    for (const chip of chips) {
      chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter));
    }
  };

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      applyFilter(chip.dataset.filter === 'breaking' ? 'breaking' : 'all');
    });
  }

  expand?.addEventListener('click', () => {
    const open = expandTarget(all().map((details) => details.open));

    for (const details of all()) {
      details.open = open;
    }

    updateExpand();
  });

  // `toggle` does not bubble; listening in the capture phase hears every line.
  document.addEventListener('toggle', updateExpand, true);
  updateExpand();
}

start();
