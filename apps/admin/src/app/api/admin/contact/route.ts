import { db } from '@pagespace/db/db'
import { asc, desc, ilike, or, and, count, gte, sql, isNull, isNotNull } from '@pagespace/db/operators'
import { contactSubmissions } from '@pagespace/db/schema/contact';
import { users } from '@pagespace/db/schema/auth';
import { userEmailInListMatch, decryptUserRows } from '@pagespace/lib/auth/user-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

export const GET = withAdminAuth(async (_adminUser, request) => {
  try {

    // Parse query parameters
    const url = new URL(request.url);
    const searchTerm = url.searchParams.get('search') || '';
    const sortBy = url.searchParams.get('sortBy') || 'createdAt';
    const sortOrder = url.searchParams.get('sortOrder') || 'desc';
    const statusFilter = url.searchParams.get('status') || 'all'; // 'open' | 'closed' | 'all'
    const page = parseBoundedIntParam(url.searchParams.get('page'), {
      defaultValue: 1,
      min: 1,
      max: 100000,
    });
    const pageSize = parseBoundedIntParam(url.searchParams.get('pageSize'), {
      defaultValue: 50,
      min: 1,
      max: 200,
    });
    const offset = (page - 1) * pageSize;

    // Build where conditions
    const searchConditions = searchTerm
      ? or(
          ilike(contactSubmissions.name, `%${searchTerm}%`),
          ilike(contactSubmissions.email, `%${searchTerm}%`),
          ilike(contactSubmissions.subject, `%${searchTerm}%`),
          ilike(contactSubmissions.message, `%${searchTerm}%`)
        )
      : undefined;

    const statusCondition =
      statusFilter === 'open'
        ? isNull(contactSubmissions.resolvedAt)
        : statusFilter === 'closed'
        ? isNotNull(contactSubmissions.resolvedAt)
        : undefined;

    const allConditions = [searchConditions, statusCondition].filter(Boolean);
    const whereClause = allConditions.length > 1
      ? and(...allConditions as Parameters<typeof and>)
      : allConditions[0];

    // Date boundaries for stats
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    weekAgo.setHours(0, 0, 0, 0);

    const todayCondition = whereClause
      ? and(whereClause, gte(contactSubmissions.createdAt, todayStart))
      : gte(contactSubmissions.createdAt, todayStart);
    const weekCondition = whereClause
      ? and(whereClause, gte(contactSubmissions.createdAt, weekAgo))
      : gte(contactSubmissions.createdAt, weekAgo);

    // Get total + stats counts in parallel
    const [totalCountResult, todayCountResult, weekCountResult, uniqueEmailResult] = await Promise.all([
      db.select({ count: count() }).from(contactSubmissions).where(whereClause),
      db.select({ count: count() }).from(contactSubmissions).where(todayCondition),
      db.select({ count: count() }).from(contactSubmissions).where(weekCondition),
      db.select({ count: sql<number>`COUNT(DISTINCT ${contactSubmissions.email})` }).from(contactSubmissions).where(whereClause),
    ]);

    // Build sort condition
    const validSortColumns = {
      id: contactSubmissions.id,
      name: contactSubmissions.name,
      email: contactSubmissions.email,
      subject: contactSubmissions.subject,
      message: contactSubmissions.message,
      createdAt: contactSubmissions.createdAt,
    };

    const sortColumn = validSortColumns[sortBy as keyof typeof validSortColumns] || contactSubmissions.createdAt;
    const orderBy = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);

    // Get submissions with pagination (no SQL join — users.email may be an
    // AES-GCM ciphertext that can't equality-match contactSubmissions.email directly).
    const rows = await db
      .select({
        id: contactSubmissions.id,
        name: contactSubmissions.name,
        email: contactSubmissions.email,
        subject: contactSubmissions.subject,
        message: contactSubmissions.message,
        createdAt: contactSubmissions.createdAt,
        resolvedAt: contactSubmissions.resolvedAt,
      })
      .from(contactSubmissions)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset);

    // Batch-resolve registered users for this page via the dual blind-index/raw
    // lookup (mirrors mapAttendeesToUsers in the calendar-sync integration).
    const pageEmails = [...new Set(rows.map((r) => r.email.toLowerCase()))];
    const matchedUsers = pageEmails.length
      ? await decryptUserRows(
          await db
            .select({ id: users.id, email: users.email, subscriptionTier: users.subscriptionTier })
            .from(users)
            .where(userEmailInListMatch(pageEmails))
        )
      : [];
    const userByEmail = new Map(matchedUsers.map((u) => [u.email.toLowerCase(), u]));

    const submissions = rows.map((r) => {
      const matched = userByEmail.get(r.email.toLowerCase());
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        subject: r.subject,
        message: r.message,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        registeredUser: matched
          ? { id: matched.id, subscriptionTier: matched.subscriptionTier }
          : null,
      };
    });

    // Calculate pagination info
    const total = totalCountResult[0]?.count || 0;
    const todayCount = todayCountResult[0]?.count || 0;
    const weekCount = weekCountResult[0]?.count || 0;
    const uniqueEmailCount = Number(uniqueEmailResult[0]?.count ?? 0);
    const totalPages = Math.ceil(total / pageSize);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    return Response.json({
      submissions,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage,
        hasPrevPage
      },
      stats: {
        todayCount,
        weekCount,
        uniqueEmailCount,
      },
      meta: {
        searchTerm,
        sortBy,
        sortOrder,
        statusFilter,
      }
    });

  } catch (error) {
    loggers.api.error('Error fetching contact submissions:', error as Error);
    return Response.json(
      { error: 'Failed to fetch contact submissions' },
      { status: 500 }
    );
  }
});
