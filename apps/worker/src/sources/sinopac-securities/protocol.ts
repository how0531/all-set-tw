import { z } from "zod";

/**
 * 永豐金證券 (Shioaji) 連接器設定
 */
export const sinopacSecuritiesConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  secretKey: z.string().min(1).optional(),
  lastPushedAt: z.string().optional(),
  pushedItemsCount: z.number().optional(),
});

export type SinopacSecuritiesConfig = z.infer<
  typeof sinopacSecuritiesConfigSchema
>;

export function parseSinopacSecuritiesConfig(
  config: unknown,
): SinopacSecuritiesConfig {
  return sinopacSecuritiesConfigSchema.parse(config);
}

export const shioajiPositionSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number(),
  marketValue: z.number(),
  costPrice: z.number().optional(),
  currentPrice: z.number().optional(),
  unrealizedProfit: z.number().optional(),
  assetType: z.enum(["stock", "etf", "fund"]).default("stock"),
  currency: z.string().optional().default("TWD"),
});

export type ShioajiPosition = z.infer<typeof shioajiPositionSchema>;

export const shioajiTransactionSchema = z.object({
  id: z.string().optional(),
  tradeDate: z.string(), // YYYY-MM-DD
  symbol: z.string().optional(),
  name: z.string().optional(),
  action: z.string().optional(), // "Buy" | "Sell" | "買進" | "賣出"
  quantity: z.number().optional(),
  price: z.number().optional(),
  amount: z.number().optional(),
  transactionCode: z.string().optional(),
});

export type ShioajiTransaction = z.infer<typeof shioajiTransactionSchema>;

export const shioajiAccountSchema = z.object({
  brokerAccount: z.string().optional(),
  cashBalance: z.number().optional(),
  currency: z.string().optional().default("TWD"),
});

export type ShioajiAccount = z.infer<typeof shioajiAccountSchema>;

export const shioajiPushPayloadSchema = z.object({
  asOfDate: z.string().optional(), // YYYY-MM-DD
  positions: z.array(shioajiPositionSchema).optional().default([]),
  transactions: z.array(shioajiTransactionSchema).optional(),
  account: shioajiAccountSchema.optional(),
});

export type ShioajiPushPayload = z.infer<typeof shioajiPushPayloadSchema>;
