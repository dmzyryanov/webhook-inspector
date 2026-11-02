/** Types for `about.mjs`, imported by the Vite configurations and the tests. */
import type { AboutCopy } from '../src/lib/about-copy.ts';

export const ABOUT_PLACEHOLDER: string;
export const ABOUT_TEMPLATE: string;
export const ABOUT_PAGE: string;
export const RUSSIAN_ABOUT_PAGE: string;
export const ABOUT_PAGES: readonly AboutCopy[];
export const ABOUT_EN: AboutCopy;
export const ABOUT_RU: AboutCopy;
export const ABOUT_TITLE: string;
export const ABOUT_DESCRIPTION: string;
export const ABOUT_URL: string;

export function aboutTemplate(page: AboutCopy): string;
export function aboutPageOf(path: string): AboutCopy | undefined;
export function renderAboutBody(page?: AboutCopy): string;
export function renderAboutPage(template: string, page?: AboutCopy): string;
export function aboutPagePlugin(): import('vite').Plugin;
