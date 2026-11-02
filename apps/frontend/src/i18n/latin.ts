/**
 * The Latin words Russian keeps (Decision 7, D222): the tabs `Raw`, `Body`,
 * `Headers`, `Query`, `Request` and `Response`; method names (`HEAD`, and
 * `OPTIONS` and `PROPFIND`, which the response rules name as examples); status
 * reason phrases (`OK`); header names (`Content-Type`, `Location`,
 * `X-Webhook-Inspector-Request-Id` …); the units `B`, `KB`, `MB` and `ms`; `cURL`,
 * `JSON` and `API docs`. Then the names that have no Russian word: the
 * product, `QA Tools`; `HTTP` and `IP`, which the approved frames keep;
 * formats, encodings and algorithms - `XML`, `DOCTYPE`, `multipart`, `UTF-8`,
 * `ASCII`, `Latin-1`, `Base64`, `HMAC`, `U+0000`; and the products a text
 * names: `CI`, `Postman`, `Stripe`, `Slack`, `Standard Webhooks`, and the
 * service's own name, `Webhook Inspector`, which the move banner says (issue
 * #321) and the header and the tab's title too (issue #322, D277). Matched as
 * runs of Latin letters, so `Base64` is `Base` and `UTF-8` is `UTF`.
 *
 * One list for both checks that hold Russian to it: the dictionary's
 * (`i18n.test.ts`) and every screen's (E2E-17, `e2e/language.spec.ts`), which
 * adds only what the screens draw outside the dictionary. Nothing in the
 * application imports it.
 */
export const LATIN_IN_RUSSIAN: ReadonlySet<string> = new Set([
  'Raw',
  'Body',
  'Headers',
  'Query',
  'Request',
  'Response',
  'HEAD',
  'OPTIONS',
  'PROPFIND',
  'OK',
  'Content',
  'Type',
  'Security',
  'Policy',
  'Options',
  'Location',
  'X',
  'Id',
  'B',
  'KB',
  'MB',
  'ms',
  'cURL',
  'JSON',
  'API',
  'docs',
  'QA',
  'Tools',
  'HTTP',
  'IP',
  'XML',
  'DOCTYPE',
  'multipart',
  'UTF',
  'ASCII',
  'Latin',
  'Base',
  'HMAC',
  'U',
  'CI',
  'Postman',
  'Stripe',
  'Slack',
  'Standard',
  'Webhooks',
  'Webhook',
  'Inspector',
]);
