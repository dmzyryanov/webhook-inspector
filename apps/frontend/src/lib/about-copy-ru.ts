import { APP_ORIGIN } from '../../scripts/site-origin.mjs';
import { composeAbout, MCP_SERVER_URL, type AboutCopy, type AboutText } from './about-copy.ts';
import { OPERATOR, type Operator } from './operator.ts';

/**
 * The text of `/ru/about` (issue #170, D255): the Russian twin of `/about`
 * (`about-copy.ts`, D211), approved word for word as variant A on
 * 2026-10-20 — calm and close to the English, the service's
 * owner in plain words rather than any legal term. `about-copy-ru.test.ts`
 * pins every text byte for byte, and `about-pair.test.ts` holds it in step
 * with the English: the same parts in the same places, and the English it
 * was approved against.
 *
 * `\u00a0` is a no-break space. In every text the page lays out — the
 * eyebrow, the heading, the story and the facts — it sets the Russian rules
 * of where a line may end (issue #258): every one-letter word is joined to
 * the word after it, so no line ends with one (`Я тестировщик`, `о владельце`);
 * every em dash is joined to the word before it, so a dash ends a line and
 * never starts one (`экран — сначала`), the heading's too, which on a phone
 * reads `От тестировщика —` / `тестировщикам`, the one line of a single word
 * the page allows (D211's rule, D255); and `QA Tools` is never split. As on
 * `/about`, the last words of some lines are joined besides, so that no other
 * line holds a single word (`на нём я учусь новому.`). An ordinary space never
 * stands beside a joint. The title and the description, which the page does
 * not lay out, are as approved. The words are the approved ones; only where a
 * line may end changes.
 *
 * `scripts/about.mjs` writes the page from this object at build time, as it
 * does `/about`. The module imports only `about-copy.ts`, `operator.ts` and
 * `scripts/site-origin.mjs`, the build's origin (D274), which import nothing
 * else of the application, so Node loads it as TypeScript there.
 *
 * The operator's parts are left out where the English page leaves them out
 * (issue #369, `composeAbout`): the first paragraph, the facts `Кто
 * платит` and `Проверка безопасности` and, since issue #380, the line of
 * `Как это сделано` in the first person without the operator's texts, under
 * a head that names the service, approved with the English on 2026-11-10;
 * the third paragraph without a contact address.
 */
export const ABOUT_TEXT_RU: AboutText = {
  head: {
    title: 'О QA Tools',
    description: 'Кто и как делает QA Tools, кто за него платит и что происходит с вашими данными.',
  },
  headWithoutTexts: {
    title: 'О Webhook Inspector',
    description: 'Как устроен Webhook Inspector и что происходит с вашими данными.',
  },
  whoRunsIt: [
    {
      kind: 'text',
      text: 'Я\u00a0тестировщик и\u00a0делаю инструменты для тестировщиков. QA\u00a0Tools\u00a0— мой личный проект и\u00a0заодно эксперимент: на нём я\u00a0учусь\u00a0новому.',
    },
  ],
  madeForAgents: [
    {
      kind: 'text',
      text: 'Код пишут ИИ-агенты, и\u00a0сервис сделан в\u00a0том числе для них: агент может работать с\u00a0QA\u00a0Tools через MCP-сервер ',
    },
    { kind: 'code', text: MCP_SERVER_URL },
    { kind: 'text', text: '.' },
  ],
  writeTo: (mail) => [
    { kind: 'text', text: 'Пользуйтесь\u00a0— и\u00a0пишите, что\u00a0думаете: ' },
    mail,
    { kind: 'text', text: '.' },
  ],
  howItIsBuilt: {
    label: 'Как это сделано',
    writtenBy:
      'Весь код написан ИИ-агентами: Claude Code пишет его, тестирует\u00a0и\u00a0проверяет.',
    decidedBy:
      'Я\u00a0решаю, что делать, и\u00a0утверждаю каждый экран\u00a0— сначала его рисуют\u00a0в\u00a0Figma.',
    madeOf:
      'TypeScript, React и\u00a0Fastify, PostgreSQL, небольшой кластер\u00a0Kubernetes\u00a0(k3s).',
  },
  whoPays: {
    label: 'Кто платит',
    lines: [
      'Я. Для вас QA\u00a0Tools бесплатен.',
      'Что бесплатно сейчас, бесплатным и\u00a0останется. Если появятся платные тарифы, это будут дополнительные возможности\u00a0для\u00a0команд.',
    ],
  },
  yourData: {
    label: 'Ваши данные',
    lines: [
      'Никакой рекламы, cookie и\u00a0сторонней\u00a0аналитики.',
      'Принятые запросы не продаются и\u00a0никому\u00a0не\u00a0передаются.',
    ],
  },
  securityReviews: {
    label: 'Проверка безопасности',
    lines: [
      'Компании могут запросить по почте сведения о\u00a0владельце сервиса или договор об\u00a0обработке\u00a0данных.',
    ],
  },
};

/** The Russian page, `/ru/about`, for `operator`'s build (issues #369, #380). */
export function aboutRussian(operator: Operator = OPERATOR): AboutCopy {
  const { title, description, story, facts } = composeAbout(ABOUT_TEXT_RU, operator);

  return {
    lang: 'ru',
    path: '/ru/about',
    title,
    description,
    url: `${APP_ORIGIN}/ru/about`,
    eyebrow: 'О\u00a0QA\u00a0TOOLS',
    heading: 'От тестировщика\u00a0— тестировщикам',
    story,
    facts,
  };
}

/** This build's Russian page. */
export const ABOUT_RU: AboutCopy = aboutRussian();

/**
 * The SHA-256 of the English text the Russian was approved against on
 * 2026-10-20 (`aboutCopyText(ABOUT_EN)`, hex). `about-pair.test.ts` takes the
 * hash of today's English and fails when it differs: an English rewording
 * changes this page in the same merge request, its Russian approved again,
 * and this value with it (D255).
 */
export const ABOUT_RU_APPROVED_AGAINST =
  'b9b41eac5c0296a4906a9d2ce6691d2395b03e61b88addcd94ab3abda4b6f41c';

/**
 * The SHA-256 of the English text of a page built without the operator's
 * texts (`aboutCopyText(aboutEnglish(NO_OPERATOR))` for production's
 * origins, hex), which the Russian of such a page was approved against on
 * 2026-11-10 (issue #380): its head and the parts it keeps. It holds that
 * page to D255's rule as the value above holds production's.
 */
export const ABOUT_RU_WITHOUT_TEXTS_APPROVED_AGAINST =
  'd70e56e4fa87a551c66d7159ea8671df2a6610b1b561dfc2ba97e0eaed276e8b';
