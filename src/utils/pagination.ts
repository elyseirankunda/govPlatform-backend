export interface Pagination {
  page: number;
  limit: number;
  skip: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? '20'), 10) || 20));
  const sortBy = String(query.sortBy ?? 'createdAt');
  const sortOrder = String(query.sortOrder ?? 'desc') === 'asc' ? 'asc' : 'desc';
  return { page, limit, skip: (page - 1) * limit, sortBy, sortOrder };
}

export function pageResponse<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
) {
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}
