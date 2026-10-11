# Deploying

Three hosts, all on free tiers, no monthly bill:

```
                      ┌──────────────────────────────┐
  browser ───────────▶│ Vercel    React SPA (static) │  always instant
                      └──────────────┬───────────────┘
                                     │ fetch, cross-origin + cookies
                      ┌──────────────▼───────────────┐
                      │ Render    Node API           │  sleeps when idle
                      └──────────────┬───────────────┘
                                     │ X-Service-Token
                      ┌──────────────▼───────────────┐
                      │ Render    FastAPI + sklearn  │  sleeps when idle
                      └──────────────┬───────────────┘
                                     │ TLS
                      ┌──────────────▼───────────────┐
                      │ TiDB      Serverless MySQL   │  always on
                      └──────────────────────────────┘
```

The database is external because Render offers Postgres only and this stack is
MySQL-specific (`drizzle-orm/mysql2` on the Node side, `pymysql` on the Python
side). TiDB Cloud Serverless is wire-compatible and free.

## Why the frontend is split off

Free container hosting suspends an idle instance; waking takes 30–60s. If the
API also served the SPA, that wait would be a blank browser window — the demo
would look broken to anyone arriving after a quiet period.

Static hosting has no instance to suspend, so the page is always immediate. The
cold start still happens, but it happens *behind* a rendered UI that explains
it ([`api-gate.tsx`](../client/src/components/api-gate.tsx)), and the app
enters as soon as the API answers. That turns an apparent outage into a stated,
bounded wait.

It costs one piece of indirection: the SPA and API are on different origins, so
`/api/*` has to be redirected and the session cookie has to survive cross-site.

- **Request routing** — [`api-base.ts`](../client/src/lib/api-base.ts) wraps
  `fetch` once at startup and rewrites relative `/api` paths to `VITE_API_URL`.
  There are ~80 call sites written with relative paths; a wrapper means none of
  them changed and a new one cannot forget.
- **Cookies** — already correct for this: the session sets
  `sameSite: "none"; secure: true` in production, and every request sends
  credentials.
- **CORS** — [`cors.ts`](../server/services/cors.ts) answers only origins named
  in `ALLOWED_ORIGINS`, with credentials. A wildcard is refused at boot, since
  `Allow-Origin: *` is invalid with `Allow-Credentials` and browsers reject it.

## What free tier actually gives you

| | Consequence |
|---|---|
| SPA on static hosting | Always instant, no cold start, unlimited |
| API/ML suspend after ~15 min idle | First visit after a pause waits ~45s behind the explained gate |
| No persistent disk | Model registry is empty on every wake — hence `MODEL_BUNDLE_URL` |
| 512 MB RAM | Serving the champion measures ~340 MB, so it fits. **Training does not** — train locally |
| Instance hours pooled per account | Don't run an external pinger; it would exhaust the allowance |

The API and ML service sleep independently, so the first *prediction* can pay a
second cold start after the page is already up. `render.yaml` sets
`ML_HEALTH_TIMEOUT_MS=90000` and `ML_TIMEOUT_MS=120000`; with the code defaults
(3s / 10s) every such request would fail.

---

## 1. Database (TiDB Cloud)

1. Sign up at <https://tidbcloud.com>, create a **Serverless** cluster.
2. Create a database named `eai`.
3. From **Connect**, take the host, port (`4000`), user and password.

```
mysql://USER:PASSWORD@gateway01.REGION.prod.aws.tidbcloud.com:4000/eai?ssl={"minVersion":"TLSv1.2","rejectUnauthorized":true}
```

**The `ssl` parameter is required** — TiDB rejects unencrypted connections, and
`mysql2` enables TLS only when the DSN asks. Percent-encode `@ : / ? # &` if
they appear in the password.

The Python service reads this same string:
[`engine/db_url.py`](../ml-service/engine/db_url.py) prefers `DATABASE_URL`
over the `DB_*` vars and rewrites the TLS parameter into pymysql's spelling.

## 2. Model bundle

Registry pickles are not in git (OPS-2), and free tier has no disk, so the ML
service fetches them at start.

- **File:** `eai-models-v1.17.tar.gz` (16 MB compressed, 50 MB extracted)
- **SHA256:** `2ac9c74f87ce7610229fdb9c31fbd9fef1a9c5439d0337d8615fc09cc3900ed4`

Upload it as a **GitHub release asset** (Releases → Draft a new release → tag
`models-v1.17` → attach → publish) and copy the download URL. It must be
`https://`; the entrypoint refuses anything else.

> The archive holds pickles, and unpickling executes code. `render.yaml` pins
> `MODEL_BUNDLE_SHA256` so a swapped asset cannot turn a restart into code
> execution. Update the digest if you rebuild the bundle.

Rebuilding it:

```bash
cd ml-service/registry
tar -czf ../../eai-models-v1.17.tar.gz \
  rf_10d_v1.17.pkl rf_30d_v1.17.pkl rf_60d_v1.17.pkl \
  label_encoder_category_v1.17.pkl clip_thresholds_v1.17.json \
  feature_cols_v1.17.json \
  feature_importance_10d_v1.17.json feature_importance_30d_v1.17.json \
  feature_importance_60d_v1.17.json \
  metadata_10d_v1.17.json metadata_30d_v1.17.json metadata_60d_v1.17.json \
  drift_reference_v1.17.json drift_reference.json
sha256sum ../../eai-models-v1.17.tar.gz
```

