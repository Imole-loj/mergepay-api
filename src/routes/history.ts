import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { requireUser } from "../plugins/auth";
import { rateLimited } from "../lib/rate-limit";
import { expenseStatusFilter } from "../services/expenses";
import { serializeExpense, serializeSettlement } from "../serializers";
import {
  paginationQuerySchema,
  cursorFilter,
  requireCursor,
  takeForPage,
  encodeCursor,
  type CursorPosition,
} from "../lib/pagination";
import { assetCodeSchema } from "../schemas/asset";


export const historyQuerySchema = paginationQuerySchema.extend({
  assetCode: assetCodeSchema.optional(),
  asset: assetCodeSchema.optional(),
  status: z.string().optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  groupId: z.string().optional(),
  includeTotal: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export default async function historyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/history", rateLimited("history"), async (req) => {
    const auth = requireUser(req);
    const query = historyQuerySchema.parse(req.query);
    const position = requireCursor(query.cursor);
    const cursorCondition = cursorFilter(position, query.order);

    const assetCode = query.assetCode ?? query.asset;
    const assetFilter = assetCode ? { assetCode } : {};

    const fromDate = query.fromDate ?? query.startDate;
    const toDate = query.toDate ?? query.endDate;

    const dateFilter: Record<string, unknown> = {};
    if (fromDate) {
      dateFilter.createdAt = { gte: new Date(fromDate) };
    }
    if (toDate) {
      dateFilter.createdAt = {
        ...(dateFilter.createdAt as object | undefined),
        lte: new Date(toDate),
      };
    }

    const takeCount = takeForPage(query.limit);
    const skipCount = query.offset ?? undefined;

    const expenseUserFilter = query.groupId
      ? { groupId: query.groupId }
      : {
          OR: [
            { payerUserId: auth.id },
            { shares: { some: { userId: auth.id } } },
          ],
        };

    const settlementUserFilter = query.groupId
      ? { groupId: query.groupId }
      : { OR: [{ fromUserId: auth.id }, { toUserId: auth.id }] };

    const [expenses, settlements, total] = await Promise.all([
      prisma.expense.findMany({
        where: {
          AND: [
            expenseUserFilter,
            cursorCondition,
            assetFilter,
            dateFilter,
            ...(query.status ? [expenseStatusFilter(query.status)] : []),
          ],
        },
        include: { payer: true, shares: { include: { user: true } } },
        orderBy: [{ createdAt: query.order }, { id: query.order }],
        take: takeCount,
        skip: skipCount,
      }),
      prisma.settlement.findMany({
        where: {
          AND: [
            settlementUserFilter,
            cursorCondition,
            assetFilter,
            dateFilter,
            ...(query.status ? [{ status: query.status }] : []),
          ],
        },
        include: { from: true, to: true },
        orderBy: [{ createdAt: query.order }, { id: query.order }],
        take: takeCount,
        skip: skipCount,
      }),
      query.includeTotal
        ? Promise.all([
            prisma.expense.count({
              where: {
                AND: [
                  expenseUserFilter,
                  assetFilter,
                  dateFilter,
                  ...(query.status ? [expenseStatusFilter(query.status)] : []),
                ],
              },
            }),
            prisma.settlement.count({
              where: {
                AND: [
                  settlementUserFilter,
                  assetFilter,
                  dateFilter,
                  ...(query.status ? [{ status: query.status }] : []),
                ],
              },
            }),
          ]).then(([eCount, sCount]) => eCount + sCount)
        : Promise.resolve(undefined),
    ]);

    const merged: (CursorPosition & { type: "expense" | "settlement"; data: unknown })[] = [
      ...expenses.map((e) => ({
        type: "expense" as const,
        createdAt: e.createdAt,
        id: e.id,
        data: serializeExpense(e),
      })),
      ...settlements.map((s) => ({
        type: "settlement" as const,
        createdAt: s.createdAt,
        id: s.id,
        data: serializeSettlement(s),
      })),
    ].sort((a, b) => {
      const dir = query.order === "desc" ? -1 : 1;
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return a.createdAt.getTime() > b.createdAt.getTime() ? dir : -dir;
      }
      return a.id > b.id ? dir : -dir;
    });

    const hasMore = merged.length > query.limit;
    const results = hasMore ? merged.slice(0, query.limit) : merged;
    const last = results[results.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    return {
      expenses: results.map((r) => ({
        type: r.type,
        ...(r.data as object),
      })),
      meta: {
        nextCursor,
        hasMore,
        limit: query.limit,
        order: query.order,
        ...(total !== undefined ? { total } : {}),
      },
    };
  });

}
