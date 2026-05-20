import { db } from '@pagespace/db/db'
import { asc, desc, ilike, or, count } from '@pagespace/db/operators'
import { contactSubmissions } from '@pagespace/db/schema/contact';
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

    // Build where conditions for search
    const searchConditions = searchTerm
      ? or(
          ilike(contactSubmissions.name, `%${searchTerm}%`),
          ilike(contactSubmissions.email, `%${searchTerm}%`),
          ilike(contactSubmissions.subject, `%${searchTerm}%`),
          ilike(contactSubmissions.message, `%${searchTerm}%`)
        )
      : undefined;

    // Get total count for pagination
    const totalCount = await db
      .select({ count: count() })
      .from(contactSubmissions)
      .where(searchConditions);

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

    // Get submissions with pagination
    const submissions = await db
      .select({
        id: contactSubmissions.id,
        name: contactSubmissions.name,
        email: contactSubmissions.email,
        subject: contactSubmissions.subject,
        message: contactSubmissions.message,
        createdAt: contactSubmissions.createdAt,
      })
      .from(contactSubmissions)
      .where(searchConditions)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset);

    // Calculate pagination info
    const total = totalCount[0]?.count || 0;
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
      meta: {
        searchTerm,
        sortBy,
        sortOrder
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
