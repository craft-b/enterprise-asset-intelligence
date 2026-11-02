#!/usr/bin/env bash
# infrastructure/cloud-run/deploy-ml.sh
#
# Deploys the FastAPI ML service to Google Cloud Run as a private service.
#
# Why it moved off Render: Render fronts *.onrender.com with Cloudflare, and
# requests from eai-api to eai-ml started drawing a 429 with a "Just a
# moment..." JavaScript challenge -- one a server-side fetch can never solve.
# The API's egress is a shared NAT address, so the block does not decay on
# our schedule. Free Render services also cannot receive private-network
# traffic, which ruled out going around Cloudflare on Render itself. Cloud
# Run is the same container behind Google's front end, scaled to zero, inside
# the always-free allowance at demo traffic.
#
# Private, because this is the one service in the stack billed to a card.
# Google refuses any request without an identity token from an account
# allowed to invoke the service, before it reaches the container, and does
# not bill refused requests. The script creates one such account for the API
# (eai-api-invoker) and grants it that single permission on this one service.
#
# The API lives on Render, not Google, so it has to prove it is that account.
# A downloadable service account key would do, but Google now blocks key
# creation by default (iam.disableServiceAccountKeyCreation) -- the first real
# run was refused one. So the script sets up Workload Identity Federation: it
# generates a key pair, uploads only the public half to a workload identity
# pool, and prints the private half for Render. The API signs its own short
# JWT, Google's STS trusts it on that public key, and the pool's principal may
# mint ID tokens as eai-api-invoker and do nothing else. No Google-held key
# exists. See server/services/google-id-token.ts for the API side.
#
# Run it from the repo root in Cloud Shell, which already has gcloud signed in:
#
#   git clone https://github.com/craft-b/enterprise-asset-intelligence.git
#   cd enterprise-asset-intelligence
#   bash infrastructure/cloud-run/deploy-ml.sh
#
# To change access without rebuilding the image -- set up federation on a
# service that is already deployed, or rotate the API's key:
#
#   SKIP_DEPLOY=1 bash infrastructure/cloud-run/deploy-ml.sh
#
# It asks for DATABASE_URL and ML_SERVICE_TOKEN without echoing them, so they
# reach neither the screen nor shell history. On a re-deploy, press Enter at
# both prompts to keep the values the service already has.
#
# Cost controls, all deliberate:
#   private             unauthenticated requests are refused unbilled
#   --min-instances 0   scale to zero; an idle demo costs nothing
#   --max-instances 1   a ceiling on spend, and the service keeps training
#                       status and the challenger in memory, so one instance
#                       is also the only correct number
#   request billing     CPU is billed only while a request is in flight
#   cleanup policy      keeps the two newest images, so storage stays small
# The API adds the rest: viewer-driven ML calls are cached and budgeted
# (server/services/ml-response-cache.ts), which caps what even a signed-in
# script can make this service do.
#
# Request billing has one consequence: CPU is throttled between requests, so
# POST /train -- which returns at once and trains in the background -- will
# crawl. Scoring, drift, data quality and champion-challenger are ordinary
# request/response calls and are unaffected. The demo ships a trained model in
# the image, so nothing depends on training in production.

set -euo pipefail

SERVICE="${SERVICE:-eai-ml}"
# Oregon: Tier 1 pricing (the free allowance is full-size there) and the same
# region as the Render API, so the hop between them stays short.
REGION="${REGION:-us-west1}"
SOURCE_DIR="ml-service"
SOURCE_REPO="cloud-run-source-deploy"   # what `deploy --source` creates
INVOKER="eai-api-invoker"               # the API's identity

if [ ! -f "$SOURCE_DIR/Dockerfile" ]; then
  echo "Run this from the repo root: $SOURCE_DIR/Dockerfile not found." >&2
  exit 1
fi

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [ -z "$PROJECT" ]; then
  echo "No project selected. Run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi
INVOKER_EMAIL="$INVOKER@$PROJECT.iam.gserviceaccount.com"
echo "Project: $PROJECT   Region: $REGION   Service: $SERVICE"

echo "Enabling the APIs this needs (no-op if already on)..."
# sts and iamcredentials are the two halves of the federated exchange.
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iam.googleapis.com \
  sts.googleapis.com iamcredentials.googleapis.com

