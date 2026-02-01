/**
 * Connection Repository
 *
 * Database operations for integration connections.
 * Handles CRUD operations for both user-scoped and drive-scoped connections.
 */

import {
  db as defaultDb,
  eq,
  and,
  integrationConnections,
  type IntegrationConnection,
  type NewIntegrationConnection,
} from '@pagespace/db';

// Type for the database instance (allows dependency injection for testing)
export type ConnectionRepository = {
  db: typeof defaultDb;
};

type ConnectionStatus = 'active' | 'expired' | 'error' | 'pending' | 'revoked';

type ConnectionWithProvider = IntegrationConnection & {
  provider: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    config: unknown;
    providerType: string;
  } | null;
};

/**
 * Create a new integration connection.
 */
export const createConnection = async (
  database: typeof defaultDb,
  data: NewIntegrationConnection
): Promise<IntegrationConnection> => {
  const [connection] = await database
    .insert(integrationConnections)
    .values(data)
    .returning();

  return connection;
};

/**
 * Get a connection by ID.
 */
export const getConnectionById = async (
  database: typeof defaultDb,
  connectionId: string
): Promise<IntegrationConnection | null> => {
  const connection = await database.query.integrationConnections.findFirst({
    where: eq(integrationConnections.id, connectionId),
  });

  return connection ?? null;
};

/**
 * Get a connection with its provider config eagerly loaded.
 */
export const getConnectionWithProvider = async (
  database: typeof defaultDb,
  connectionId: string
): Promise<ConnectionWithProvider | null> => {
  const connection = await database.query.integrationConnections.findFirst({
    where: eq(integrationConnections.id, connectionId),
    with: {
      provider: true,
    },
  });

  return connection ?? null;
};

/**
 * Find an existing user connection for a provider.
 */
export const findUserConnection = async (
  database: typeof defaultDb,
  userId: string,
  providerId: string
): Promise<IntegrationConnection | null> => {
  const connection = await database.query.integrationConnections.findFirst({
    where: and(
      eq(integrationConnections.userId, userId),
      eq(integrationConnections.providerId, providerId)
    ),
  });

  return connection ?? null;
};

/**
 * Find an existing drive connection for a provider.
 */
export const findDriveConnection = async (
  database: typeof defaultDb,
  driveId: string,
  providerId: string
): Promise<IntegrationConnection | null> => {
  const connection = await database.query.integrationConnections.findFirst({
    where: and(
      eq(integrationConnections.driveId, driveId),
      eq(integrationConnections.providerId, providerId)
    ),
  });

  return connection ?? null;
};

/**
 * Update a connection's status and optional message.
 */
export const updateConnectionStatus = async (
  database: typeof defaultDb,
  connectionId: string,
  status: ConnectionStatus,
  statusMessage?: string
): Promise<IntegrationConnection | null> => {
  const [updated] = await database
    .update(integrationConnections)
    .set({
      status,
      statusMessage: statusMessage ?? null,
    })
    .where(eq(integrationConnections.id, connectionId))
    .returning();

  return updated ?? null;
};

/**
 * Delete a connection by ID.
 * Cascades to tool grants and audit logs via foreign key constraints.
 */
export const deleteConnection = async (
  database: typeof defaultDb,
  connectionId: string
): Promise<IntegrationConnection | null> => {
  const [deleted] = await database
    .delete(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .returning();

  return deleted ?? null;
};

/**
 * List all connections for a user with provider info.
 */
export const listUserConnections = async (
  database: typeof defaultDb,
  userId: string
): Promise<ConnectionWithProvider[]> => {
  const connections = await database.query.integrationConnections.findMany({
    where: eq(integrationConnections.userId, userId),
    with: {
      provider: true,
    },
  });

  return connections;
};

/**
 * List all connections for a drive with provider info.
 */
export const listDriveConnections = async (
  database: typeof defaultDb,
  driveId: string
): Promise<ConnectionWithProvider[]> => {
  const connections = await database.query.integrationConnections.findMany({
    where: eq(integrationConnections.driveId, driveId),
    with: {
      provider: true,
    },
  });

  return connections;
};

/**
 * Update last used timestamp for a connection.
 */
export const updateConnectionLastUsed = async (
  database: typeof defaultDb,
  connectionId: string
): Promise<void> => {
  await database
    .update(integrationConnections)
    .set({
      lastUsedAt: new Date(),
    })
    .where(eq(integrationConnections.id, connectionId));
};

/**
 * Update credentials for a connection (already encrypted).
 */
export const updateConnectionCredentials = async (
  database: typeof defaultDb,
  connectionId: string,
  credentials: Record<string, string>
): Promise<IntegrationConnection | null> => {
  const [updated] = await database
    .update(integrationConnections)
    .set({
      credentials,
      status: 'active',
      statusMessage: null,
    })
    .where(eq(integrationConnections.id, connectionId))
    .returning();

  return updated ?? null;
};
