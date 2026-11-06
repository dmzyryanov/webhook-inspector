/**
 * The interface's words in Russian (issue #108, D222), in the shape of `en.ts`:
 * typed against it, so a key missing here, or one English lacks, fails the
 * typecheck. The wording follows the glossary the owner approved with the
 * frames on 2026-10-10 (Figma `792:57`): `сессия`, `запрос`, `адрес для
 * приёма`, `Создать адрес`, `очередь ответов`, `По умолчанию` / `Свой` and the
 * rest.
 *
 * What stays English (Decision 7): `Raw`, `Body`, `Headers`, `Query` and the
 * `Request` / `Response` tabs, which are drawn outside this file; method names,
 * status reason phrases, header names, the units `B`, `KB`, `MB` and `ms`,
 * `cURL`, `JSON` and `API docs ↗`. Names that have no Russian word - formats,
 * encodings and algorithms (`XML`, `UTF-8`, `Base64`, `HMAC`), products
 * (`QA Tools`, `Postman`, `Stripe`) - are kept as written; `i18n.test.ts`
 * holds every Latin word here to that list. Seconds are `с`, with a decimal
 * comma, and binary sizes use the application's own `KB` and `MB`.
 *
 * A number and its noun are joined by a no-break space (U+00A0), the noun in
 * the form the number asks for: `1 запрос`, `2 запроса`, `5 запросов`.
 */
import type { Messages } from './en.ts';

const PLURAL = new Intl.PluralRules('ru');

/**
 * The noun's form for a count: `one` (1, 21, 101), `few` (2-4, 22-24) or
 * `many` (0, 5-20, 11-14, 25). A fraction, or anything that is no count, takes
 * the genitive singular, which is the `few` form: `1,5 запроса`.
 */
function plural(value: number, one: string, few: string, many: string): string {
  switch (PLURAL.select(value)) {
    case 'one':
      return one;
    case 'many':
      return many;
    default:
      return few;
  }
}

/** `1 запрос`, `3 запроса`, `5 запросов`. */
function count(value: number, one: string, few: string, many: string): string {
  return `${value}\u00a0${plural(value, one, few, many)}`;
}

/** The genitive after `больше`, `после`, `из`: `1 дня`, `7 дней`, `21 дня`. */
function genitive(value: number, singular: string, plural_: string): string {
  return PLURAL.select(value) === 'one' ? singular : plural_;
}

/**
 * A number grouped the Russian way, by no-break spaces, with a decimal comma:
 * `65 536`, `0,5`. Written from the English grouping rather than taken from
 * `ru-RU`, whose separator ICU versions have changed.
 */
function number(value: number): string {
  return value.toLocaleString('en-US').replaceAll(',', '\u00a0').replace('.', ',');
}

/** A delay in seconds as a chip writes it: `2 с`, `0,5 с`, `1,25 с`. */
function seconds(delayMs: number): string {
  return `${number(Number((delayMs / 1000).toFixed(3)))}\u00a0с`;
}

/** Where a response rule is checked, by its place: `первым` to `двадцатым` (D246's 20). */
const ORDINALS = [
  'первым',
  'вторым',
  'третьим',
  'четвёртым',
  'пятым',
  'шестым',
  'седьмым',
  'восьмым',
  'девятым',
  'десятым',
  'одиннадцатым',
  'двенадцатым',
  'тринадцатым',
  'четырнадцатым',
  'пятнадцатым',
  'шестнадцатым',
  'семнадцатым',
  'восемнадцатым',
  'девятнадцатым',
  'двадцатым',
];

