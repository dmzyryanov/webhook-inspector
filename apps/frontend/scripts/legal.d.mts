/** Types for `legal.mjs`, imported by the Vite configurations and the tests. */
import type { LegalPage } from '../src/lib/legal-copy.ts';

/** This build's pages: both when it shows the operator's texts, none otherwise (issue #369). */
export const LEGAL_PAGES: readonly LegalPage[];
export const LEGAL_PLACEHOLDER: string;

export function legalTemplate(page: LegalPage): string;
export function renderLegalBody(page: LegalPage): string;
export function renderLegalPage(page: LegalPage, template: string): string;
export function legalPagesPlugin(): import('vite').Plugin;
