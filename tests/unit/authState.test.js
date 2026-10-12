import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAuthTransition } from '../../src/lib/authState.js';

const session = (userId, accessToken = `${userId}-token`) => ({
  access_token: accessToken,
  user: { id: userId }
});
test('initial session and account switch require blocking profile validation', () => {
  assert.deepEqual(classifyAuthTransition({
    event: 'INITIAL_SESSION',
    currentSession: null,
    nextSession: session('user-1')
  }), {
    kind: 'identity-changed',
    userId: 'user-1',
    blockingProfileCheck: true
  });

  assert.deepEqual(classifyAuthTransition({
    event: 'SIGNED_IN',
    currentSession: session('user-1'),
    nextSession: session('user-2'),
    validatedUserId: 'user-1'
  }), {
    kind: 'identity-changed',
    userId: 'user-2',
    blockingProfileCheck: true
  });
});

test('same-user token refresh and duplicate sign-in revalidate without blocking mounted app', () => {
  for (const event of ['TOKEN_REFRESHED', 'SIGNED_IN']) {
    assert.deepEqual(classifyAuthTransition({
      event,
      currentSession: session('user-1', 'old-token'),
      nextSession: session('user-1', 'new-token'),
      validatedUserId: 'user-1'
    }), {
      kind: 'same-user',
      userId: 'user-1',
      blockingProfileCheck: false
    });
  }
});

test('same-user refresh remains blocking until profile has been validated', () => {
  assert.equal(classifyAuthTransition({
    event: 'TOKEN_REFRESHED',
    currentSession: session('user-1', 'old-token'),
    nextSession: session('user-1', 'new-token')
  }).blockingProfileCheck, true);
});

test('signed-out and missing-user sessions revoke authentication', () => {
  assert.equal(classifyAuthTransition({
    event: 'SIGNED_OUT',
    currentSession: session('user-1'),
    nextSession: null,
    validatedUserId: 'user-1'
  }).kind, 'signed-out');
  assert.equal(classifyAuthTransition({
    event: 'TOKEN_REFRESHED',
    currentSession: session('user-1'),
    nextSession: { access_token: 'invalid' },
    validatedUserId: 'user-1'
  }).kind, 'signed-out');
});
