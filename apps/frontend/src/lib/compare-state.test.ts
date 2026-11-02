/**
 * `Compare with…`'s states (#75, D186): `Cancel`, Escape and Back leave
 * picking with nothing changed - back to the comparison `Change` started
 * from, on its view, or to the open request.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cancelPicking, chooseRequest, startPicking, withView } from './compare-state.ts';

const chosen = { id: '9b14d3a' };

describe('compare-state', () => {
  it('returns to the open request when picking began in the request actions', () => {
    const picking = startPicking<typeof chosen>(null);

    assert.deepEqual(picking, { phase: 'picking', previous: null });
    assert.equal(cancelPicking(picking), null);
  });

  it('returns to the comparison, on its view, when picking began with Change', () => {
    const comparing = withView(chooseRequest(chosen), 'headers');
    const picking = startPicking(comparing);

    assert.deepEqual(picking, { phase: 'picking', previous: { chosen, view: 'headers' } });
    assert.deepEqual(cancelPicking(picking), { phase: 'comparing', chosen, view: 'headers' });
  });

  it('starts a chosen request on its opening view', () => {
    assert.deepEqual(chooseRequest(chosen), { phase: 'comparing', chosen, view: null });
  });

  it('keeps what picking started from when picking is asked for again', () => {
    const picking = startPicking(chooseRequest(chosen));

    assert.equal(startPicking(picking), picking);
  });

  it('changes nothing it is not about', () => {
    const comparing = chooseRequest(chosen);

    assert.equal(cancelPicking(comparing), comparing);
    assert.equal(cancelPicking(null), null);
    assert.equal(withView(null, 'raw'), null);

    const picking = startPicking<typeof chosen>(null);

    assert.equal(withView(picking, 'raw'), picking);
  });
});
