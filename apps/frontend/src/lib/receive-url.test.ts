import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { receiveOrigin, sessionReceiveUrl } from './receive-url.ts';

const ID = 'G4t2kM8qVYp3Xn6wRz9BcH1LdF7SaJ0eU5iKcN2mQxA';

describe('sessionReceiveUrl (D187)', () => {
  it('is the receiveUrl the API gives, not an address on the page origin', () => {
    assert.equal(
      sessionReceiveUrl(
        { id: ID, receiveUrl: `https://hook.qa-tools.ru/s/${ID}` },
        'https://qa-tools.ru',
      ),
      `https://hook.qa-tools.ru/s/${ID}`,
    );
  });

  it('falls back to the page origin for an answer from a backend older than 0.36.0', () => {
    assert.equal(
      sessionReceiveUrl({ id: ID }, 'https://qa-tools.ru'),
      `https://qa-tools.ru/s/${ID}`,
    );
  });
});

describe('receiveOrigin (D187)', () => {
  it('is the scheme, host and port of the receive URL', () => {
    assert.equal(receiveOrigin(`https://hook.qa-tools.ru/s/${ID}`), 'https://hook.qa-tools.ru');
    assert.equal(receiveOrigin(`http://127.0.0.1:3001/s/${ID}`), 'http://127.0.0.1:3001');
  });
});
