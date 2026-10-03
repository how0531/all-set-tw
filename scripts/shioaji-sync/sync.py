#!/usr/bin/env python3
"""
永豐金證券 (Shioaji) 帳務同步腳本
使用 Shioaji SDK 擷取庫存持倉與未實現損益，並安全推送至 Taiwan Fin Hub (Cloudflare Worker)。
"""

import argparse
import datetime
import json
import os
import sys
from typing import Any, Dict, List, Optional

try:
    import requests
except ImportError:
    print("請先安裝 requests 套件: pip install requests", file=sys.stderr)
    sys.exit(1)

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


def parse_args():
    parser = argparse.ArgumentParser(description="永豐金證券 Shioaji 帳務自動同步工具")
    parser.add_argument(
        "--api-key",
        default=os.getenv("SHIOAJI_API_KEY"),
        help="永豐金證券 API Key",
    )
    parser.add_argument(
        "--secret-key",
        default=os.getenv("SHIOAJI_SECRET_KEY"),
        help="永豐金證券 Secret Key",
    )
    parser.add_argument(
        "--person-id",
        default=os.getenv("SHIOAJI_PERSON_ID"),
        help="身分證字號 (用於憑證簽章)",
    )
    parser.add_argument(
        "--cert-path",
        default=os.getenv("SHIOAJI_CERT_PATH"),
        help="永豐金憑證檔案路徑 (.pfx)",
    )
    parser.add_argument(
        "--cert-pass",
        default=os.getenv("SHIOAJI_CERT_PASS"),
        help="永豐金憑證密碼",
    )
    parser.add_argument(
        "--target-url",
        default=os.getenv("TARGET_WORKER_URL"),
        help="Taiwan Fin Hub Worker 網址 (如 https://all-set-tw.ejijp6cl4.workers.dev)",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("SYNC_TOKEN"),
        help="同步推送金鑰 (Sync Token)",
    )
    parser.add_argument(
        "--cf-client-id",
        default=os.getenv("CF_ACCESS_CLIENT_ID"),
        help="Cloudflare Access Service Token Client ID (選填)",
    )
    parser.add_argument(
        "--cf-client-secret",
        default=os.getenv("CF_ACCESS_CLIENT_SECRET"),
        help="Cloudflare Access Service Token Client Secret (選填)",
    )
    parser.add_argument(
        "--simulation",
        action="store_true",
        help="使用模擬環境 (測試用)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="僅擷取並列印資料，不發送至 Worker",
    )
    return parser.parse_args()


