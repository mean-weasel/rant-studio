import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeShotPlanningRequest,
  shotPlanningInstruction,
} from '../../packages/model/src/index.ts';

test('semantic planning normalizes discover mode with a soft target', () => {
  const planning = normalizeShotPlanningRequest({
    briefs: [],
    direction: 'Prefer complete rhetorical thoughts.',
    maxDurationMs: 12_000,
    maxWordsPerShot: 32,
    minDurationMs: 4_000,
    mode: 'discover',
    targetShotCount: 3,
  });
  assert.equal(planning.mode, 'discover');
  assert.equal(planning.targetShotCount, 3);
  assert.match(
    shotPlanningInstruction(planning, 'Standard'),
    /soft target, not an equal partition/,
  );
});

test('outline mode preserves ordered briefs and rejects ambiguous input', () => {
  const planning = normalizeShotPlanningRequest({
    briefs: [
      {
        direction: 'State the misconception.',
        id: 'opening',
        title: 'Premise',
      },
      { direction: 'Land the counterpoint.', id: 'turn', title: 'The turn' },
    ],
    direction: '',
    maxDurationMs: null,
    maxWordsPerShot: null,
    minDurationMs: null,
    mode: 'outline',
    targetShotCount: 2,
  });
  assert.deepEqual(
    planning.briefs.map((brief) => brief.id),
    ['opening', 'turn'],
  );
  assert.throws(
    () =>
      normalizeShotPlanningRequest({
        briefs: [],
        direction: '',
        mode: 'outline',
        targetShotCount: 3,
      }),
    /needs direction or ordered shot briefs/,
  );
});

test('advanced constraints reject inverted duration bounds', () => {
  assert.throws(
    () =>
      normalizeShotPlanningRequest({
        briefs: [],
        direction: '',
        maxDurationMs: 2_000,
        minDurationMs: 4_000,
        mode: 'discover',
        targetShotCount: 3,
      }),
    /cannot exceed/,
  );
});
