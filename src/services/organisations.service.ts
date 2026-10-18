import { isUniqueViolation, iso, query } from '../db/pg';
import type { PgDb } from '../db/pg';
import { ConflictError, NotFoundError } from '../errors';

export interface Organisation {
  id: number;
  slug: string;
  name: string;
  createdAt: string;
}

interface OrganisationRow {
  id: number;
  slug: string;
  name: string;
  created_at: Date | string;
}

function toOrg(row: OrganisationRow): Organisation {
  return { id: row.id, slug: row.slug, name: row.name, createdAt: iso(row.created_at) };
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Tenant registry. Slugs are validated here so route layers never trust raw client input. */
export class OrganisationsService {
  constructor(private readonly db: PgDb) {}

  async list(): Promise<Organisation[]> {
    const { rows } = await query<OrganisationRow>(
      this.db,
      'SELECT id, slug, name, created_at FROM organisations ORDER BY id',
    );
    return rows.map(toOrg);
  }

  async getBySlug(slug: string): Promise<Organisation | undefined> {
    const { rows } = await query<OrganisationRow>(
      this.db,
      'SELECT id, slug, name, created_at FROM organisations WHERE slug = $1',
      [slug],
    );
    const row = rows[0];
    return row && toOrg(row);
  }

  async getById(id: number): Promise<Organisation | undefined> {
    const { rows } = await query<OrganisationRow>(
      this.db,
      'SELECT id, slug, name, created_at FROM organisations WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row && toOrg(row);
  }

  /** The org that pre-multi-org data was backfilled into. Always exists post-migration. */
  async getDefaultId(): Promise<number> {
    const { rows } = await query<{ id: number }>(
      this.db,
      'SELECT id FROM organisations WHERE slug = $1',
      ['default'],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Default organisation is missing');
    return row.id;
  }

  async create(input: { slug: string; name: string }): Promise<Organisation> {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_REGEX.test(slug)) {
      throw new ConflictError(
        'Organisation slug must be lowercase letters, digits and dashes',
      );
    }
    if (await this.getBySlug(slug)) throw new ConflictError(`Organisation "${slug}" already exists`);
    try {
      const { rows } = await query<OrganisationRow>(
        this.db,
        'INSERT INTO organisations (slug, name) VALUES ($1, $2) RETURNING id, slug, name, created_at',
        [slug, input.name.trim()],
      );
      const created = rows[0];
      if (!created) throw new NotFoundError('Failed to create organisation');
      return toOrg(created);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`Organisation "${slug}" already exists`);
      throw err;
    }
  }
}