def fetch_shioaji_positions(args) -> Dict[str, Any]:
    """使用 Shioaji SDK 擷取永豐金證券庫存持倉與損益"""
    try:
        import shioaji as sj
    except ImportError:
        print(
            "錯誤: 尚未安裝 shioaji SDK。\n請執行: pip install shioaji",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"[1/4] 初始化 Shioaji API 連線 (模擬環境: {args.simulation})...")
    api = sj.Shioaji(simulation=args.simulation)

    print("[2/4] 登入永豐金 API...")
    try:
        api.login(
            api_key=args.api_key,
            secret_key=args.secret_key,
        )
    except Exception as e:
        err_msg = str(e)
        if "doesn't have production permission" in err_msg:
            print("\n❌ 登入失敗: 永豐金證券回報金鑰尚未具備正式環境權限 (Token doesn't have production permission)。", file=sys.stderr)
            print("👉 請前往永豐金官網 API 管理頁面: https://www.sinotrade.com.tw/newweb/PythonAPIKey/", file=sys.stderr)
            print("   確認該組 API Key 是否已勾選開通「正式環境 (Production)」、「行情/資料」、「帳務」等權限。\n", file=sys.stderr)
        raise

    # 啟用交易憑證 (若有提供)
    if args.cert_path and args.cert_pass and args.person_id:
        print("[2.5] 啟用永豐金數位憑證...")
        api.activate_ca(
            ca_path=args.cert_path,
            ca_passwd=args.cert_pass,
            person_id=args.person_id,
        )

    print("[3/4] 抓取台股持倉清單與損益試算...")
    positions: List[Dict[str, Any]] = []
    total_market_value = 0.0

    # 取得所有證券帳號
    stock_accounts = [
        acc
        for acc in api.list_accounts()
        if hasattr(acc, "account_id")
        and (
            "Stock" in acc.__class__.__name__
            or getattr(acc, "account_type", "") == "H"
        )
    ]
    if not stock_accounts and api.stock_account:
        stock_accounts = [api.stock_account]

    today_str = datetime.date.today().isoformat()
    broker_account = (
        getattr(api.stock_account, "account_id", "") if api.stock_account else ""
    )

    for acc in stock_accounts:
        acc_id = getattr(acc, "account_id", "")
        broker_id = getattr(acc, "broker_id", "")
        print(f"  -> 查詢證券帳號 [{broker_id}-{acc_id}] 部位...")
        try:
            # 優先使用股數 (Share) 作為單位，確保整股與零股皆以實際股數精確計算市值
            unit_param = getattr(getattr(sj, "Unit", None), "Share", None)
            if unit_param:
                stock_positions = api.list_positions(acc, unit=unit_param)
            else:
                stock_positions = api.list_positions(acc)
        except Exception as e:
            print(f"     查詢 [{broker_id}-{acc_id}] 部位跳過: {e}")
            continue

        for pos in stock_positions:
            symbol = str(getattr(pos, "code", ""))
            quantity = int(getattr(pos, "quantity", 0))
            cost_price = float(getattr(pos, "price", 0.0))
            last_price = float(getattr(pos, "last_price", 0.0) or cost_price)
            market_val = float(
                getattr(pos, "market_value", 0.0) or (quantity * last_price)
            )
            unrealized = float(
                getattr(pos, "pnl", 0.0) or (market_val - (quantity * cost_price))
            )

            # 判斷是否為 ETF 或一般股票
            asset_type = "etf" if symbol.startswith("00") else "stock"

            name = symbol
            try:
                contract = api.Contracts.Stocks.get(symbol)
                if contract and hasattr(contract, "name") and contract.name:
                    name = contract.name
            except Exception:
                pass

            positions.append(
                {
                    "symbol": symbol,
                    "name": name,
                    "quantity": quantity,
                    "marketValue": round(market_val),
                    "costPrice": round(cost_price, 2),
                    "currentPrice": round(last_price, 2),
                    "unrealizedProfit": round(unrealized),
                    "assetType": asset_type,
                    "currency": "TWD",
                }
            )
            total_market_value += market_val

    # 嘗試抓取銀行餘額 (若支援)
    cash_balance = None
    try:
        balance_info = api.account_balance()
        if balance_info and hasattr(balance_info, "acc_balance"):
            cash_balance = float(balance_info.acc_balance)
    except Exception:
        pass

    account_info = {
        "brokerAccount": broker_account,
    }
    if cash_balance is not None:
        account_info["cashBalance"] = round(cash_balance)

    payload = {
        "asOfDate": today_str,
        "positions": positions,
        "account": account_info,
    }

    print(f"  -> 成功取得 {len(positions)} 檔股票庫存，預估總市值: NT$ {int(total_market_value):,}")
    return payload


def push_to_worker(args, payload: Dict[str, Any]):
    """將格式化後的帳務資料推送到 Cloudflare Worker"""
    base_url = args.target_url.rstrip("/")
    push_endpoint = f"{base_url}/api/connectors/sinopac_securities/push"

    headers: Dict[str, str] = {"Content-Type": "application/json"}
    token = args.token or args.secret_key
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["X-Sync-Token"] = token
        headers["X-Secret-Key"] = token
    if args.api_key:
        headers["X-Api-Key"] = args.api_key

    if args.cf_client_id and args.cf_client_secret:
        headers["CF-Access-Client-Id"] = args.cf_client_id
        headers["CF-Access-Client-Secret"] = args.cf_client_secret

    print(f"[4/4] 推送資料至 Taiwan Fin Hub ({push_endpoint})...")
    try:
        resp = requests.post(push_endpoint, json=payload, headers=headers, timeout=30)
        if resp.status_code == 200:
            res_data = resp.json()
            if res_data.get("success"):
                print("🎉 恭喜！永豐金帳務已成功同步至 Taiwan Fin Hub！")
                print(f"  更新結果: {json.dumps(res_data.get('data', {}), ensure_ascii=False)}")
                return
        print(f"❌ 推送失敗 (HTTP {resp.status_code}): {resp.text}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"❌ 網路連線錯誤: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    args = parse_args()

    if not args.api_key or not args.secret_key:
        print("錯誤: 請提供永豐金 API Key 與 Secret Key (可透過參數或 .env 設定)", file=sys.stderr)
        sys.exit(1)

    if not args.dry_run and not args.target_url:
        print("錯誤: 請提供 Taiwan Fin Hub Worker 網址 (--target-url)", file=sys.stderr)
        sys.exit(1)

    payload = fetch_shioaji_positions(args)

    if args.dry_run:
        print("\n[Dry Run 模式 - 不發送 HTTP 請求]")
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    push_to_worker(args, payload)


if __name__ == "__main__":
    main()
