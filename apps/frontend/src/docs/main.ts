/**
 * The API reference at `/docs` (D155): a page of its own, built by Vite as a
 * second entry beside the application, so Scalar never enters the
 * application's bundle and the application never enters this one.
 *
 * Nothing about the API is written here. Scalar reads `/openapi.json` from this
 * origin when the page loads, and the introduction is that file's
 * `info.description`.
 */
import { createApiReference } from '@scalar/api-reference';
import '@scalar/api-reference/style.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import { referenceConfiguration } from './reference-config.ts';

createApiReference('#api-reference', referenceConfiguration(window.location.origin));
