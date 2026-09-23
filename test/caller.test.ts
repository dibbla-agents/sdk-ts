import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Caller, callerFromEvent, IDENTITY_USER_AUTHENTICATED, MetaKeys } from '../src/caller';
import { EventMessage, createEmptyEventMessage } from '../src/types/events';

const withMeta = (meta: Record<string, unknown> | null): EventMessage => ({ ...createEmptyEventMessage(), meta });

describe('caller identity', () => {
  it('is absent when the platform asserted nothing', () => {
    assert.equal(callerFromEvent(null), null);
    assert.equal(callerFromEvent(withMeta(null)), null);
    assert.equal(callerFromEvent(withMeta({})), null);
    // An org without an identity mode is not a caller.
    assert.equal(callerFromEvent(withMeta({ [MetaKeys.AssertedOrgId]: 'org-1' })), null);
  });

  it('reads the asserted fields', () => {
    const c = callerFromEvent(
      withMeta({
        asserted_identity: 'user-authenticated',
        asserted_user_id: 'user-42',
        asserted_user_email: 'ada@example.com',
        asserted_user_name: 'Ada',
        asserted_org_id: 'org-1',
        asserted_org_role: 'owner',
      }),
    );
    assert.ok(c);
    assert.ok(c.isUser());
    assert.deepEqual(
      { ...c },
      { userId: 'user-42', email: 'ada@example.com', name: 'Ada', orgId: 'org-1', orgRole: 'owner', identity: 'user-authenticated' },
    );
  });

  it('requires both the user identity mode and a subject for isUser', () => {
    assert.ok(!new Caller({ identity: 'some-future-mode', userId: 'user-42' }).isUser());
    assert.ok(!new Caller({ identity: IDENTITY_USER_AUTHENTICATED }).isUser());
  });

  it('reads non-string values as empty instead of throwing', () => {
    const c = callerFromEvent(withMeta({ asserted_identity: 'user-authenticated', asserted_user_id: 'user-42', asserted_org_role: 42 }));
    assert.equal(c?.orgRole, '');
  });

  it('pins the meta keys to the platform contract', () => {
    assert.deepEqual(MetaKeys, {
      AssertedOrgId: 'asserted_org_id',
      AssertedIdentity: 'asserted_identity',
      AssertedUserId: 'asserted_user_id',
      AssertedUserEmail: 'asserted_user_email',
      AssertedUserName: 'asserted_user_name',
      AssertedOrgRole: 'asserted_org_role',
    });
  });
});
