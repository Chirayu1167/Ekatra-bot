import crypto, { timingSafeEqual } from 'node:crypto';
import { isUniqueViolation, iso, query } from '../db/pg';
import type { PgDb } from '../db/pg';
import { ConflictError, NotFoundError } from '../errors';

export type AdminRole = 'platform_admin' | 'org_admin' | 'instructor';

export interface AdminPrincipal {
  /** admin_users id, or null for the bootstrap ADMIN_API_KEY. */
  userId: number | null;
  /** Null = platform scope. */
  orgId: number | null;
  role: AdminRole;
  bootstrap: boolean;
}

export interface AdminUser {
  id: number;
  orgId: number | null;
  name: string;
  role: AdminRole;
  createdAt: string;
  keys?: AdminApiKeyMetadata[];
}

export interface AdminApiKeyMetadata {
  id: number;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface IssuedKey {
  id: number;
  userId: number;
  prefix: string;
  /** Plaintext: returned once at creation, never stored or logged. */
  plaintext: string;
  expiresAt: string | null;
}

interface UserRow {
  id: number;
  org_id: number | null;
  name: string;
  role: AdminRole;
  created_at: Date | string;
}

const toUser = (r: UserRow): AdminUser => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  role: r.role,
  createdAt: iso(r.created_at),
});

/** High-entropy admin API keys. Only SHA-256 hashes touch the database. */
export class AdminAuthService {
  constructor(private readonly db: PgDb) {}

