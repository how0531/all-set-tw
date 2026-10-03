# 永豐金證券 (Shioaji) 帳務同步工具

本工具使用永豐金官方 Python SDK（`shioaji`），自動擷取您的台股庫存股票、ETF 持倉、即時現價估值與交割戶資訊，並透過加密端點安全推送至您的 **Taiwan Fin Hub (不用記帳)** 系統。

---

## 快速開始

### 1. 安裝環境與相依套件

建議使用 Python 3.9 以上版本：

```bash
cd scripts/shioaji-sync
pip install -r requirements.txt
```

### 2. 設定環境變數

複製設定範本並填入您的永豐 API 金鑰與憑證：

```bash
cp .env.example .env
```

編輯 `.env` 檔案：

- `SHIOAJI_API_KEY`：永豐金證券 API Key
- `SHIOAJI_SECRET_KEY`：永豐金證券 Secret Key
- `TARGET_WORKER_URL`：您的 Cloudflare Worker 網址（例如：`https://all-set-tw.ejijp6cl4.workers.dev`）
- `SYNC_TOKEN`：在 Taiwan Fin Hub 前台「設定 → 資料來源 → 永豐金證券」輸入的自訂 Sync Token

### 3. 測試執行

**Dry-run 模式（僅抓取並預覽資料，不推送）**：

```bash
python sync.py --dry-run
```

**正式推送同步**：

```bash
python sync.py
```

同步成功後，開啟 Taiwan Fin Hub 的**「資產清冊」**與**「總覽」**，即可看到永豐金證券的持股與市值！

---

## 自動排程定時同步

### macOS (crontab)

每個交易日（週一至週五）收盤後（14:00）自動同步：

```bash
0 14 * * 1-5 /usr/bin/python3 /path/to/scripts/shioaji-sync/sync.py >> /tmp/shioaji_sync.log 2>&1
```

### 嵌入現有量化/網格交易系統

若您已有自製交易機器人，可直接在交易成交回報後引入本模組，達到即時資產更新！
