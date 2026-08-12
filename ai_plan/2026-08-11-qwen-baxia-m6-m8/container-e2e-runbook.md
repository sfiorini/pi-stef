# Container E2E Runbook — qwen-proxy Baxia (M6)

> **Operator:** USER on mini. The developer does NOT run these commands (R-Docker-4).
> The developer's deliverable is this runbook file; "done" only when the USER confirms both phases pass.

---

## 1. Build + verify

### 1.1 Pull + status

```bash
cd ~/pi-stef && git pull && git status
```

Confirm you're on the `feat/pi-stef-qwen-phase-2` branch (or whichever contains the M6 Dockerfile).

### 1.2 Build the image

```bash
docker build -f packages/qwen-proxy/docker/Dockerfile -t qwen-proxy:baxia .
```

### 1.3 Verify Chromium is installed

```bash
docker run --rm qwen-proxy:baxia chromium --version
```

**Expected:** `Chromium 1xx.x.xxxx.xx` (any 1xx version).
**If `chromium` is unavailable**, the base image isn't bookworm — check that the Dockerfile uses `FROM node:22-bookworm-slim`.

### 1.4 Verify non-root uid 1000

```bash
docker run --rm qwen-proxy:baxia id -u
```

**Expected:** `1000`

### 1.5 Verify cache dir owned by 1000

```bash
docker run --rm qwen-proxy:baxia ls -ld /home/node/.cache
```

**Expected:** `drwxr-xr-x 2 1000 1000 ... /home/node/.cache`

### 1.6 Verify Dockerfile USER

```bash
docker inspect qwen-proxy:baxia --format '{{.Config.User}}'
```

**Expected:** `1000`

### 1.7 Verify XDG_CACHE_HOME env

```bash
docker inspect qwen-proxy:baxia --format '{{range .Config.Env}}{{println .}}{{end}}' | grep XDG_CACHE_HOME
```

**Expected:** `XDG_CACHE_HOME=/home/node/.cache`

---

## 2. Health + completion

### 2.1 Start the container

```bash
docker run -d --name qwen-baxia-test -p 7791:7790 -e SF_QWEN_API_KEY=test qwen-proxy:baxia
```

### 2.2 Poll health endpoint

```bash
for i in $(seq 1 30); do
  STATUS=$(curl -s http://127.0.0.1:7791/v1/health 2>/dev/null)
  echo "$STATUS"
  if echo "$STATUS" | grep -q '"status":"ok"'; then
    echo "Health OK after $i attempts"
    break
  fi
  sleep 2
done
```

**Expected:** `{"status":"ok"}` within 30 attempts (up to 60s — Chromium cold-start + first Baxia token).

### 2.3 Streaming completion

```bash
curl -N http://127.0.0.1:7791/v1/chat/completions \
  -H "Authorization: Bearer test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.8-max",
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "stream": true
  }'
```

**PASS criteria:** At least one SSE delta contains a non-empty `choices[0].delta.content` value before the final `[DONE]` event.

A PASS means Chromium launched as uid 1000, generated a Baxia token, and the proxy relayed a non-empty streaming completion from chat.qwen.ai.

### 2.4 Cleanup

```bash
docker stop qwen-baxia-test && docker rm qwen-baxia-test && docker rmi qwen-proxy:baxia
```

---

## Done

M6 is **done** only when the USER confirms both phases passed on mini.
