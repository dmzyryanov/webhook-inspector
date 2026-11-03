import { PRODUCTION_OPERATOR_ENV } from './production-operator-env.ts';
import { parseOperator, type Operator, type OperatorWithTexts } from '../lib/operator.ts';

export { PRODUCTION_OPERATOR_ENV };

/**
 * Production's operator for the tests (issue #369): `PRODUCTION_OPERATOR_ENV`
 * as the build reads it, its texts shown. The environment module is imported
 * first, so a test that imports only this module still finds the settings in
 * the environment when `OPERATOR` is read.
 */
export const PRODUCTION_OPERATOR = parseOperator(PRODUCTION_OPERATOR_ENV) as OperatorWithTexts;

/** `env` without the three settings: a build's environment with none of them. */
export function withoutOperator(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const rest = { ...env };

  for (const name of Object.keys(PRODUCTION_OPERATOR_ENV)) {
    delete rest[name];
  }

  return rest;
}

/** The settings of `operator` as a build's environment gives them, every unset one empty. */
export function operatorEnv(operator: Operator): Record<string, string> {
  return {
    STATUS_PAGE_URL: operator.statusPageUrl ?? '',
    CONTACT_EMAIL: operator.contactEmail ?? '',
    OPERATOR_TEXTS: operator.texts ? 'true' : '',
  };
}
