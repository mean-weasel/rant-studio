import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthorityError,
  assertAuthorized,
  type Actor,
} from '../../packages/model/src/index.ts';

const human: Actor = { id: 'human-browser', kind: 'human' };
const agent: Actor = { id: 'agent-codex', kind: 'agent' };

test('service authority permits additive agent work but rejects protected decisions', () => {
  assert.doesNotThrow(() => assertAuthorized(agent, 'attach_candidate'));
  assert.doesNotThrow(() => assertAuthorized(agent, 'add_note'));
  assert.doesNotThrow(() => assertAuthorized(agent, 'submit_proposal'));

  assert.throws(
    () => assertAuthorized(agent, 'select_visual'),
    (error: unknown) =>
      error instanceof AuthorityError &&
      error.code === 'FORBIDDEN' &&
      error.operation === 'select_visual',
  );
  assert.doesNotThrow(() => assertAuthorized(human, 'select_visual'));
  assert.doesNotThrow(() => assertAuthorized(human, 'accept_proposal'));
});

test('authority rejects unknown operations instead of defaulting open', () => {
  assert.throws(
    () => assertAuthorized(agent, 'publish_video' as never),
    (error: unknown) => error instanceof AuthorityError && error.code === 'FORBIDDEN',
  );
});