# `deploy --source` builds as the project's default compute service account,
# and new projects no longer grant that account broad rights: the first real
# run failed with 403 storage.objects.get on its own uploaded source. Cloud
# Run Builder is the role Google documents for this account and this job.
# Idempotent; a re-run re-asserts it.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role roles/run.builder --condition None --quiet >/dev/null

EXISTS=false
if gcloud run services describe "$SERVICE" --region "$REGION" >/dev/null 2>&1; then
  EXISTS=true
fi

# Pasting into a prompt that shows nothing is pasting blind: a paste that did
# not land and one that did look identical. So each prompt reports what
# arrived -- its length, never its content -- after trimming the stray
# whitespace and carriage returns a browser paste can carry.
#
# On a first deploy both are required, so an empty answer asks again rather
# than ending the run: two attempts at the original prompts ended with
# "both values are required" and no way to tell which paste had failed.
ask_secret() {
  local prompt="$1" required="$2" value
  while true; do
    # Everything but the value goes to stderr: this runs inside $(...).
    read -rsp "$prompt" value; echo >&2
    value="$(printf '%s' "$value" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [ -n "$value" ]; then
      echo "  (received ${#value} characters)" >&2
      break
    fi
    if [ "$required" != true ]; then
      echo "  (nothing received -- keeping the current value)" >&2
      break
    fi
    echo "  (nothing received -- the paste did not land. Copy the value again, then" >&2
    echo "   click in this window and press Ctrl+V, or right-click > Paste, then Enter.)" >&2
  done
  printf '%s' "$value"
}

# Collect the secrets, then build and deploy the image. A function so that
# SKIP_DEPLOY can step over it whole.
deploy_service() {
  REQUIRED=true
  [ "$EXISTS" = true ] && REQUIRED=false

  echo
  echo "Paste each value and press Enter once. Nothing is shown as you paste,"
  echo "but each answer reports how many characters arrived."
  local DB_URL TOKEN
  DB_URL="$(ask_secret "DATABASE_URL (same as Render's): " "$REQUIRED")"
  TOKEN="$(ask_secret "ML_SERVICE_TOKEN (Render > Env Groups > eai-shared): " "$REQUIRED")"

  ENV_ARGS=()
  if [ -z "$DB_URL" ] && [ -z "$TOKEN" ] && [ "$EXISTS" = true ]; then
    echo "Both blank: keeping the service's current environment."
  elif [ -z "$DB_URL" ] || [ -z "$TOKEN" ]; then
    [ -z "$DB_URL" ] && echo "DATABASE_URL arrived empty." >&2
    [ -z "$TOKEN" ] && echo "ML_SERVICE_TOKEN arrived empty." >&2
    echo "Both are required on a first deploy. Run the script again and paste the missing one." >&2
    exit 1
  else
    case "$DB_URL" in
      mysql://*) ;;
      *) echo "DATABASE_URL should start with mysql://" >&2; exit 1 ;;
    esac
    # A blank token turns the service's auth middleware into a no-op. Google's
    # check is the outer layer now, but the token is still the inner one.
    if [ "${#TOKEN}" -lt 16 ]; then
      echo "ML_SERVICE_TOKEN looks too short to be the generated one." >&2
      exit 1
    fi

    # The values go through a file, not --set-env-vars: that flag splits on
    # commas, and a DSN's query string is not guaranteed to be free of them.
    # JSON is valid YAML, and json.dumps handles any quoting the DSN needs.
    ENV_FILE="$(umask 077; mktemp)"
    trap 'rm -f "$ENV_FILE"' EXIT
    DB_URL="$DB_URL" TOKEN="$TOKEN" python3 - "$ENV_FILE" <<'PY'
import json, os, sys
env = {
    "DATABASE_URL": os.environ["DB_URL"],
    "ML_SERVICE_TOKEN": os.environ["TOKEN"],
    # The rest mirror eai-ml in render.yaml.
    "ENVIRONMENT": "production",
    "GENAI_RECOMMENDATIONS": "off",
    "ENABLE_API_DOCS": "false",
    "MODEL_VERSION": "v1",
    "PYTHONIOENCODING": "utf-8",
}
with open(sys.argv[1], "w") as f:
    json.dump(env, f)
PY
    ENV_ARGS=(--env-vars-file "$ENV_FILE")
  fi
  unset DB_URL TOKEN

  echo
  echo "Building and deploying. The first build takes about five minutes."
  gcloud run deploy "$SERVICE" \
    --source "$SOURCE_DIR" \
    --region "$REGION" \
    --no-allow-unauthenticated \
    --memory 1Gi \
    --cpu 1 \
    --cpu-throttling \
    --cpu-boost \
    --min-instances 0 \
    --max-instances 1 \
    --timeout 300 \
    --quiet \
    "${ENV_ARGS[@]}"

  # Gone as soon as it has been read. The trap is a fallback for a failed
  # deploy, and the key step below replaces it with its own.
  if [ -n "${ENV_FILE:-}" ]; then rm -f "$ENV_FILE"; fi
}

