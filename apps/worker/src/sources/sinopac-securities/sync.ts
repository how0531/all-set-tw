import type { Env } from "../../platform/env";
import type { SyncTrigger } from "../../db";
import type { SyncOutcome } from "../../features/sync/types";
import {
  findConnectorSettings,
  saveConnectorSettings,
} from "../../features/connectors/repository";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import {
  investmentPositionRecord,
  investmentTransactionRecord,
  bankAccountRecord,
  bankBalanceSnapshotRecord,
} from "../../features/sync/record-mapper";
import {
  type SyncWriteRecord,
  persistStagedSyncWrite,
} from "../../features/sync/persistence";
import {
  parseSinopacSecuritiesConfig,
  type ShioajiPushPayload,
} from "./protocol";

export async function syncSinopacSecurities(
  env: Env,
  _trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "sinopac_securities";
  const settings = await findConnectorSettings(env.DB, connectorId);
  let lastPushedAt: string | null = null;
  let pushedItemsCount = 0;

  if (settings) {
    try {
      const config = parseSinopacSecuritiesConfig(
        await decryptJson<Record<string, unknown>>(
          settings.encrypted_config,
          configEncryptionKey(env),
        ),
      );
      lastPushedAt = config.lastPushedAt ?? null;
      pushedItemsCount = config.pushedItemsCount ?? 0;
    } catch {
      // ignore config parse failure
    }
  }

  console.log(
    `[sync] ${connectorId}: push-mode check. Last push: ${lastPushedAt ?? "never"} (${pushedItemsCount} items)`,
  );

  return {
    success: true,
    connectorId,
    scope: "all",
    records: pushedItemsCount,
    newRecords: {
      invoices: 0,
      bankTransactions: 0,
      investmentTransactions: 0,
    },
    cursorUpdated: false,
  };
}

export async function handleShioajiPush(
  env: Env,
  payload: ShioajiPushPayload,
  authToken?: string | null,
) {
  const connectorId = "sinopac_securities";
  const settings = await findConnectorSettings(env.DB, connectorId);
  const encKey = configEncryptionKey(env);

  let currentConfig: Record<string, unknown> = {};
  let configuredToken: string | null = null;

  if (settings) {
    try {
      currentConfig = await decryptJson<Record<string, unknown>>(
        settings.encrypted_config,
        encKey,
      );
      if (
        typeof currentConfig.secretKey === "string" &&
        currentConfig.secretKey.trim().length > 0
      ) {
        configuredToken = currentConfig.secretKey.trim();
      } else if (
        typeof currentConfig.syncToken === "string" &&
        currentConfig.syncToken.trim().length > 0
      ) {
        configuredToken = currentConfig.syncToken.trim();
      }
    } catch {
      currentConfig = {};
    }
  }

  const envToken =
    (
      env as unknown as Record<string, string | undefined>
    ).SHIOAJI_SECRET_KEY?.trim() ||
    (
      env as unknown as Record<string, string | undefined>
    ).SHIOAJI_SYNC_TOKEN?.trim();
  const expectedToken = configuredToken || envToken;

  const cleanAuthToken = authToken?.replace(/^Bearer\s+/i, "").trim();

  // 若已有設定 Secret Key，必須驗證通過
  if (expectedToken) {
    if (!cleanAuthToken || cleanAuthToken !== expectedToken) {
      throw new Error("UNAUTHORIZED: 無效的 Secret Key (驗證失敗)");
    }
  } else if (!cleanAuthToken) {
    // 尚未在後台設定，但也未帶任何 Token
    throw new Error(
      "UNAUTHORIZED: 請先在「設定 → 資料來源」設定 Secret Key，或於推送時附帶 Authorization: Bearer <SECRET_KEY>",
    );
  }

  const now = new Date().toISOString();
  const asOfDate = payload.asOfDate || now.slice(0, 10);
  const records: SyncWriteRecord[] = [];

  // 1. 處理股票 / ETF / 基金持倉
  for (const pos of payload.positions) {
    records.push(
      investmentPositionRecord(
        connectorId,
        {
          sourceId: pos.symbol,
          assetType: pos.assetType,
          symbol: pos.symbol,
          name: pos.name,
          quantity: pos.quantity,
          marketValue: Math.round(pos.marketValue),
          cashBalance: undefined,
          currency: pos.currency || "TWD",
          asOfDate,
          raw: pos,
        },
        now,
      ),
    );
  }

  // 2. 處理交易成交明細 (選填)
  if (payload.transactions && payload.transactions.length > 0) {
    for (const tx of payload.transactions) {
      const sourceId =
        tx.id ||
        `${tx.tradeDate}-${tx.symbol ?? "unknown"}-${tx.action ?? "trade"}-${tx.quantity ?? 0}-${tx.price ?? 0}`;
      const acctId = payload.account?.brokerAccount || "sinopac-stock";
      const actionName =
        tx.action === "Buy"
          ? "買進"
          : tx.action === "Sell"
            ? "賣出"
            : tx.action || "交易";

      records.push(
        investmentTransactionRecord(
          connectorId,
          {
            accountId: acctId,
            sourceId,
            brokerNo: "9A00",
            brokerAccount: acctId,
            brokerName: "永豐金證券",
            symbol: tx.symbol,
            name: tx.name,
            assetType: "stock",
            tradeDate: tx.tradeDate,
            postedDate: tx.tradeDate,
            transactionCode: tx.transactionCode ?? tx.action,
            transactionName: actionName,
            quantity: tx.quantity,
            price: tx.price,
            amount: tx.amount ? Math.round(tx.amount) : undefined,
            currency: "TWD",
            raw: tx,
          },
          now,
        ),
      );
    }
  }

  // 3. 處理交割戶/現金餘額 (選填)
  if (payload.account && payload.account.cashBalance !== undefined) {
    const acctId = payload.account.brokerAccount || "sinopac-stock";
    records.push(
      bankAccountRecord(
        connectorId,
        {
          sourceId: acctId,
          institutionName: "永豐金證券",
          accountName: "永豐金證券交割戶",
          accountType: "settlement_cash",
          currency: payload.account.currency || "TWD",
          raw: payload.account,
        },
        now,
      ),
    );
    records.push(
      bankBalanceSnapshotRecord(
        connectorId,
        {
          accountId: acctId,
          sourceId: acctId,
          currency: payload.account.currency || "TWD",
          balance: Math.round(payload.account.cashBalance),
          availableBalance: Math.round(payload.account.cashBalance),
          asOfAt: now,
          raw: payload.account,
        },
        now,
      ),
    );
  }

  // 寫入 D1
  if (records.length > 0) {
    await persistStagedSyncWrite(env.DB, { records });
  }

  // 更新設定與狀態中的 lastPushedAt
  const updatedConfig = {
    ...currentConfig,
    secretKey: expectedToken || cleanAuthToken,
    lastPushedAt: now,
    pushedItemsCount: payload.positions.length,
  };

  await saveConnectorSettings(env.DB, {
    id: settings?.id ?? crypto.randomUUID(),
    connectorId,
    encryptedConfig: await encryptJson(updatedConfig, encKey),
    publicConfig: settings?.public_config ?? null,
    now,
  });

  return {
    success: true,
    positionsCount: payload.positions.length,
    transactionsCount: payload.transactions?.length ?? 0,
    asOfDate,
    updatedAt: now,
  };
}
