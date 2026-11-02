/** Types for `changelog.mjs`, imported by the Vite configurations and the tests. */
export interface ChangelogEntry {
  version: string;
  date: string;
  headline: string;
  lead: string;
  paragraphs: string[];
  breaking: boolean;
  deprecated: boolean;
  notice: boolean;
}

/** Which of the two Atom feeds (D212). */
export type FeedKind = 'all' | 'breaking';

export interface Feed {
  path: string;
  id: string;
  title: string;
  subtitle: string;
  includes: (entry: ChangelogEntry) => boolean;
}

/** An entry of a feed `changelogFeed` wrote, as `readFeedEntries` reads it. */
export interface FeedEntry {
  id: string | undefined;
  title: string | undefined;
  updated: string | undefined;
  link: string | undefined;
  content: string | undefined;
}

export const CHANGELOG_SOURCE: string;
export const PAGE_PLACEHOLDER: string;
export const SITE_URL: string;
export const CHANGELOG_URL: string;
export const CHANGELOG_MD_PATH: string;
export const FEED_PATH: string;
export const BREAKING_FEED_PATH: string;
export const BREAKING_PREFIX: string;
export const DEPRECATED_PREFIX: string;
export const NOTICE_PREFIX: string;
export const PUBLIC_HEADER: string;
export const FEEDS: Record<FeedKind, Feed>;
export const UNPUBLISHABLE: [string, RegExp][];

export function isNoticeParagraph(paragraph: string): boolean;
export function hasNotice(entry: ChangelogEntry): boolean;
export function noticeBadge(entry: ChangelogEntry): 'Breaking' | 'Deprecated' | 'Notice' | null;
export function stripReferences(text: string): string;
export function parseChangelog(source: string): ChangelogEntry[];
export function changelogMarkdown(entries: ChangelogEntry[]): string;
export function escapeXml(text: string): string;
export function unescapeXml(text: string): string;
export function feedEntryId(version: string): string;
export function entryHtml(entry: ChangelogEntry): string;
export function plainText(markdown: string): string;
export function changelogFeed(entries: ChangelogEntry[], kind?: FeedKind): string;
export function readFeedEntries(xml: string): FeedEntry[];
export function escapeHtml(text: string): string;
export function renderInline(markdown: string): string;
export function formatDay(day: string): string;
export function versionCount(count: number): string;
export function groupByDay(
  entries: ChangelogEntry[],
): { date: string; entries: ChangelogEntry[] }[];
export function renderChangelogBody(entries: ChangelogEntry[]): string;
export function readChangelog(file?: string): ChangelogEntry[];
export function renderChangelogPage(template: string, entries: ChangelogEntry[]): string;
export function changelogPagePlugin(): import('vite').Plugin;
export function publishedTextProblems(text: string): string[];
export function pageText(html: string): string;