if [ "${SKIP_DEPLOY:-}" = 1 ]; then
  if [ "$EXISTS" != true ]; then
    echo "SKIP_DEPLOY=1, but $SERVICE is not deployed yet. Run without it first." >&2
    exit 1
  fi
  echo "SKIP_DEPLOY=1: leaving the deployed service as it is; setting up access only."
else
  deploy_service
fi

# ── The API's identity ──────────────────────────────────────────────────────
# One permission, on one resource: invoke this service. If the key leaks, it
# can call the ML service -- inside the instance cap -- and nothing else in the
# project.
if ! gcloud iam service-accounts describe "$INVOKER_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$INVOKER" \
    --display-name "EAI API (Render) - invokes eai-ml"
fi
# Grant an IAM role, retrying while a just-created principal propagates.
# A new service account or identity pool takes a moment to exist everywhere:
# the first real run bound the invoker two seconds after creating it and was
# told it "does not exist". Any other refusal -- an organization policy, say
# -- will not change with waiting, so it stops at once with Google's words.
grant() {
  local what="$1" err="" attempt
  shift
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if err="$(gcloud "$@" --quiet 2>&1 >/dev/null)"; then return 0; fi
    case "$err" in
      *"does not exist"*|*"not found"*|*NOT_FOUND*) ;;
      *) break ;;
    esac
    echo "  not visible to Google yet, retrying ($attempt/12)..."
    sleep 10
  done
  echo "Could not grant $what. Google said:" >&2
  echo "$err" >&2
  exit 1
}

grant "$INVOKER_EMAIL access to $SERVICE" \
  run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
  --member "serviceAccount:$INVOKER_EMAIL" --role roles/run.invoker

