# Native Run (Non-Docker)

## Quick Start

```bash
# Install dependencies
pnpm install

# Run the service
pnpm serve
# or directly:
npx tsx packages/finance-api/bin/finance-api.ts
```

The service will:
1. Load config from `~/.pi/sf/finance/config.json` (or env vars)
2. Generate a bearer token at `~/.pi/sf/finance/token` (first run only)
3. Open/create SQLite database at `~/.pi/sf/finance/finance.db`
4. Start HTTP server on `127.0.0.1:7780`
5. Start scheduler daemon for periodic data sync

## Configuration

Environment variables (prefix `SF_FINANCE_`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SF_FINANCE_PORT` | `7780` | HTTP server port |
| `SF_FINANCE_HOST` | `127.0.0.1` | HTTP server host |
| `SF_FINANCE_DB` | `~/.pi/sf/finance/finance.db` | SQLite database path |
| `SF_FINANCE_DATA_FEED` | `stooq` | Price data feed (`stooq` or `yfinance`) |

## macOS (launchd)

Create `~/Library/LaunchAgents/com.pi-stef.finance-api.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pi-stef.finance-api</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/npx</string>
        <string>tsx</string>
        <string>/path/to/pi-stef/packages/finance-api/bin/finance-api.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/pi-stef</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/finance-api.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/finance-api.error.log</string>
</dict>
</plist>
```

Load the service:
```bash
launchctl load ~/Library/LaunchAgents/com.pi-stef.finance-api.plist
```

## Linux (systemd)

Create `/etc/systemd/system/finance-api.service`:

```ini
[Unit]
Description=Pi Stef Finance API
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/pi-stef
ExecStart=/usr/local/bin/npx tsx packages/finance-api/bin/finance-api.ts
Restart=always
RestartSec=10
Environment=SF_FINANCE_HOST=127.0.0.1
Environment=SF_FINANCE_PORT=7780

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable finance-api
sudo systemctl start finance-api
```

## Health Check

```bash
curl -fsS http://127.0.0.1:7780/v1/health
```

Expected response:
```json
{"ok":true,"data":{"status":"ok","uptimeS":123}}
```
