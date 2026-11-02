# Deploying

Four hosts, all on free tiers, no monthly bill:

```
                      ┌──────────────────────────────┐
  browser ───────────▶│ Vercel    React SPA (static) │  always instant
                      └──────────────┬───────────────┘
                                     │ /api/* proxied, first-party cookie
                      ┌──────────────▼───────────────┐
                      │ Render    Node API           │  sleeps when idle
                      └──────────────┬───────────────┘
                                     │ Google ID token (federated) + X-Service-Token
                      ┌──────────────▼───────────────┐
                      │ Cloud Run FastAPI + sklearn  │  private, scales to zero
                      └──────────────┬───────────────┘
                                     │ TLS
                      ┌──────────────▼───────────────┐
                      │ TiDB      Serverless MySQL   │  always on
                      └──────────────────────────────┘
```

The database is external because Render offers Postgres only and this stack is
MySQL-specific (`drizzle-orm/mysql2` on the Node side, `pymysql` on the Python
side). TiDB Cloud Serverless is wire-compatible and free.

The ML service ran on Render too until 2026-11-02, and `render.yaml` still
defines it. [Step 3b](#3b-ml-service-google-cloud-run) has why it moved. Of
the four, Google Cloud is the one billed to a card, so it is the one with a
spend cap, a private endpoint and a bounded request rate in front of it.

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
| API suspends after ~15 min idle (Render) | First visit after a pause waits 51–73s behind the explained gate |
| ML scales to zero when idle (Cloud Run) | The first ML call after a pause pays its own, shorter cold start |
| No persistent disk on either | Model registry is empty on every start — hence the bundle baked into the image |
| ML CPU billed only during requests | Serving fits easily. **Training on demand crawls** (it runs after its request returns) — train locally |
| Render instance hours pooled per account | Don't run an external pinger; it would exhaust the allowance |

The API and ML service sleep independently, so the first *prediction* can pay a
second cold start after the page is already up. `render.yaml` sets
`ML_HEALTH_TIMEOUT_MS=90000` and `ML_TIMEOUT_MS=120000`; with the code defaults
(3s / 10s) every such request would fail when the ML service was on Render, and
they stay generous for Cloud Run.

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

Nothing to do — the champion bundle is committed at
`ml-service/models/eai-models-v1.17.tar.gz` (16MB) and extracted into the image
at build time.

It used to be fetched from a GitHub release to keep artifacts out of git
(OPS-2). That failed in practice: GitHub's CDN answers requests from Render's
addresses with `502 Bad Gateway`, both from the running container and from the
build, while the same URL fetches in under two seconds from a laptop. Retrying
does not help an address-based refusal, so the bundle moved into the repo. One
current champion ships; superseded versions stay out.

To publish a new champion:

```bash
cd ml-service/registry
tar -czf ../models/eai-models-v1.18.tar.gz   rf_10d_v1.18.pkl rf_30d_v1.18.pkl rf_60d_v1.18.pkl   label_encoder_category_v1.18.pkl clip_thresholds_v1.18.json   feature_cols_v1.18.json   feature_importance_10d_v1.18.json feature_importance_30d_v1.18.json   feature_importance_60d_v1.18.json   metadata_10d_v1.18.json metadata_30d_v1.18.json metadata_60d_v1.18.json   drift_reference_v1.18.json drift_reference.json
sha256sum ../models/eai-models-v1.18.tar.gz
```

Then update `MODEL_BUNDLE_SHA256` in `ml-service/Dockerfile`, delete the old
tarball, and commit. The digest is checked before extraction: the archive holds
pickles, and unpickling executes code, so a swapped file must not load.

Hosting it externally instead still works — set `MODEL_BUNDLE_URL` as a build
arg or service env var, and it is used whenever the committed file is absent.

## 3. Backend (Render blueprint)

1. Render → **New** → **Blueprint**, pointed at this repo, branch `main`.
2. It reads [`render.yaml`](../render.yaml) and proposes `eai-api`, `eai-ml`
   and the `eai-shared` env group. Apply. (`eai-ml` on Render is superseded by
   [step 3b](#3b-ml-service-google-cloud-run); it still works as a starting
   point, and this deployment keeps it suspended rather than deleted.)

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
path in step 4. With the ML service on Cloud Run, `ML_SERVICE_URL` takes the
Cloud Run URL instead, and `eai-api` gains `ML_SERVICE_GOOGLE_KEY` (step 3b).

## 3b. ML service (Google Cloud Run)

**Why it moved.** On 2026-10-30 requests from `eai-api` to `eai-ml` began
drawing HTTP 429 with a Cloudflare "Just a moment..." JavaScript challenge,
which no server-side request can solve. Render's free services egress through
a shared NAT address, so the block does not lift on any schedule of ours, and
Render's supported way around its edge — private networking — lets a free
service send private traffic but not receive it. Cloud Run is the same
container behind Google's front end, scaled to zero.

**What it costs: nothing, with a card on file.** Cloud Run's always-free
allowance (Tier 1 regions such as `us-west1`, per billing account per month)
is 2M requests, 180,000 vCPU-seconds and 360,000 GiB-seconds on request-based
billing. Demo traffic is a sliver of that, and the API bounds what viewer
traffic can cause at ~648k requests and ~149k vCPU-seconds a month however it
is driven — see [Cost and abuse controls](../README.md#cost-and-abuse-controls).
New accounts start on a 90-day trial that never charges the card; to keep the
service past it, activate the full account, after which the free allowance
applies.

**Before deploying,** in the Google Cloud console:

1. Create a project, and a billing account (the trial is fine).
2. **Billing → Budgets & alerts → Create budget → Spend cap enforcement**,
   scoped to the project and **Cloud Run**, at **$5/month**. A spend cap
   pauses Cloud Run when gross list-price cost reaches the cap, until the next
   month — the dashboard then falls back to what it reads from the database.
   $5 sits above anything normal traffic or the API's ceiling can produce at
   list price, so it only trips on something unforeseen. (Caps lag cost
   reporting slightly; overage from that lag is yours.)

**Deploy,** from Cloud Shell (which has `gcloud` signed in):

```bash
gcloud config set project YOUR_PROJECT_ID
git clone https://github.com/craft-b/enterprise-asset-intelligence.git
cd enterprise-asset-intelligence
bash infrastructure/cloud-run/deploy-ml.sh
```

It asks for `DATABASE_URL` and `ML_SERVICE_TOKEN` (the value in Render's
`eai-shared` group) without echoing them, reporting only how many characters
arrived. Then it:

- grants the project's default compute account **Cloud Run Builder**, which
  `deploy --source` builds as and which new projects no longer give access to
  its own uploaded source (the first real build failed with 403
  `storage.objects.get`);
- deploys **private** (`--no-allow-unauthenticated`), 1 vCPU / 1 GiB, min 0
  and max 1 instances, CPU billed only during requests, and an image cleanup
  policy that keeps the two newest;
- creates `eai-api-invoker` with **Cloud Run Invoker** on this one service,
  retrying while the new account propagates (the first run was told it "does
  not exist" two seconds after creating it);
- sets up **Workload Identity Federation** in place of a service account key,
  because new projects enforce `iam.disableServiceAccountKeyCreation` — the
  first run was refused one. It generates a key pair, uploads only the public
  half as the JWKS of a pool provider, lets that pool's one principal mint ID
  tokens as `eai-api-invoker` and do nothing else, and prints the private
  half. The API signs its own ten-minute JWT, Google's STS exchanges it, and
  IAM Credentials mints the Cloud Run ID token
  ([`google-id-token.ts`](../server/services/google-id-token.ts)). No
  Google-held key exists.

It ends by checking that a request without credentials is refused (403) and
one with yours is answered, and prints two values for **Render → eai-api →
Environment**:

| Variable | Value |
|---|---|
| `ML_SERVICE_URL` | the Cloud Run URL it prints |
| `ML_SERVICE_GOOGLE_KEY` | the credential line between the markers — paste it there and nowhere else |

The API checks the credential at boot and refuses to start on a malformed one,
and Render keeps the previous deploy serving when a new one fails, so a bad
paste fails safe.

To change access without rebuilding — rotate the API's key, or finish setup on
a service that is already deployed:

```bash
SKIP_DEPLOY=1 bash infrastructure/cloud-run/deploy-ml.sh
```

Then suspend `eai-ml` on Render.

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
| Vercel | `VITE_API_URL` | `https://YOUR-API.onrender.com` — your real host, no trailing slash |
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

The ML service (in Cloud Run's logs, or Render's for `eai-ml`) should report:

```
[ENTRYPOINT] registry is empty — fetching model bundle
[ENTRYPOINT] checksum verified
[ENTRYPOINT] extracted 3 model files
[STARTUP] Champion: v1.17
```

## 6. Seed the demo data

Open the Vercel URL and sign in as `admin` / `admin123`. Seeding needs the
administrator account: **Load Demo Data** is behind an admin check, and the
login page deliberately advertises only `viewer` / `viewer123` — a visitor who
reseeds wipes the data for anyone else looking at the same deployment.

Both accounts exist because `render.yaml` sets `SEED_DEMO_USERS=true`, which
creates them at boot if absent — without it the page advertises an account
nobody created, and a visitor who types what they were told is rejected.

Neither password is a secret: both are committed in
[`server/seeds/demo-users.ts`](../server/seeds/demo-users.ts) in a public
repository. Not advertising the administrator one keeps a destructive button
out of a casual visitor's way; it does not protect the account. To actually
protect it, change that account's password directly in the database — the seed
is idempotent and never overwrites an account that already exists, so it will
not be reverted on the next run.

Then use **Load Demo Data** on the onboarding screen.

**Expect the training step to fail.** Step 7 of the seed pipeline calls the ML
service's `/train`, which will not complete on this configuration: on Render's
512 MB it runs out of memory, and on Cloud Run with request-based billing the
job runs after its request has returned, when CPU is throttled. You do not need
it — the champion is already loaded from the bundle. The data and the predictions it
produces are still there if the pipeline marks itself failed at that step.

For a model trained against the seeded data, train locally with the same
`DATABASE_URL` and re-publish the bundle:

```bash
cd ml-service && python training/train_model_multihorizon.py
```

---

## Verifying

Substitute your own API host throughout. Render suffixes the hostname when the
plain name is taken, so the API is very unlikely to be at `eai-api.onrender.com`
— take it from `vercel.json`'s rewrite destination, or from the top of the
Render service page. This repo's own deployment is `eai-api-q3u3.onrender.com`,
with the ML service at `eai-ml-q2n75oonzq-uw.a.run.app`.

A wrong host here answers `404 Not Found` in under a second, which reads exactly
like a dead API and is not one.

```bash
curl -s https://YOUR-API.onrender.com/api/health
# {"status":"healthy","timestamp":"...","commit":"...","uptimeSeconds":...}

# The proxy: Vercel serves it, Render answers it, one origin to the browser
curl -s https://your-project.vercel.app/api/health
# healthy JSON here; a 404 means the vercel.json rewrite host is wrong

# Only on the direct cross-origin path - must echo the origin, never *
# curl -s -D- -o /dev/null -H 'Origin: https://your-project.vercel.app' \
#   https://YOUR-API.onrender.com/api/health | grep -i access-control

ML=https://YOUR-SERVICE.a.run.app   # what deploy-ml.sh printed

# Private - must be 403, from Google, never 200:
curl -s -o /dev/null -w '%{http_code}\n' "$ML/health"

# From Cloud Shell, with your own identity - healthy, model_loaded true:
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$ML/health"

# Past Google, the token gate - must be 401, never 200:
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$ML/train"

# And the docs gate - must be 401 or 404, never 200:
for p in /docs /redoc /openapi.json; do
  printf '%-16s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$ML$p")"
done
```

The last two are worth repeating after any env change.

A `200` from the first means the service was deployed with
`--allow-unauthenticated`: anyone with the URL can wake it and bill it.

A `200` from `/train` means `ML_SERVICE_TOKEN` is not set on the service. The
auth middleware is a no-op when that variable is blank, so anyone past Google's
check could retrain or promote a model.

A `200` from a doc path means `ENABLE_API_DOCS` was turned on, publishing every
path and schema of the service.

The whole chain, as the API sees it, is one admin request: sign in on the site
as an administrator and open `/api/ml/diagnostics` on that same domain. The
Vercel domain and the Render domain each keep their own sign-in, and anything
short of an admin session there gets `{"message":"Forbidden"}`. `mlAuth` should
read `google-id-token + service token`, `probes.neutral` 204 (this instance can
reach the internet), `probes.ml` 200 (the API minted a token and Cloud Run let
it in), `probes.mlUnauthenticated` 403, and `client.visitor` your own address.

## Known gaps on this setup

- **Cold starts are visible, by design.** The gate explains the wait rather
  than hiding it. Removing the API's costs ~$7/mo (`plan: starter` on
  `eai-api`); the ML service's would cost a Cloud Run minimum instance, which
  is billed continuously and is exactly what scaling to zero avoids.
- **The ML service is private, but the API is its proxy.** Google refuses
  anything without the API's identity, unbilled; behind that the shared token
  is compared with `hmac.compare_digest` and admin verbs are audit-logged. The
  API itself is public and the viewer password is published, so viewer routes
  that reach the ML service are cached and draw on a global budget — that, not
  the private endpoint, is what bounds the bill.
- **The rate limits trust Vercel's record of who is asking.** Through the
  proxy, the address Cloudflare sees is Vercel's, so the per-visitor count
  reads the entry Vercel wrote into `X-Forwarded-For`. A request sent to
  Render directly can forge that entry; each limit therefore also counts the
  unforgeable Cloudflare address at ten times the allowance.
- **Swagger UI is off** (`ENABLE_API_DOCS=false`). The routes are not
  registered at all, so they 404 even with a valid token.
- **Session cookies are first-party only because of the proxy.** Switching to
  direct cross-origin calls makes the cookie third-party, and Safari drops
  it. A custom domain with the API on a subdomain would also solve it, at
  the cost of owning a domain.
- **No CI gate on deploy.** `autoDeployTrigger: commit` ships whatever lands on
  `main`; the Actions workflow runs the Python tests but does not block it.