# Keep the two newest images and delete the rest. Keep rules win over delete
# rules, so the delete-everything rule only reaches what the keep rule leaves.
POLICY_FILE="$(mktemp)"
cat > "$POLICY_FILE" <<'JSON'
[
  {"name": "keep-two-newest", "action": {"type": "Keep"},
   "mostRecentVersions": {"keepCount": 2}},
  {"name": "delete-the-rest", "action": {"type": "Delete"},
   "condition": {"tagState": "ANY"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies "$SOURCE_REPO" \
  --location "$REGION" --policy "$POLICY_FILE" --no-dry-run --quiet \
  || echo "Note: could not set the image cleanup policy; old images will accumulate until it is set."
rm -f "$POLICY_FILE"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"

echo
echo "Deployed: $URL"
echo
echo "Without credentials (must be refused -- 403 means private):"
curl -sS -o /dev/null -w "  HTTP %{http_code}\n" --max-time 30 "$URL/health" || true
echo "With your credentials (must answer):"
curl -sS --max-time 90 -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/health" || true
echo

# ── How the API proves it is the API ───────────────────────────────────────
# Workload Identity Federation with an uploaded JWKS; see the header. The
# issuer is a name, not a URL Google fetches -- with the keys uploaded, it
# never asks the issuer for them -- so it only has to match the API's JWT.
POOL="eai-pool"
PROVIDER="eai-api"
SUBJECT="eai-api"
ISSUER="${API_ISSUER:-https://eai-api-q3u3.onrender.com}"
PROVIDER_AUD="https://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
PRINCIPAL="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/subject/$SUBJECT"

if ! gcloud iam workload-identity-pools describe "$POOL" --location global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --location global \
    --display-name "EAI API on Render"
fi

PROVIDER_EXISTS=false
if gcloud iam workload-identity-pools providers describe "$PROVIDER" \
    --workload-identity-pool "$POOL" --location global >/dev/null 2>&1; then
  PROVIDER_EXISTS=true
fi

# A new key pair only when there is no provider yet, or when asked: uploading
# one replaces the old, and the credential Render holds stops working.
MAKE_KEY=true
if [ "$PROVIDER_EXISTS" = true ]; then
  read -rp "The API already has a signing key. Replace it (Render's stops working until updated)? [y/N] " ANSWER
  [ "${ANSWER:-n}" = "y" ] || MAKE_KEY=false
fi

if [ "$MAKE_KEY" = true ]; then
  KEY_DIR="$(umask 077; mktemp -d)"
  trap 'rm -rf "$KEY_DIR"' EXIT
  KID="eai-api-$(date -u +%Y%m%d%H%M%S)"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY_DIR/key.pem" 2>/dev/null
  # The public half as a JWKS. openssl prints the modulus as hex; the exponent
  # is genpkey's default, 65537, which is "AQAB" in base64url.
  MODULUS="$(openssl rsa -in "$KEY_DIR/key.pem" -noout -modulus 2>/dev/null | cut -d= -f2)"
  KID="$KID" MODULUS="$MODULUS" python3 - "$KEY_DIR/jwks.json" <<'PY'
import base64, json, os, sys
n = base64.urlsafe_b64encode(bytes.fromhex(os.environ["MODULUS"])).rstrip(b"=").decode()
jwk = {"kty": "RSA", "alg": "RS256", "use": "sig", "kid": os.environ["KID"], "n": n, "e": "AQAB"}
json.dump({"keys": [jwk]}, open(sys.argv[1], "w"))
PY

  if [ "$PROVIDER_EXISTS" = true ]; then
    gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" \
      --workload-identity-pool "$POOL" --location global \
      --jwk-json-path "$KEY_DIR/jwks.json" --quiet
  else
    gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
      --workload-identity-pool "$POOL" --location global \
      --issuer-uri "$ISSUER" \
      --allowed-audiences "$PROVIDER_AUD" \
      --attribute-mapping "google.subject=assertion.sub" \
      --attribute-condition "assertion.sub == '$SUBJECT'" \
      --jwk-json-path "$KEY_DIR/jwks.json"
  fi
fi

# The federated identity may mint ID tokens as the invoker, and nothing else:
# not access tokens, not keys, not anything on any other account.
grant "the federated identity the right to act as $INVOKER_EMAIL" \
  iam service-accounts add-iam-policy-binding "$INVOKER_EMAIL" \
  --member "$PRINCIPAL" --role roles/iam.serviceAccountOpenIdTokenCreator

echo
echo "Next, in Render > eai-api > Environment:"
echo "  ML_SERVICE_URL        = $URL"
if [ "$MAKE_KEY" = true ]; then
  echo "  ML_SERVICE_GOOGLE_KEY = the line between the markers below"
  echo
  echo "----- copy from the next line -----"
  KEY_PEM="$(cat "$KEY_DIR/key.pem")" KID="$KID" ISSUER="$ISSUER" SUBJECT="$SUBJECT" \
    AUD="$PROVIDER_AUD" SA="$INVOKER_EMAIL" python3 - <<'PY'
import base64, json, os
credential = {
    # Read by parseGoogleCredential in server/services/google-id-token.ts.
    "type": "eai_workload_identity_federation",
    "private_key": os.environ["KEY_PEM"] + "\n",
    "key_id": os.environ["KID"],
    "issuer": os.environ["ISSUER"],
    "subject": os.environ["SUBJECT"],
    "audience": os.environ["AUD"],
    "service_account": os.environ["SA"],
}
print(base64.b64encode(json.dumps(credential).encode()).decode())
PY
  echo "----- to the line above -----"
  echo
  echo "That line is a credential. Paste it into Render and nowhere else."
else
  echo "  ML_SERVICE_GOOGLE_KEY = (unchanged -- the credential Render already has)"
fi
echo
echo "Saving those redeploys the API. Then suspend eai-ml on Render."