## 3. Backend (Render blueprint)

1. Render → **New** → **Blueprint**, pointed at this repo, branch `main`.
2. It reads [`render.yaml`](../render.yaml) and proposes `eai-api`, `eai-ml`
   and the `eai-shared` env group. Apply.

`SESSION_SECRET` and `ML_SERVICE_TOKEN` are generated by Render. The token is
in a shared group so both services get the *same* value — the ML auth
middleware is a no-op when it is blank, which on a public service would leave
`/train` and `/models/promote` open.

The first ML build is slow; it compiles scipy/numba wheels.

Then fill in the values marked `sync: false`:

| Service | Variable | Value |
|---|---|---|
| `eai-api` | `DATABASE_URL` | the DSN from step 1 |
| `eai-ml` | `DATABASE_URL` | the same DSN |
| `eai-ml` | `MODEL_BUNDLE_URL` | the release asset URL from step 2 |
| `eai-api` | `ML_SERVICE_URL` | `https://eai-ml.onrender.com` — the real origin, no trailing slash |

Check the hostname on the `eai-ml` page; Render appends a suffix if the name
was taken. `ALLOWED_ORIGINS` comes in step 4, once the frontend has a URL.

## 4. Frontend (Vercel)

1. Vercel → **Add New** → **Project** → import the same repo.
2. [`vercel.json`](../vercel.json) sets the build (`npm run build:client` →
   `dist/public`) and the SPA rewrite. Leave the framework preset as-is.
3. Add one environment variable:

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://eai-api.onrender.com` — no trailing slash |

`VITE_API_URL` is inlined at **build** time, not read at runtime. Changing it
means redeploying the frontend, not just restarting it.

4. Deploy, then take the resulting URL and set it back on Render:

| Service | Variable | Value |
|---|---|---|
| `eai-api` | `ALLOWED_ORIGINS` | `https://your-project.vercel.app` |

Until that is set the browser blocks every API response, and the symptom is a
CORS error in the console with a perfectly healthy-looking server.

## 5. First boot

`eai-api` applies migrations before serving, so the schema — including the
`sessions` table — is created on first deploy:

```
[ENTRYPOINT] applying database migrations...
[ENTRYPOINT] migrations up to date
[CORS] allowing credentialed requests from: https://your-project.vercel.app
```

A failure exits non-zero rather than serving against a mismatched schema, and
names the cause:

```
[BOOT] startup failed: Failed query: ...
  caused by: connect ECONNREFUSED  [ECONNREFUSED]
```

`eai-ml` should report:

```
[ENTRYPOINT] registry is empty — fetching model bundle
[ENTRYPOINT] checksum verified
[ENTRYPOINT] extracted 3 model files
[STARTUP] Champion: v1.17
```

## 6. Seed the demo data

Open the Vercel URL, register the first account, and use **Load Demo Data**.

**Expect the training step to fail.** Step 7 of the seed pipeline calls the ML
service's `/train`, which will not complete in 512 MB. You do not need it — the
champion is already loaded from the bundle. The data and the predictions it
produces are still there if the pipeline marks itself failed at that step.

For a model trained against the seeded data, train locally with the same
`DATABASE_URL` and re-publish the bundle:

```bash
cd ml-service && python training/train_model_multihorizon.py
```

---

## Verifying

```bash
curl -s https://eai-api.onrender.com/api/health
# {"status":"healthy","timestamp":"..."}

curl -s https://eai-ml.onrender.com/health
# model_loaded true, model_version v1.17

# CORS: must echo the frontend origin, never *
curl -s -D- -o /dev/null -H 'Origin: https://your-project.vercel.app' \
  https://eai-api.onrender.com/api/health | grep -i access-control

# The token gate - must be 401, never 200:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://eai-ml.onrender.com/train

# The docs gate - must be 401 or 404, never 200:
for p in /docs /redoc /openapi.json; do
  printf '%-16s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://eai-ml.onrender.com$p")"
done
```

The last two are worth repeating after any env change.

A `200` from `/train` means `ML_SERVICE_TOKEN` is not set on `eai-ml`. The auth
middleware is a no-op when that variable is blank, so anyone could retrain or
promote a model.

A `200` from a doc path means `ENABLE_API_DOCS` was turned on, publishing every
path and schema of the service.

## Known gaps on this setup

- **Cold starts are visible, by design.** The gate explains the wait rather
  than hiding it. Removing it entirely costs ~$7/mo (`plan: starter` on
  `eai-api`) or ~$33/mo for both services plus a disk, which also makes
  `MODEL_BUNDLE_URL` unnecessary.
- **The ML service is a public web service.** Render's private services are
  paid, so the shared token is the only thing in front of it. It is compared
  with `hmac.compare_digest`, and admin verbs are audit-logged.
- **Swagger UI is off** (`ENABLE_API_DOCS=false`). The routes are not
  registered at all, so they 404 even with a valid token.
- **No CI gate on deploy.** `autoDeployTrigger: commit` ships whatever lands on
  `main`; the Actions workflow runs the Python tests but does not block it.
