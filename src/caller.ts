import { EventMessage } from './types/events';

/**
 * Meta keys the platform sets on an invocation from the validated principal.
 * They mirror core/workflow-server/types/eventmeta.go byte for byte (the two
 * sides agree by string, not shared code) and are never read from a
 * function's inputs.
 */
export const MetaKeys = {
  AssertedOrgId: 'asserted_org_id',
  AssertedIdentity: 'asserted_identity',
  AssertedUserId: 'asserted_user_id',
  AssertedUserEmail: 'asserted_user_email',
  AssertedUserName: 'asserted_user_name',
  AssertedOrgRole: 'asserted_org_role',
} as const;

/**
 * A signed-in user called the function directly (platform MCP, API or CLI);
 * the Caller describes that person.
 */
export const IDENTITY_USER_AUTHENTICATED = 'user-authenticated';

/**
 * The platform-verified identity behind an invocation.
 *
 * A function exposed as a directly callable tool runs on behalf of a person,
 * and what it reads or writes should be authorized for that person, not for
 * whoever deployed the worker. These values are set by the platform from the
 * validated principal and travel outside the payload, so a caller cannot
 * assert an identity it does not hold. Never take identity from inputs: the
 * caller writes both the question and the answer there.
 */
export class Caller {
  /** Stable platform user id. Prefer it as a database key; an email can be reassigned. */
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  /** The organization the call was made in. A single-org worker should reject any other. */
  readonly orgId: string;
  readonly orgRole: string;
  /**
   * How the caller was established, e.g. IDENTITY_USER_AUTHENTICATED. Compare
   * against it rather than assuming any Caller is an interactive user: future
   * modes will land here.
   */
  readonly identity: string;

  constructor(fields: { userId?: string; email?: string; name?: string; orgId?: string; orgRole?: string; identity: string }) {
    this.userId = fields.userId ?? '';
    this.email = fields.email ?? '';
    this.name = fields.name ?? '';
    this.orgId = fields.orgId ?? '';
    this.orgRole = fields.orgRole ?? '';
    this.identity = fields.identity;
  }

  /**
   * Whether the call carries an authenticated end user. A function that reads
   * per-user data should refuse when this is false rather than fall back to a
   * default identity.
   */
  isUser(): boolean {
    return this.identity === IDENTITY_USER_AUTHENTICATED && this.userId !== '';
  }
}

/**
 * The verified caller of an invocation, or null when the platform asserted
 * none — an invocation inside a workflow run, for instance, which runs under
 * the workflow's authority rather than a live user's. Treat null as "no
 * user", never as "some default user".
 */
export function callerFromEvent(event: EventMessage | null | undefined): Caller | null {
  const meta = event?.meta;
  if (!meta) return null;
  const str = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : '');
  const identity = str(MetaKeys.AssertedIdentity);
  if (identity === '') return null;
  return new Caller({
    userId: str(MetaKeys.AssertedUserId),
    email: str(MetaKeys.AssertedUserEmail),
    name: str(MetaKeys.AssertedUserName),
    orgId: str(MetaKeys.AssertedOrgId),
    orgRole: str(MetaKeys.AssertedOrgRole),
    identity,
  });
}