  async hasUsers(): Promise<boolean> {
    const { rows } = await query<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM admin_users');
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async createUser(orgId: number | null, name: string, role: AdminRole): Promise<AdminUser> {
    if (!['platform_admin', 'org_admin', 'instructor'].includes(role)) {
      throw new ConflictError('Unknown role');
    }
    if (role === 'platform_admin' && orgId !== null) {
      throw new ConflictError('platform_admin has no org');
    }
    if (role !== 'platform_admin' && orgId === null) {
      throw new ConflictError(`${role} needs an org`);
    }
    if (orgId !== null) {
      const { rows } = await query<{ one: number }>(
        this.db,
        'SELECT 1 AS one FROM organisations WHERE id = $1',
        [orgId],
      );
      if (rows.length === 0) throw new NotFoundError('Organisation not found');
    }
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new ConflictError('User needs a name');
    const { rows } = await query<UserRow>(
      this.db,
      'INSERT INTO admin_users (org_id, name, role) VALUES ($1, $2, $3) RETURNING *',
      [orgId, clean, role],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Failed to create user');
    return toUser(row);
  }

  async getUser(id: number): Promise<AdminUser | undefined> {
    const { rows } = await query<UserRow>(this.db, 'SELECT * FROM admin_users WHERE id = $1', [id]);
    const row = rows[0];
    return row && toUser(row);
  }

  async listUsers(orgId: number | null): Promise<AdminUser[]> {
    const { rows } =
      orgId === null
        ? await query<UserRow>(this.db, 'SELECT * FROM admin_users ORDER BY id')
        : await query<UserRow>(this.db, 'SELECT * FROM admin_users WHERE org_id = $1 ORDER BY id', [
            orgId,
          ]);
    const users = rows.map(toUser);
    if (users.length === 0) return users;
    const keys = await query<{
      id: number;
      user_id: number;
      prefix: string;
      created_at: Date | string;
      revoked_at: Date | string | null;
    }>(
      this.db,
      `SELECT id, user_id, prefix, created_at, revoked_at
       FROM admin_api_keys WHERE user_id = ANY($1::bigint[]) ORDER BY id DESC`,
      [users.map((user) => user.id)],
    );
    const byUser = new Map<number, AdminApiKeyMetadata[]>();
    for (const key of keys.rows) {
      const userKeys = byUser.get(key.user_id) ?? [];
      userKeys.push({
        id: key.id,
        prefix: key.prefix,
        createdAt: iso(key.created_at),
        revokedAt: key.revoked_at === null ? null : iso(key.revoked_at),
      });
      byUser.set(key.user_id, userKeys);
    }
    return users.map((user) => ({ ...user, keys: byUser.get(user.id) ?? [] }));
  }

  async issueKey(userId: number, expiresAt: string | null = null): Promise<IssuedKey> {
    const user = await this.getUser(userId);
    if (!user) throw new NotFoundError('User not found');
    const plaintext = `ek_live_${crypto.randomBytes(32).toString('base64url')}`;
    const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
    try {
      const { rows } = await query<{ id: number }>(
        this.db,
        'INSERT INTO admin_api_keys (user_id, key_hash, prefix, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [userId, hash, plaintext.slice(0, 11), expiresAt],
      );
      const row = rows[0];
      if (!row) throw new NotFoundError('Failed to issue key');
      return {
        id: row.id,
        userId,
        prefix: plaintext.slice(0, 11),
        plaintext,
        expiresAt,
      };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('Key collision, try again');
      throw err;
    }
  }

  /** Key metadata (never hashes or plaintext): used to scope revoke to the key's owner. */
  async getKey(keyId: number): Promise<{ id: number; userId: number; revoked: boolean } | undefined> {
    const { rows } = await query<{ id: number; user_id: number; revoked_at: Date | string | null }>(
      this.db,
      'SELECT id, user_id, revoked_at FROM admin_api_keys WHERE id = $1',
      [keyId],
    );
    const row = rows[0];
    return row && { id: row.id, userId: row.user_id, revoked: row.revoked_at !== null };
  }

  async revokeKey(keyId: number): Promise<void> {
    const { rowCount } = await query(
      this.db,
      'UPDATE admin_api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [keyId],
    );
    if (rowCount !== 1) throw new NotFoundError('Key not found');
  }

  /** Revoke every live key of a user (used by rotate and recover). Returns revoked ids. */
  async revokeUserKeys(userId: number): Promise<number[]> {
    const { rows } = await query<{ id: number }>(
      this.db,
      'SELECT id FROM admin_api_keys WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    for (const row of rows) {
      await this.revokeKey(row.id);
    }
    return rows.map((r) => r.id);
  }

  /**
   * Verify a presented key. Returns the principal or null (unknown, revoked, expired).
   * Comparison is constant-time over the hashes. Records last_used_at on success.
   */
  async authenticate(presented: string): Promise<AdminPrincipal | null> {
    const hash = crypto.createHash('sha256').update(presented).digest();
    const { rows } = await query<{
      id: number;
      revoked_at: Date | string | null;
      expires_at: Date | string | null;
      user_id: number;
      org_id: number | null;
      role: AdminRole;
    }>(
      this.db,
      `SELECT k.id, k.revoked_at, k.expires_at, u.id AS user_id, u.org_id, u.role
       FROM admin_api_keys k JOIN admin_users u ON u.id = k.user_id
       WHERE k.key_hash = $1`,
      [hash.toString('hex')],
    );
    const row = rows[0];
    if (!row) return null;
    // Belt and braces: the UNIQUE index already selected the exact hash, but compare
    // constant-time anyway so timing reveals nothing about key validity.
    const stored = Buffer.from(hash.toString('hex'), 'utf8');
    const given = Buffer.from(
      crypto.createHash('sha256').update(presented).digest('hex'),
      'utf8',
    );
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at !== null && iso(row.expires_at) <= new Date().toISOString()) return null;
    await query(this.db, 'UPDATE admin_api_keys SET last_used_at = now() WHERE id = $1', [row.id]);
    return { userId: row.user_id, orgId: row.org_id, role: row.role, bootstrap: false };
  }

  async recordAudit(
    actorUserId: number | null,
    orgId: number | null,
    action: string,
    target = '',
  ): Promise<void> {
    await query(
      this.db,
      'INSERT INTO audit_log (actor_user_id, org_id, action, target) VALUES ($1, $2, $3, $4)',
      [actorUserId, orgId, action, target.slice(0, 200)],
    );
  }

  async listAudit(
    orgId: number | null,
    limit = 100,
  ): Promise<{
    id: number;
    actorUserId: number | null;
    orgId: number | null;
    action: string;
    target: string;
    createdAt: string;
  }[]> {
    const { rows } =
      orgId === null
        ? await query<{
            id: number;
            actor_user_id: number | null;
            org_id: number | null;
            action: string;
            target: string;
            created_at: Date | string;
          }>(
            this.db,
            'SELECT id, actor_user_id, org_id, action, target, created_at FROM audit_log ORDER BY id DESC LIMIT $1',
            [limit],
          )
        : await query<{
            id: number;
            actor_user_id: number | null;
            org_id: number | null;
            action: string;
            target: string;
            created_at: Date | string;
          }>(
            this.db,
            'SELECT id, actor_user_id, org_id, action, target, created_at FROM audit_log WHERE org_id = $1 ORDER BY id DESC LIMIT $2',
            [orgId, limit],
          );
    return rows.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      orgId: r.org_id,
      action: r.action,
      target: r.target,
      createdAt: iso(r.created_at),
    }));
  }
}