/** `503`, `503 и 200`, `503, 429 и 200`. */
function list(items: readonly (string | number)[]): string {
  return items.length < 2
    ? `${items[0] ?? ''}`
    : `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

/** `Следующий запрос получит 503`, `Следующие 2 запроса получат 503 и 429`. */
function nextRequests(statuses: readonly number[]): string {
  const said = statuses.every((status) => status === statuses[0])
    ? `${statuses[0]}`
    : list(statuses);

  return statuses.length === 1
    ? `Следующий запрос получит ${said}`
    : `Следующие ${count(statuses.length, 'запрос', 'запроса', 'запросов')} получат ${said}`;
}

/** What the next requests get once every step has answered. */
function sessionResponse(custom: boolean): string {
  return custom ? 'свой ответ' : 'ответ по умолчанию';
}

export const ru: Messages = {
  lang: 'ru',

  number,

  /** The genitive abbreviations ICU writes for Russian, fixed here as D148 fixes the English. */
  months: [
    'янв.',
    'февр.',
    'мар.',
    'апр.',
    'мая',
    'июн.',
    'июл.',
    'авг.',
    'сент.',
    'окт.',
    'нояб.',
    'дек.',
  ],

  title: {
    base: 'Webhook Inspector — проверка вебхуков',
    unread: (unread) => `(${unread}) Webhook Inspector — проверка вебхуков`,
    // The Russian home page's: the `<title>` of `ru/index.html`, the owner's
    // words for the search result and the link preview, the same as the
    // tab's (D226, amended by D277).
    home: 'Webhook Inspector — проверка вебхуков',
  },

  header: {
    changelog: 'Изменения',
    status: 'Статус',
    // `/docs` stays English, and so does its link (Decision 4).
    apiDocs: 'API docs',
    newTab: '(открывается в новой вкладке)',
  },

  move: {
    notice: (host, day) => `Webhook Inspector переезжает на ${host} ${day}`,
    action: 'Перейти со своими сессиями',
    // `Перенесено 5 сессий с qa-tools.ru, из них 2 приватные`; the verb
    // agrees with the number: `Перенесена 1 сессия`, `Перенесено 2 сессии`.
    arrived: (sessions, privateSessions, from) => {
      const where = from === null ? '' : ` с ${from}`;
      const moved = `${PLURAL.select(sessions) === 'one' ? 'Перенесена' : 'Перенесено'} ${count(sessions, 'сессия', 'сессии', 'сессий')}${where}`;

      if (privateSessions === 0) {
        return moved;
      }

      return sessions === 1
        ? `Перенесена 1\u00a0приватная сессия${where}`
        : `${moved}, из них ${count(privateSessions, 'приватная', 'приватные', 'приватных')}`;
    },
  },

  footer: {
    line: 'Запросы — заголовки, тело и IP отправителя — хранятся, пока вы их не удалите или сессия не истечёт (до 7\u00a0дней простоя); в копиях — ещё до 3\u00a0дней.',
    lineWithoutBackups:
      'Запросы — заголовки, тело и IP отправителя — хранятся, пока вы их не удалите или сессия не истечёт (до 7\u00a0дней простоя).',
    about: 'О сервисе',
    terms: 'Условия',
    privacy: 'Конфиденциальность',
    contact: 'Почта:',
  },

  language: {
    label: 'Язык',
  },

  common: {
    cancel: 'Отмена',
    close: 'Закрыть',
  },

  copy: {
    copy: 'Копировать',
    copied: 'Скопировано',
    blockRefused: 'Браузер не дал скопировать. Текст по-прежнему можно выделить.',
  },

  landing: {
    eyebrow: 'ПРОВЕРКА ВЕБХУКОВ',
    heading: 'Проверяйте вебхуки мгновенно.',
    lead: 'Создайте временный адрес и смотрите входящие HTTP-запросы в реальном времени. Без регистрации и настройки.',
    generate: 'Создать адрес',
    hintFirstVisit: '— ваш временный адрес, готов за секунду',
    hintReturning: '— новый временный адрес',
    notCreated: 'Не удалось создать сессию. Попробуйте\u00a0ещё\u00a0раз.',
    tooManySessions: (retryAfter) =>
      `С вашего адреса создано слишком много сессий. Повторите\u00a0через\u00a0${retryAfter}\u00a0с.`,
    stepsTitle: 'Как это работает',
    stepsCount: (steps) => count(steps, 'шаг', 'шага', 'шагов'),
    steps: [
      {
        number: '01',
        title: 'Создайте адрес',
        description:
          'Временный адрес для приёма появится сразу. Всё, что он принимает, видит любой, у кого есть ссылка, поэтому не отправляйте на него чувствительные боевые данные.',
      },
      {
        number: '02',
        title: 'Отправьте запросы',
        description: 'Из Postman, CI, вебхуков или любого HTTP-клиента.',
      },
      {
        number: '03',
        title: 'Смотрите вживую',
        description: 'Метод, заголовки, параметры, тело, IP, размер и время.',
      },
    ],
  },

  newSession: {
    options: 'Параметры новой сессии',
    expiresTitle: 'Истекает после простоя',
    days: (days) => count(days, 'день', 'дня', 'дней'),
    hours: (hours) => count(hours, 'час', 'часа', 'часов'),
    ipStored: 'IP сохраняется',
    ipNotStored: 'IP не сохраняется',
    storeIp: 'Сохранять IP отправителя',
    storeIpHint: 'Без галочки в запросах будет «IP не сохраняется»',
    hintDays: (days) => `— истекает через ${count(days, 'день', 'дня', 'дней')} простоя`,
    hintHours: (hours) => `— истекает через ${count(hours, 'час', 'часа', 'часов')} простоя`,
    privateSession: 'Приватная сессия',
    privateHint: 'Открывается только по ссылке с доступом',
  },

  access: {
    mark: 'Приватная сессия',
    copyMenu: 'Варианты копирования',
    copyReceiveUrl: 'Копировать адрес для приёма',
    copyReceiveUrlHint: 'Для отправителя: только принимает запросы',
    copyLink: 'Копировать ссылку с доступом',
    copyLinkHint: 'Для коллеги: открывает эту сессию',
    linkCopied: 'Ссылка с доступом скопирована',
    removeTitle: 'Убрать приватную сессию из списка?',
    removeDescription:
      'Ключ к ней есть только в этом браузере. Сама сессия не удаляется, но после удаления из списка открыть её можно будет только по ссылке с доступом. Скопируйте ссылку, если она может понадобиться.',
    openWith: 'Открыть по ссылке с доступом или ключу…',
    pasteHint: 'Есть ссылка с доступом или ключ? Вставьте любой из них, чтобы открыть сессию.',
    open: 'Открыть',
    pasteFailed: 'Ничего не открылось: это не ссылка с доступом и не ключ существующей сессии.',
  },

  home: {
    loading: 'Загрузка сессий…',
    detailsFailed: 'Не удалось загрузить сведения о сессиях.',
    sessions: (sessions) => count(sessions, 'сессия', 'сессии', 'сессий'),
    requests: (requests) => count(requests, 'запрос', 'запроса', 'запросов'),
    noRequestsYet: 'запросов пока нет',
    lastRequest: 'последний запрос',
    lastRequestAt: (time) => `последний запрос ${time}`,
    someShown: (shown, total) =>
      `${shown} из ${total}\u00a0${genitive(total, 'сессии', 'сессий')} в этом браузере`,
    allShown: (total) => `${count(total, 'сессия', 'сессии', 'сессий')} в этом браузере`,
    showAll: 'Показать все',
    deleteTitle: 'Удалить эту сессию?',
    deleteDescription: (shortId, requests) => {
      const held =
        requests === null
          ? 'всеми её запросами и настройками ответа'
          : requests === 0
            ? 'настройками ответа'
            : `${requests}\u00a0${genitive(requests, 'запросом', 'запросами')} и настройками ответа`;

      return `Сессия ${shortId} будет удалена навсегда вместе с ${held}. Её адрес для приёма будет отвечать 404 любому отправителю. Это действие нельзя отменить.`;
    },
    deleteFailed: 'Не удалось удалить сессию. Попробуйте ещё раз.',
    deleteButton: 'Удалить сессию',
    deleting: 'Удаление…',
    deleted: (shortId) => `Сессия ${shortId} удалена`,
    expired: (shortId) => `Сессия ${shortId} уже истекла`,
  },

  sessions: {
    removeFromList: 'Убрать из списка',
    deleteSession: 'Удалить сессию…',
    sheetTitle: 'Сессия',
    actions: (shortId) => `Действия с сессией ${shortId}`,
    copyUrl: (shortId) => `Копировать адрес для приёма сессии ${shortId}`,
    copyRefused: 'Браузер не дал скопировать. Адрес для приёма не скопирован.',
  },

  lifetime: {
    // The approved line: the literal translation does not fit a phone's card.
    retention: (days) =>
      `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ ${days}\u00a0${plural(days, 'ДЕНЬ', 'ДНЯ', 'ДНЕЙ')} ПРОСТОЯ`,
    retentionHours: (hours) =>
      `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ ${hours}\u00a0${plural(hours, 'ЧАС', 'ЧАСА', 'ЧАСОВ')} ПРОСТОЯ`,
    retentionMinutes: (minutes) =>
      `СЕССИЯ ИСТЕКАЕТ ЧЕРЕЗ ${minutes}\u00a0${plural(minutes, 'МИНУТУ', 'МИНУТЫ', 'МИНУТ')} ПРОСТОЯ`,
    // `СЕССИЯ ИСТЕКАЕТ 26 СЕНТ. В 11:50`: the month from this dictionary's own
    // table, upper-cased by the caller (D249).
    retentionUntil: (day, month, year, time) =>
      `СЕССИЯ ИСТЕКАЕТ ${day} ${month}${year === null ? '' : ` ${year}`} В ${time}`,
    ipNotStored: 'IP НЕ СОХРАНЯЕТСЯ',
    private: 'ПРИВАТНАЯ',
  },

  session: {
    errorTitle: 'Что-то пошло не так',
    errorLines: [
      'Не удалось загрузить эту сессию.',
      'С самой сессией, скорее всего, всё в порядке; попробуйте ещё раз чуть позже.',
    ],
  },

  notFound: {
    goHome: 'На главную',
    sessionTitle: 'Сессия не найдена',
    sessionAnswer: 'Сессия недоступна',
    sessionBody:
      'Скорее всего, её удалили — намеренно или после простоя, заданного при создании, — вместе с запросами и настройками ответа.',
    pageTitle: 'Страница не найдена',
    pageBody: 'По этому адресу ничего нет. Проверьте адрес или вернитесь на главную.',
  },

  staleLink: 'Запроса по ссылке больше нет в этой сессии.',

  push: {
    position: (place, total) => `${place} из ${total}`,
    arrived: (arrived) => count(arrived, 'новый', 'новых', 'новых'),
    requests: 'Запросы',
    back: (arrived) => (arrived === null ? 'Назад к запросам' : `Назад к запросам, ${arrived}`),
  },

  endpoint: {
    receiveUrl: 'АДРЕС ДЛЯ ПРИЁМА',
  },

  list: {
    heading: 'Запросы',
    limitSuffix: (limit) => `\u00a0${plural(limit, 'запрос', 'запроса', 'запросов')}`,
    filterLabel: 'Фильтр запросов',
    closeFilter: 'Закрыть фильтр',
    clearFilter: 'Сбросить фильтр',
    retry: 'Повторить',
    noMatch: (query) => `Нет запросов, подходящих под «${query}»`,
    waitingTitle: 'Ждём первый запрос',
    waitingText: 'Отправьте любой HTTP-запрос на адрес для приёма выше. Он сразу появится здесь.',
    newestOnTop: 'Новые запросы появляются сверху.',
    compareWith: 'Сравнить с…',
    chooseFor: (method, shortId) => `Выберите запрос для сравнения с ${method} ${shortId}`,
    tapFor: (shortId) => `Выберите запрос для сравнения с ${shortId}`,
    openCannotChoose: ', открытый запрос, выбрать нельзя',
    open: 'открыт',
    compare: 'Сравнить',
    noResponseTitle: 'Для этого запроса ответ не записан',
    statusTitle: 'Записанный статус ответа',
    ruleMarker: (place) => `П${place}`,
    answeredByRule: (place) => `Ответило правило ${place}`,
    deleteRequest: 'Удалить запрос',
    requestNotDeleted: 'Не удалось удалить этот запрос.',
    requestsNotDeleted: 'Не удалось удалить эти запросы.',
  },

  filter: {
    count: (shown, total) => `${shown} из ${total}`,
    placeholder: 'Поиск по списку, заголовкам и телам',
    placeholderPhone: 'Поиск, и по телам',
    searching: 'Поиск по заголовкам и телам…',
    searchedToo: 'Заголовки и тела тоже проверены.',
    notSearchedLead: 'Заголовки и тела не проверены:',
    tookOver: (seconds) => `поиск длился дольше ${number(seconds)}\u00a0с.`,
    busy: 'сервер занят.',
    failed: 'поиск не удался.',
    wordTooLong: (bytes) => `слово длиннее ${bytes}\u00a0${genitive(bytes, 'байта', 'байт')}.`,
    tooManyWords: (words) => `больше ${words}\u00a0${genitive(words, 'слова', 'слов')}.`,
  },

  deleteAll: {
    button: 'Удалить все',
    title: 'Удалить все запросы?',
    description: (total, hidden) =>
      hidden > 0
        ? `Будут навсегда удалены все запросы этой сессии (${total}), в том числе скрытые фильтром (${hidden}). Это действие нельзя отменить.`
        : `Будут навсегда удалены все запросы этой сессии (${total}). Это действие нельзя отменить.`,
  },

  record: {
    noAddress: 'IP недоступен',
    ipNotStored: 'IP не сохраняется',
    notRecorded: 'Не записан',
    noRecordHeading: 'Ответ не записан',
    noRecordNote:
      'Для этого запроса нет сохранённого ответа. Данные самого запроса по-прежнему доступны.',
    queueStep: (step, total) => `Шаг очереди ${step} из ${total}`,
    rule: (place, method, path) => `Правило ${place} · ${method ?? 'Любой'} ${path}`,
    pending: 'Ожидание',
    failed: 'Ошибка',
    noStatusComposed: 'статус не сформирован',
    prepared: (status) => `подготовлен ${status}`,
    configuredDelay: (delayMs) => `заданная задержка: ${delayMs} ms`,
    pendingNote: 'Ждёт отправки. Подготовленный ответ показан ниже.',
    aborted: 'Отправка прервана',
    abortedNote: 'Соединение закрылось раньше, чем сервер дописал ответ.',
    unknown: 'Итог отправки неизвестен',
    unknownNote: 'Подготовленный ответ сохранён; чем закончилась отправка, неизвестно.',
    sendingFailed: 'Отправка не удалась',
    sendingFailedNote: 'Сервер дал сбой при записи ответа. Подготовленный ответ показан ниже.',
    sentByServer: 'Отправлен сервером',
    headNote: 'Подготовленное тело сохранено для просмотра. Ответы на HEAD его не отправляют.',
    bodyNotSent: 'тело не отправлено',
    binaryRecord: 'двоичная запись ответа',
    customResponse: 'свой ответ',
  },

  response: {
    default: 'По умолчанию',
    custom: 'Свой',
    settings: 'Настройки ответа',
    delayNone: 'нет',
    defaultSummary: '200 OK · JSON с описанием запроса · без задержки.',
    noDelay: 'без задержки',
    noHeaders: 'без заголовков',
    headers: (headers) => count(headers, 'заголовок', 'заголовка', 'заголовков'),
    noBody: 'без тела',
    body: 'тело',
    queued: (left) => `${left}\u00a0в очереди`,
    keptNote: (summary) =>
      `Свой ответ остаётся сохранённым — ${summary} — и вернётся, если снова выбрать «Свой».`,
    editorKeptNote:
      'Свои статус, задержка, заголовки и тело остаются сохранёнными и вернутся, если снова выбрать «Свой».',
    appliedDefault: (status) =>
      `Теперь ответ — ${status} по умолчанию, без задержки. Его получат запросы, принятые с этого момента.`,
    applied: (status, delayMs) =>
      `Теперь ответ — ${status}, ${delayMs > 0 ? `задержка ${delayMs} ms` : 'без задержки'}. Его получат запросы, принятые с этого момента.`,
    saved: 'Сохранено. Этот ответ получат запросы, принятые с этого момента.',
  },

  quick: {
    title: 'Ответ сессии',
    modeLabel: 'Ответ',
    defaultResponse: 'Ответ по умолчанию',
    httpStatus: 'HTTP-статус',
    otherStatus: 'Другой статус',
    // `Другой` does not fit the 60 px field beside the chips; it asks for a code.
    other: 'Код',
    delay: 'Задержка',
    delayLabel: 'Задержка в миллисекундах',
    editHeadersAndBody: 'Изменить заголовки и тело…',
    apply: 'Применить',
    applying: 'Применяем…',
    delayChip: (delayMs) => (delayMs === 0 ? 'Нет' : seconds(delayMs)),
    needsEmptyBody: (status) => `${status} требует пустого тела — сначала очистите тело.`,
    untouchedWithBody: (headers) =>
      `Заголовки (${headers}) и тело остаются как есть. 204 требует пустого тела.`,
    untouchedNoBody: (headers) => `Заголовки (${headers}) остаются как есть, тела нет.`,
    fromNowOn: 'Применяется к запросам, принятым с этого момента.',
    customStatus: (status) => `Свой ${status}`,
    statusRange: (min, max) => `Введите целое число от ${min} до ${max}.`,
    delayRange: (max) => `Введите целое число от 0 до ${max}.`,
    fix: (status, delay) =>
      `Исправьте ${status && delay ? 'статус и задержку' : status ? 'статус' : 'задержку'}, чтобы применить.`,
  },

  config: {
    status: (min, max) => `Статус обязателен: целое число от ${min} до ${max}.`,
    bodyForbidden: (status) =>
      `Статус ${status} требует пустого тела. Очистите тело или выберите другой статус.`,
    tooManyHeaders: (max) =>
      `Можно задать не больше ${max}\u00a0${genitive(max, 'заголовка', 'заголовков')}.`,
    nameTooLong: (bytes) =>
      `Имя заголовка — не больше ${bytes}\u00a0${genitive(bytes, 'байта', 'байт')}.`,
    nameNotToken: "Имя заголовка должно быть HTTP-токеном: буквы, цифры и символы !#$%&'*+.^_`|~-",
    valueTooLong: (bytes) =>
      `Значение заголовка — не больше ${bytes}\u00a0${genitive(bytes, 'байта', 'байт')}.`,
    valueNotVisible:
      'Значение заголовка может содержать только видимые символы ASCII, пробел и табуляцию.',
    blockTooLarge: (bytes) =>
      `Все заголовки вместе — не больше ${bytes}\u00a0${genitive(bytes, 'байта', 'байт')} в виде строк «имя: значение».`,
    reserved: 'Это имя заголовка зарезервировано приёмником, его нельзя задать.',
    locationStatus: (min, max) => `Location можно задать только со статусом от ${min} до ${max}.`,
    locationTarget: (prefix) =>
      `Location должен быть путём на этом хосте, начинающимся с ${prefix}.`,
    delay: (max) => `Задержка — целое число миллисекунд от 0 до ${max}.`,
    bodyTooLarge: (bytes) =>
      `Тело — не больше ${bytes}\u00a0${genitive(bytes, 'байта', 'байт')} в UTF-8.`,
    bodyNul: 'Тело не должно содержать U+0000.',
  },

  editor: {
    title: 'Настройки ответа сессии',
    description:
      'Статус, задержка, заголовки и тело. Изменения действуют для запросов, принятых после сохранения.',
    defaultAnswerNote:
      'По умолчанию — 200 OK с JSON-телом, где есть идентификатор запроса, без задержки.',
    waitingKeep: 'Запросы, ждущие окончания задержки, получат прежний ответ',
    afterSave: 'Новый ответ получат только запросы, принятые после сохранения.',
    save: 'Сохранить ответ',
    bodyCounter: (used, limit) => `${used} / ${limit} байт`,
    bodyLabel: 'Тело · Необязательно',
    automaticHeaders:
      'Добавляются автоматически: X-Webhook-Inspector-Request-Id, X-QA-Tools-Request-Id, X-Content-Type-Options, Content-Security-Policy; если есть тело, а Content-Type здесь не задан, — ещё и Content-Type. Зарезервированные заголовки добавить нельзя.',
    saveFailed: 'Не удалось сохранить ответ',
    applyFailed: 'Не удалось применить изменение',
    // The server's own English message after a Russian lead-in, so the field
    // it names stays visible (Decision 6, D106).
    rejected: (message) => `Сервер отклонил эту настройку: ${message}`,
    changesKept: 'Что-то пошло не так. Ваши изменения сохранены. Попробуйте ещё раз.',
    choiceKept: 'Что-то пошло не так. Ваш выбор сохранён. Попробуйте ещё раз.',
  },

  fields: {
    status: 'HTTP-статус',
    statusHint: (min, max) => `Любое целое число от ${min} до ${max}`,
    delay: 'Задержка (ms)',
    delayHint: (maxDelay) => `0–${maxDelay} ms · Приём остаётся мгновенным`,
    headers: 'Заголовки ответа',
    name: 'Имя',
    value: 'Значение',
    headerField: (place, field) =>
      field === 'name' ? `Имя заголовка ${place}` : `Значение заголовка ${place}`,
    remove: 'Удалить',
    removeHeader: (place) => `Удалить заголовок ${place}`,
    addHeader: '+ Добавить заголовок',
    bodilessStatuses: 'Статусы 204, 205 и 304 требуют пустого тела.',
  },

  template: {
    fill: 'Подставлять значения из запроса',
    insert: 'Вставить подстановку',
    hint: (example) => `Подстановки вида ${example} заменяются значениями принятого запроса.`,
    // `Идентификатор запроса`, the application's own word, over `ID запроса`
    // (the issue's derived details, D251's note).
    requestId: 'Идентификатор запроса',
    method: 'Метод',
    path: 'Путь',
    query: 'Параметр запроса…',
    header: 'Заголовок…',
    body: 'Поле JSON-тела…',
    tag: 'Шаблон',
    unknown: (placeholder) => `Неизвестная подстановка ${placeholder}.`,
    finish: (placeholder, part) =>
      `Допишите ${placeholder}: ${part === 'name' ? 'имя' : 'путь к полю'} перед }}.`,
    unclosed: 'Подстановка не закрыта: {{ без }}.',
  },

  queue: {
    title: 'Очередь ответов',
    done: 'Готово',
    setUp: 'Настроить очередь…',
    edit: 'Изменить очередь…',
    runAgain: 'Запустить снова',
    starting: 'Запускаем…',
    keep: 'Оставить очередь',
    description:
      'Отвечает первой, по одному шагу на запрос, в этом порядке. Затем все следующие запросы получают ответ сессии.',
    noStepsTitle: 'Шагов пока нет',
    noStepsText:
      'Каждый шаг отвечает на один запрос, по порядку. Пока шагов нет, все запросы получают ответ сессии.',
    addStep: '+ Добавить шаг',
    addStepHint: 'Добавьте шаг, чтобы задать его статус, задержку, заголовки и тело.',
    restartHint: 'Сохранение запускает очередь с шага 1; очистка запросов — тоже.',
    waitingKeep: 'Запросы, ждущие окончания задержки, получат прежний ответ.',
    steps: 'Шаги',
    step: (place) => `Шаг ${place}`,
    stepOfQueue: (place, total) => `Шаг ${place} из ${total} очереди ответов.`,
    stepName: (place, code, name, delay, marker) =>
      `Шаг ${place}: ${code}${name === null ? '' : ` ${name}`}${delay === '' ? '' : `, ${delay}`}${marker === 'next' ? ', следующий' : marker === 'answered' ? ', отвечен' : ''}`,
    nextTag: 'Следующий',
    thenEveryLater: 'затем все следующие запросы',
    duplicate: 'Дублировать',
    duplicateStep: 'Дублировать шаг',
    removeStep: 'Удалить шаг',
    backToSteps: 'Назад к шагам',
    delay: seconds,
    sessionDefault: (status) => `По умолчанию ${status}`,
    sessionCustom: (status, delay) => `Свой ${status}${delay === '' ? '' : ` · ${delay}`}`,
    exampleChips: ['201', `404 · ${seconds(2000)}`, '503'],
    noQueue:
      'Шагов пока нет. Отвечают раньше ответа сессии — и в режиме «По умолчанию», и в режиме «Свой».',
    everyStepAnswered: 'Все шаги отвечены — дальше ответ сессии',
    counter: (next, total) => `Шаг ${next} из ${total}`,
    leadNextThenSession: 'Следующий ответ, затем ответ сессии',
    leadNextThenRest: 'Следующий ответ, затем остальные',
    leadLastThenSession: 'Последний отвеченный, последний шаг, затем ответ сессии',
    leadLastThenRest: 'Последний отвеченный, следующий ответ, затем остальные',
    answeredLast: (chip) => `Последним ответил: ${chip}.`,
    next: (chip) => `Следующий: ${chip}.`,
    then: (chips) => `Затем ${chips.join(', ')}.`,
    thenSession: (chip) => `Затем ответ сессии, ${chip}.`,
    nextSession: (chip) => `Следующий: ответ сессии, ${chip}.`,
    saved: 'Очередь сохранена.',
    savedAhead: (statuses, custom) =>
      statuses.length === 0
        ? `Очередь сохранена, и все шаги уже ответили на запросы; следующие запросы получат ${sessionResponse(custom)}.`
        : `Очередь сохранена. ${nextRequests(statuses)}, затем — ${sessionResponse(custom)}.`,
    nothingToRestart: 'У сессии нет очереди, которую можно запустить снова.',
    restarted: (statuses, custom, started) =>
      statuses.length === 0
        ? `Очередь запущена снова с шага 1, и все шаги уже ответили на запросы; следующие запросы получат ${sessionResponse(custom)}.`
        : `Очередь ${started ? 'запущена' : 'запускается'} снова с шага 1. ${nextRequests(statuses)}.`,
    removed: 'Очередь удалена. Запросы получают только ответ сессии.',
    restartFailed: 'Не удалось запустить очередь снова. Попробуйте ещё раз.',
    placeAnswered: 'ответил на запрос в этом проходе',
    placeNextFirst: 'отвечает на следующий запрос',
    placeNext: 'следующий — отвечает на следующий запрос',
    placeAhead: (previous) => `отвечает на запрос после шага ${previous}`,
    notAStatus: 'не код статуса',
    hasError: 'есть ошибка',
    fixSteps: (steps) =>
      steps.length === 1
        ? `Исправьте шаг ${steps[0]}, чтобы сохранить очередь.`
        : `Исправьте шаги ${list(steps)}, чтобы сохранить очередь.`,
    removeShort: (steps) =>
      steps === 1 ? 'Удалить шаг?' : `Удалить все ${count(steps, 'шаг', 'шага', 'шагов')}?`,
    removeQuestion: (steps) =>
      `${steps === 1 ? 'Удалить шаг?' : `Удалить все ${count(steps, 'шаг', 'шага', 'шагов')}?`} Запросы будут получать только ответ сессии.`,
    tooLarge:
      'В JSON эта очередь больше 1 MB — слишком большая, чтобы её сохранить. Сократите тело или удалите шаг.',
    serverBusy:
      'Сервер занят сохранением других больших очередей. Ваши шаги сохранены — попробуйте ещё раз чуть позже.',
    // The server's own English message after a Russian lead-in (Decision 6, D106).
    rejected: (message) => `Сервер отклонил эту очередь: ${message}`,
    rejectedStep: (step) =>
      `Сервер отклонил шаг ${step}. Исправьте отмеченное поле и сохраните снова.`,
    rejectedStepWithReason: (step, message) => `Сервер отклонил шаг ${step}: ${message}`,
    saveFailed: 'Не удалось сохранить очередь. Ваши шаги сохранены — попробуйте ещё раз.',
    removeFailed: 'Не удалось удалить очередь. Попробуйте ещё раз.',
    saving: 'Сохраняем…',
    tryAgain: 'Попробовать снова',
    save: 'Сохранить очередь',
    removing: 'Удаляем…',
    removeQueue: 'Удалить очередь',
    remove: 'Удалить',
  },

  rules: {
    title: 'Правила ответа',
    setUp: 'Настроить правила…',
    edit: 'Изменить правила…',
    removeRules: 'Удалить правила',
    keep: 'Оставить правила',
    remove: 'Удалить',
    noRules:
      'Правил пока нет. Запрос, чьи метод и путь совпали с правилом, получает его ответ — раньше очереди и ответа сессии.',
    count: (rules) => count(rules, 'правило', 'правила', 'правил'),
    everyOther: 'Остальные запросы → ответ сессии.',
    everyOtherQueue: 'Остальные запросы → очередь, затем ответ сессии.',
    description:
      'Запрос получает ответ первого правила, с которым совпали его метод и путь. Остальным запросам отвечает очередь, если она задана, затем ответ сессии.',
    noRulesTitle: 'Правил пока нет',
    noRulesText:
      'Добавьте правило, чтобы отвечать на запросы по их методу и пути. Пока правил нет, все запросы получают ответ сессии.',
    fallbackTitle: 'Остальные запросы',
    fallbackSession: (session) => `→ ответ сессии, ${session}`,
    fallbackQueue: (session) => `→ очередь, затем ответ сессии, ${session}`,
    addRule: '+ Добавить правило',
    list: 'Правила',
    rule: (place) => `Правило ${place}`,
    checked: (place) => `проверяется ${ORDINALS[place - 1] ?? `${place}-м`}`,
    counter: (place, total) => `Правило ${place} из ${total}`,
    ruleOfList: (place, total) => `Правило ${place} из ${total} в правилах ответа.`,
    ruleName: (place, method, path, code, name, delay) =>
      `Правило ${place}: ${method} ${path} → ${code}${name === null ? '' : ` ${name}`}${delay === '' ? '' : `, ${delay}`}`,
    duplicate: 'Дублировать',
    duplicateRule: 'Дублировать правило',
    removeRule: 'Удалить правило',
    removeAll: 'Удалить все правила',
    backToRules: 'Назад к правилам',
    method: 'Метод',
    anyMethod: 'Любой',
    otherMethod: 'Другой',
    otherMethodLabel: 'Другой метод',
    path: 'Путь',
    pathHint:
      'Точный путь, строка запроса не учитывается. Поставьте * в конце, чтобы подходили все пути под ним.',
    move: (place) => `Переместить правило ${place}`,
    moveHint: 'Перетащите его или нажмите стрелку вверх или вниз, чтобы изменить порядок.',
    dragHint:
      'Перетащите ⋮⋮, чтобы изменить порядок. Сохранение действует на запросы, принятые с этого момента.',
    savingHint: 'Сохранение действует на запросы, принятые с этого момента.',
    methodRequired: 'Введите метод, например OPTIONS.',
    methodUnknown: 'Такой метод приёмник не принимает. Введите, например, OPTIONS или PROPFIND.',
    pathTooLong: (max) => `Путь длиннее ${max} символов.`,
    pathCharacters:
      'Только видимые символы ASCII: пробел и любой другой символ запишите в процентной кодировке, как %20.',
    pathQuery: 'Уберите ? и всё после него: строка запроса не сравнивается.',
    pathStar: 'Ставьте * только в конце — там он подходит к любому пути под ним.',
    pathLeadingSlash:
      'Адрес для приёма перед полем уже кончается на /, поэтому так подходит только путь, который начинается с //. Уберите первый /, если не нужны два.',
    pathFullUrl:
      'Похоже на полный адрес. Введите только путь после адреса для приёма: в таком виде он не совпадёт ни с одним обычным запросом.',
    fixRules: (rules) =>
      rules.length === 1
        ? `Исправьте правило ${rules[0]}, чтобы сохранить правила.`
        : `Исправьте правила ${list(rules)}, чтобы сохранить правила.`,
    removeShort: (rules) =>
      rules === 1
        ? 'Удалить правило?'
        : `Удалить все ${count(rules, 'правило', 'правила', 'правил')}?`,
    removeQuestion: (rules) =>
      `${rules === 1 ? 'Удалить правило?' : `Удалить все ${count(rules, 'правило', 'правила', 'правил')}?`} Запросам будет отвечать очередь, если она задана, затем ответ сессии.`,
    tooLarge:
      'В JSON эти правила больше 1 MB — слишком большие, чтобы их сохранить. Сократите тело или удалите правило.',
    serverBusy:
      'Сервер занят другими большими сохранениями. Ваши правила остаются на месте — попробуйте ещё раз чуть позже.',
    // The server's own English message after a Russian lead-in (Decision 6, D106).
    rejected: (message) => `Сервер отклонил эти правила: ${message}`,
    rejectedRule: (rule) =>
      `Сервер отклонил правило ${rule}. Исправьте отмеченное поле и сохраните снова.`,
    rejectedRuleWithReason: (rule, message) => `Сервер отклонил правило ${rule}: ${message}`,
    saveFailed: 'Не удалось сохранить правила. Они остаются на месте — попробуйте ещё раз.',
    removeFailed: 'Не удалось удалить правила. Попробуйте ещё раз.',
    save: 'Сохранить правила',
    saved: (rules) =>
      `Сохранено: ${count(rules, 'правило', 'правила', 'правил')}. Запросы, принятые с этого момента, сначала сверяются с ними.`,
    savedNone:
      'Сохранено без правил. Запросам отвечает очередь, если она задана, затем ответ сессии.',
    removed: 'Правила удалены. Запросам отвечает очередь, если она задана, затем ответ сессии.',
  },

  signature: {
    title: 'Проверить подпись',
    headerLabel: 'Заголовок с подписью',
    chooseHeader: 'Выберите заголовок',
    headerOption: (name, values) =>
      `${name} (${count(values, 'значение', 'значения', 'значений')})`,
    secretLabel: 'Секрет',
    secretPlaceholder: 'Секрет подписи',
    showSecret: 'Показать секрет',
    hideSecret: 'Скрыть секрет',
    algorithm: 'Алгоритм',
    match: 'Совпадает',
    noMatch: 'Не совпадает',
    computed: 'Вычислено',
    copyComputed: 'Копировать вычисленную подпись',
    warning:
      'Вычисляется в вашем браузере. Никуда не отправляется и не хранится. Используйте тестовый секрет.',
    noHeader: 'Выберите заголовок, в котором подпись.',
    noSecret: 'Введите секрет для проверки.',
    hint: 'Stripe, Slack и Standard Webhooks подписывают метку времени или идентификатор вместе с телом, поэтому проверка одного тела с ними никогда не совпадёт.',
    unavailable: 'Этот браузер не может вычислить HMAC на этой странице.',
    bytes: (bytes) => `${number(bytes)}\u00a0${plural(bytes, 'байт', 'байта', 'байт')}`,
    subject: (hmac, bytes) => `${hmac} тела, ${bytes}`,
    valueOf: (header, value, values) => `${header}, значение ${value} из ${values}`,
    values: (header, values) => `${header}, ${count(values, 'значение', 'значения', 'значений')}`,
  },

  compare: {
    comparing: 'Сравнение',
    change: 'Изменить',
    closeComparison: 'Закрыть сравнение',
    differs: ', есть различия',
    openMinus: 'Открытый запрос, минус',
    chosenPlus: 'Выбранный запрос, плюс',
    loading: (name) => `Загрузка ${name}…`,
    gone: (name) => `${name} больше нет в этой сессии.`,
    notLoaded: (name) => `Не удалось загрузить ${name}.`,
    chooseAnother: 'Выбрать другой',
    unchangedLines: (lines) => `${count(lines, 'строка', 'строки', 'строк')} без изменений`,
    show: 'Показать',
    removed: 'Удалено: ',
    added: 'Добавлено: ',
    noDifferences: (view) => `В ${view} различий нет.`,
    identical: 'Два запроса совпадают во всех видах.',
    tooManyChanges: 'Слишком много изменений, чтобы показать их построчно.',
    wholeDiffer: (raw) => (raw ? 'Исходные запросы различаются.' : 'Тела различаются.'),
    wholeSame: (raw, binary, size) =>
      `${raw ? 'Исходные запросы' : 'Тела'} ${binary ? 'двоичные и совпадают' : 'совпадают'}: по ${size} ${raw ? 'каждый' : 'каждое'}.`,
    wholeTooLarge: 'Тела и исходные запросы больше 256 KB сравниваются только целиком.',
    wholeOther: 'Двоичные тела, тела multipart и Raw не в UTF-8 сравниваются целиком.',
  },

  actions: {
    menu: 'Действия',
    title: 'Действия с запросом',
    copyLink: 'Копировать ссылку',
    copyCurl: 'Копировать как cURL',
    downloadJson: 'Скачать JSON',
    checkSignature: 'Проверить подпись…',
    compare: 'Сравнить с…',
    linkCopied: 'Ссылка скопирована',
    linkRefused: 'Браузер не дал скопировать. Ссылка не скопирована.',
    curlCopied: 'Команда cURL скопирована',
    curlRefused: 'Браузер не дал скопировать. Команда cURL не скопирована.',
  },

  detail: {
    noSelection: 'Запрос не выбран',
    noSelectionNote: 'Отправьте запрос на адрес для приёма, чтобы начать.',
    loading: 'Загрузка запроса…',
    loadingNote: 'Выбранный запрос появится здесь.',
    failed: 'Не удалось загрузить запрос',
    failedNote: 'Выбранный запрос по-прежнему в списке.',
    copyRawRequest: 'Копировать исходный запрос',
    copyRequestBody: 'Копировать тело запроса',
    copyRequestHeaders: 'Копировать заголовки запроса',
    copyQuery: 'Копировать параметры запроса',
    copyRawResponse: 'Копировать исходный ответ',
    copyResponseBody: 'Копировать тело ответа',
    copyResponseHeaders: 'Копировать заголовки ответа',
  },

  blocks: {
    binaryBody: 'Двоичное тело показано в Base64. Форматирование JSON недоступно.',
    bodyTooLarge: 'Форматирование недоступно для тел больше 256 KB. Исходное содержимое доступно.',
    notJson: 'Форматирование недоступно: это тело — не корректный JSON.',
    jsonTooDeep: (levels) =>
      `Форматирование недоступно: JSON с вложенностью больше ${levels}\u00a0${genitive(levels, 'уровня', 'уровней')} показан как хранится.`,
    jsonTooLong: (characters) =>
      `Форматирование недоступно: JSON, который после форматирования длиннее ${number(characters)}\u00a0${genitive(characters, 'символа', 'символов')}, показан как хранится.`,
    notXml: 'Форматирование недоступно: это тело — не корректный XML.',
    xmlDoctype: 'Форматирование недоступно: XML с DOCTYPE показан как хранится.',
    xmlTooDeep: (levels) =>
      `Форматирование недоступно: XML с вложенностью больше ${levels}\u00a0${genitive(levels, 'уровня', 'уровней')} показан как хранится.`,
    xmlTooLong: (characters) =>
      `Форматирование недоступно: XML, который после форматирования длиннее ${number(characters)}\u00a0${genitive(characters, 'символа', 'символов')}, показан как хранится.`,
    notRecognised: 'Показано как хранится: структура JSON или XML не распознана.',
    formNotUtf8: 'Не раскодировано: тело формы — не UTF-8.',
    formNoPairs: 'Не раскодировано: в теле формы нет пар имя/значение.',
    queryNotUtf8: 'Не раскодировано: строка параметров — не UTF-8.',
    queryCaption: 'Параметры относятся к входящему запросу.',
    multipartNoBoundary: 'Не разделено на части: Content-Type не объявляет границу.',
    multipartNoDelimiter:
      'Не разделено на части: граница из Content-Type не начинает ни одной части.',
    multipartNoClose: 'Не разделено на части: нет закрывающей границы.',
    multipartTooLarge: 'Не разделено на части: больше 256 KB без учёта двоичного содержимого.',
    multipartSplit: (parts) =>
      `${count(parts, 'часть', 'части', 'частей')}, разделено по границе из Content-Type.`,
    multipartPreamble: 'Содержимое до первой границы — в Raw, не в части.',
    multipartEpilogue: 'Содержимое после закрывающей границы — в Raw, не в части.',
    multipartBoth: 'Содержимое до первой границы и после закрывающей — в Raw, не в части.',
    partTitle: (place) => `Часть ${place}`,
    partText: 'текст',
    partBinary: 'двоичные данные',
    partBinaryNote: 'Двоичное содержимое не показано. Его байты — в Raw.',
    partEmpty: 'Нет содержимого.',
    bodyNotSent: 'Тело не отправлено (HEAD).',
    rawBodyBase64: 'Тело показано в Base64: в нём есть байты не в UTF-8.',
    rawHeadLatin1: 'Заголовки показаны как Latin-1: в них есть байты не в UTF-8.',
    rawRequestBase64: 'Исходный запрос показан в Base64: в нём есть байты не в UTF-8.',
    rawResponseBase64: 'Исходный ответ показан в Base64: в нём есть байты не в UTF-8.',
    wrapped: 'Длинные строки переносятся; переносы на экране не входят в содержимое.',
    addressShortened: 'Полный адрес отправителя показан выше. В строках списка адрес сокращается.',
    noRawRequest: 'Нет исходного запроса',
    noRequestBody: 'Нет тела запроса',
    noRequestBodyCaption: 'Этот запрос принят без тела.',
    noHeaders: 'Нет заголовков',
    headersCaption: 'Заголовки в том виде, в каком их получил сервер.',
    noQuery: 'Нет параметров запроса',
    responseHeadersOnly: 'В этом ответе есть заголовки и нет тела.',
    responseRecorded: 'Записанное HTTP-представление · изменения прокси не учтены.',
    noRawResponse: 'Нет исходного ответа',
    noResponseBody: 'Нет тела ответа',
    statusWithoutBody: (status) => `HTTP ${status} не содержит тела ответа.`,
    customWithoutBody: 'Этот свой ответ настроен без тела.',
    noResponseHeaders: 'Нет заголовков ответа',
    responseHeadersCaption: 'Записанные заголовки сохраняют порядок и повторяющиеся имена.',
  },
};
