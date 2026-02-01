/**
 * Grant Repository
 *
 * Database operations for integration tool grants.
 * Handles which tools from a connection an agent can use.
 */

import {
  db as defaultDb,
  eq,
  and,
  integrationToolGrants,
  type IntegrationToolGrant,
  type NewIntegrationToolGrant,
} from '@pagespace/db';

type GrantWithConnection = IntegrationToolGrant & {
  connection: {
    id: string;
    name: string;
    status: string;
    provider: {
      slug: string;
      name: string;
    } | null;
  } | null;
};

type GrantWithAgent = IntegrationToolGrant & {
  agent: {
    id: string;
    title: string;
  } | null;
};

/**
 * Create a new tool grant.
 */
export const createGrant = async (
  database: typeof defaultDb,
  data: NewIntegrationToolGrant
): Promise<IntegrationToolGrant> => {
  const [grant] = await database
    .insert(integrationToolGrants)
    .values(data)
    .returning();

  return grant;
};

/**
 * Get a grant by ID.
 */
export const getGrantById = async (
  database: typeof defaultDb,
  grantId: string
): Promise<IntegrationToolGrant | null> => {
  const grant = await database.query.integrationToolGrants.findFirst({
    where: eq(integrationToolGrants.id, grantId),
  });

  return grant ?? null;
};

/**
 * Find a grant by agent ID and connection ID.
 */
export const findGrant = async (
  database: typeof defaultDb,
  agentId: string,
  connectionId: string
): Promise<IntegrationToolGrant | null> => {
  const grant = await database.query.integrationToolGrants.findFirst({
    where: and(
      eq(integrationToolGrants.agentId, agentId),
      eq(integrationToolGrants.connectionId, connectionId)
    ),
  });

  return grant ?? null;
};

/**
 * List all grants for an agent with connection details.
 */
export const listGrantsByAgent = async (
  database: typeof defaultDb,
  agentId: string
): Promise<GrantWithConnection[]> => {
  const grants = await database.query.integrationToolGrants.findMany({
    where: eq(integrationToolGrants.agentId, agentId),
    with: {
      connection: {
        with: {
          provider: true,
        },
      },
    },
  });

  return grants;
};

/**
 * List all grants for a connection with agent details.
 */
export const listGrantsByConnection = async (
  database: typeof defaultDb,
  connectionId: string
): Promise<GrantWithAgent[]> => {
  const grants = await database.query.integrationToolGrants.findMany({
    where: eq(integrationToolGrants.connectionId, connectionId),
    with: {
      agent: true,
    },
  });

  return grants;
};

/**
 * Update a grant's tool permissions.
 */
export const updateGrant = async (
  database: typeof defaultDb,
  grantId: string,
  data: Partial<Pick<IntegrationToolGrant, 'allowedTools' | 'deniedTools' | 'readOnly' | 'rateLimitOverride'>>
): Promise<IntegrationToolGrant | null> => {
  const [updated] = await database
    .update(integrationToolGrants)
    .set(data)
    .where(eq(integrationToolGrants.id, grantId))
    .returning();

  return updated ?? null;
};

/**
 * Delete a grant by ID.
 */
export const deleteGrant = async (
  database: typeof defaultDb,
  grantId: string
): Promise<IntegrationToolGrant | null> => {
  const [deleted] = await database
    .delete(integrationToolGrants)
    .where(eq(integrationToolGrants.id, grantId))
    .returning();

  return deleted ?? null;
};

/**
 * Delete all grants for a connection.
 */
export const deleteGrantsByConnection = async (
  database: typeof defaultDb,
  connectionId: string
): Promise<number> => {
  const result = await database
    .delete(integrationToolGrants)
    .where(eq(integrationToolGrants.connectionId, connectionId));

  return result.rowCount ?? 0;
};

/**
 * Delete all grants for an agent.
 */
export const deleteGrantsByAgent = async (
  database: typeof defaultDb,
  agentId: string
): Promise<number> => {
  const result = await database
    .delete(integrationToolGrants)
    .where(eq(integrationToolGrants.agentId, agentId));

  return result.rowCount ?? 0;
};
