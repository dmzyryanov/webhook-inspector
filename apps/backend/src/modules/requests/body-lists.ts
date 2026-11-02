/**
 * How many list answers with bodies one process writes at once (D201): four,
 * across `GET .../requests` and `POST .../requests/query`.
 *
 * Each such answer is written as it is read (`list-answer.ts`, D196), but it
 * takes seconds and up to 120 MiB of JSON, and the process allocates what it
 * sends faster than it collects it: D196 measured the extra memory of 1, 2, 4
 * and 8 at once at about 85, 130, 210 and 335 MiB, against the backend's
 * 512 MiB. A limit per minute bounds none of that, so the answers being
 * written are counted: the fifth is refused at once, `429` / `1016` with
 * `Retry-After`, never queued.
 *
 * A place is taken before the list statement runs and given back when the
 * answer is over: written to its end, failed, or its stream destroyed, which
 * is what happens when the client goes, and to a `HEAD`'s before it is read
 * (#210) - or as soon as the client goes, before the answer is begun, while
 * its list statement runs. An answer with headers alone, or without
 * `include`, takes none. A list call held by `wait` (D200) takes none while
 * it waits, only once it has requests to write, so calls waiting for a
 * webhook never shut out the other lists with bodies.
 *
 * Separate from the search's two slots (D191), which a query of requests
 * takes as well while its statement runs. The count lives in the process:
 * there is one outside a rollout, and two for its seconds (D221).
 */
import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { MAX_CONCURRENT_BODY_LISTS } from '@webhook-inspector/shared';
import { listBodiesBusy } from '../../errors/app-error.ts';
import { createSlots, type Slots } from '../../lib/slots.ts';
import type { ListQuery } from './list-query.ts';

/** The places of list answers with bodies in one process. */
export type BodyListPlaces = Slots;

export function createBodyListPlaces(limit: number = MAX_CONCURRENT_BODY_LISTS): BodyListPlaces {
  return createSlots(limit);
}

/** What an answer that took no place gives back: nothing. */
export const NO_PLACE = (): void => {};

/**
 * Takes a place for an answer to `query` when it includes bodies, and answers
 * with what gives it back; `429` / `1016` when every place is taken. An answer
 * without bodies takes none and gets `NO_PLACE`.
 *
 * The place is given back when `response` closes, from the moment it is
 * taken: once the answer has been written, or as soon as the client has gone,
 * even while the list statement is still running and no answer has begun - a
 * client gone then would otherwise keep its place until the statement
 * settles, which a slow or stuck one may not do for a long time. The answer's
 * own stream gives it back too, once it exists (`releaseWhenAnswered`), and a
 * route gives it back when it fails before then; giving a place back twice
 * gives it back once (`Slots`), so whichever comes first counts.
 */
export function takeBodyListPlace(
  places: BodyListPlaces,
  query: ListQuery,
  response: ServerResponse,
): () => void {
  if (!query.includeBody) {
    return NO_PLACE;
  }

  const release = places.tryTake();

  if (release === null) {
    throw listBodiesBusy();
  }

  if (response.destroyed) {
    release();
  } else {
    response.once('close', release);
  }

  return release;
}

/**
 * Gives a place back once the answer written from `stream` is over: when the
 * stream closes - it has ended, failed or been destroyed. The response's close
 * gives it back as well, from when the place was taken (`takeBodyListPlace`),
 * which covers an answer whose stream is never written at all.
 */
export function releaseWhenAnswered(stream: Readable, release: () => void): void {
  if (release === NO_PLACE) {
    return;
  }

  if (stream.destroyed) {
    release();

    return;
  }

  stream.once('close', release);
}
