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

It costs one piece of indirection: the SPA and the API are on different hosts,
so `/api/*` has to reach the API and the session cookie has to survive.

**The default is to proxy, not to call cross-origin.** `vercel.json` rewrites
`/api/*` to the Render API, so the browser only ever sees one origin. That
matters because of cookies: EAI authenticates with a session cookie, and a
cookie set by `onrender.com` while the page is `vercel.app` is a *third-party*
cookie. Safari blocks those by default, so a visitor there would sign in and
land straight back on the login screen. Proxying makes the cookie first-party
and sidesteps CORS entirely.

The direct cross-origin path is still fully supported and tested — set
`VITE_API_URL` and `ALLOWED_ORIGINS` and it works — but it inherits the
third-party cookie problem, so prefer the proxy unless you have a reason not
to.

- **Request routing** — with the proxy, relative `/api` paths simply stay
  relative and Vercel forwards them; the wrapper in
  [`api-base.ts`](../client/src/lib/api-base.ts) is a no-op. If instead you set
  `VITE_API_URL`, that wrapper rewrites the ~80 relative call sites to the API
  origin at runtime, so none of them changed and a new one cannot forget.
- **Cookies** — already correct for this: the session sets
  `sameSite: "none"; secure: true` in production, and every request sends
  credentials.
- **CORS** — not needed with the proxy, since the browser sees same-origin
  requests. For the direct path, [`cors.ts`](../server/services/cors.ts) answers
  only origins named in `ALLOWED_ORIGINS`, with credentials. A wildcard is
  refused at boot, since `Allow-Origin: *` is invalid with `Allow-Credentials`
  and browsers reject it.

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

> **On shared clusters:** the connection user TiDB Serverless hands you is
> cluster-wide, so that credential — sitting in Render's environment — can also
> reach every other database on the cluster. Give EAI its own scoped user:
>
> ```sql
> CREATE USER 'PREFIX.eai_app'@'%' IDENTIFIED BY '<48 hex chars>';
> GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX ON eai.* TO 'PREFIX.eai_app'@'%';
> SHOW GRANTS FOR 'PREFIX.eai_app'@'%';
> ```
>
> Three things make this fail in ways the error messages only half explain:
>
> - **The username must start with your cluster prefix** (`ztBmeZ6...`), which
>   the Connect panel shows. Without it: *"User name must start with ..."*.
> - **Run the statements one at a time.** The SQL Editor executes only the
>   statement under the cursor, so a pasted block runs just the last line. A
>   `GRANT` to a user that was never created reports *"You are not allowed to
>   create a user with GRANT"* — which reads like a permissions ban and is
>   really MySQL refusing to create a user implicitly.
> - **`CREATE` and `ALTER` are required**, not just read/write: the first boot
>   runs migrations that create 23 tables.
>
> Use a hex password (`openssl rand -hex 24`). Base64 contains `+` and `/`,
> which need percent-encoding inside a DSN and silently break auth otherwise.
>
> If scoping genuinely is not available on your plan, the default user works —
> just know a leaked `DATABASE_URL` then exposes the whole cluster rather than
> one database, and put EAI on its own cluster if the neighbours matter.

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
was taken. Those four are the only values the blueprint asks for —
`ALLOWED_ORIGINS` defaults to empty and is needed only on the cross-origin
path in step 4.

## 4. Frontend (Vercel)

1. **Edit `vercel.json` first.** The proxy destination has to be literal —
   Vercel does not interpolate environment variables in this file. Replace the
   host with your own API URL from step 3 and commit:

   ```json
   { "source": "/api/:path*", "destination": "https://YOUR-API.onrender.com/api/:path*" }
   ```

   Render suffixes the hostname when the plain name is taken, so take the
   exact URL from the top of the service page rather than assuming
   `eai-api.onrender.com`. A wrong host here returns 404 from every API call
   while the service itself is perfectly healthy.

   ```json
   ```

2. Vercel → **Add New** → **Project** → import this repo.

3. Leave the defaults. `vercel.json` already sets the build
   (`npm run build:client` → `dist/public`), the SPA fallback and the proxy.
   Root Directory stays the repo root.

4. **Set no environment variables.** Leaving `VITE_API_URL` unset is what keeps
   requests relative so the proxy handles them. Setting it would switch the app
   to direct cross-origin calls and reintroduce the third-party cookie problem.

5. Deploy. Nothing needs to change on Render afterwards — with the proxy there
   is no second origin, so `ALLOWED_ORIGINS` can stay unset.

### Preview deployments

Every branch and pull request gets its own `*.vercel.app` hostname. Those work
with the proxy, because the API is reached through whatever host served the
page. (On the direct cross-origin path they would each need adding to
`ALLOWED_ORIGINS` — another reason to prefer the proxy.)

### If you use the direct cross-origin path instead

Skip the `vercel.json` rewrite, and set these instead:

| Where | Variable | Value |
|---|---|---|
| Vercel | `VITE_API_URL` | `https://eai-api.onrender.com` — no trailing slash |
| Render `eai-api` | `ALLOWED_ORIGINS` | `https://your-project.vercel.app` |

`VITE_API_URL` is inlined at **build** time, so changing it needs a redeploy,
not a restart. Until `ALLOWED_ORIGINS` is set the browser blocks every
response while the server looks perfectly healthy — a CORS error in the
console is the only symptom. And expect Safari to drop the session cookie.

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

Open the Vercel URL and sign in with the credentials the login page shows
(`admin` / `admin123`). They exist because `render.yaml` sets
`SEED_DEMO_USERS=true`, which creates them at boot if absent — without it
the page advertises an account nobody created, and a visitor who types
what they were told is rejected.

Then use **Load Demo Data** on the onboarding screen.

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

# The proxy: Vercel serves it, Render answers it, one origin to the browser
curl -s https://your-project.vercel.app/api/health
# healthy JSON here; a 404 means the vercel.json rewrite host is wrong

# Only on the direct cross-origin path - must echo the origin, never *
# curl -s -D- -o /dev/null -H 'Origin: https://your-project.vercel.app' \
#   https://eai-api.onrender.com/api/health | grep -i access-control

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
- **Session cookies are first-party only because of the proxy.** Switching to
  direct cross-origin calls makes the cookie third-party, and Safari drops
  it. A custom domain with the API on a subdomain would also solve it, at
  the cost of owning a domain.
- **No CI gate on deploy.** `autoDeployTrigger: commit` ships whatever lands on
  `main`; the Actions workflow runs the Python tests but does not block it.
