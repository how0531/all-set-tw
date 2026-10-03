import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import type { Env } from "../../../src/platform/env";
import { updateConnectorSettings } from "../../../src/features/connectors/service";
import {
  handleShioajiPush,
  syncSinopacSecurities,
} from "../../../src/sources/sinopac-securities/sync";
import type { ShioajiPushPayload } from "../../../src/sources/sinopac-securities/protocol";

const key = "test-encryption-key-sinopac-32b";
const secretKey = "9u5t1PmuuGxTaHpCjGWLSXRn4d7G6UCdcf8BhR1Bmis7";
const apiKey = "FEp5vKr9oo7DSr6xAarZyC523Bb1MfLWWNhQZxVmXsNy";

describe("永豐金證券 Shioaji 推送與帳務持久化", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("驗證 Secret Key 並成功持久化股票部位至 D1", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;

    // 1. 在設定中配置 API Key 與 Secret Key
    await updateConnectorSettings(env, "sinopac_securities", {
      apiKey,
      secretKey,
    });

    // 2. 準備實測資料 Payload
    const payload: ShioajiPushPayload = {
      asOfDate: "2026-10-04",
      positions: [
        {
          symbol: "00406A",
          name: "主動中信台灣收益",
          quantity: 3000,
          marketValue: 30390,
          costPrice: 9.71,
          currentPrice: 10.13,
          unrealizedProfit: 1231,
          assetType: "etf",
          currency: "TWD",
        },
      ],
      account: {
        brokerAccount: "9805600",
        cashBalance: 0,
        currency: "TWD",
      },
    };

    // 3. 錯誤 Secret Key 應被拒絕
    await expect(
      handleShioajiPush(env, payload, "wrong-secret-key"),
    ).rejects.toThrow("UNAUTHORIZED");

    // 4. 正確 Secret Key 推送成功
    const result = await handleShioajiPush(env, payload, `Bearer ${secretKey}`);
    expect(result.success).toBe(true);
    expect(result.positionsCount).toBe(1);

    // 5. 驗證 D1 資料庫中的持倉紀錄
    const posRow = await env.DB.prepare(
      "SELECT * FROM investment_positions WHERE connector_id = 'sinopac_securities' AND symbol = '00406A'",
    ).first<{
      symbol: string;
      name: string;
      quantity: number;
      market_value: number;
      asset_type: string;
    }>();

    expect(posRow).not.toBeNull();
    expect(posRow?.symbol).toBe("00406A");
    expect(posRow?.name).toBe("主動中信台灣收益");
    expect(posRow?.quantity).toBe(3000);
    expect(posRow?.market_value).toBe(30390);
    expect(posRow?.asset_type).toBe("etf");

    // 6. 驗證 syncSinopacSecurities 正確讀取最近推送筆數
    const syncOutcome = await syncSinopacSecurities(env, "manual");
    expect(syncOutcome.success).toBe(true);
    expect(syncOutcome.records).toBe(1);
  });
});
