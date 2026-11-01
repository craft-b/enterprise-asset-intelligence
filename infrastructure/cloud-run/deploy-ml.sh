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
# Run it from the repo root in Cloud Shell, which already has gcloud signed in:
#
#   git clone https://github.com/craft-b/enterprise-asset-intelligence.git
#   cd enterprise-asset-intelligence
#   bash infrastructure/cloud-run/deploy-ml.sh
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

echo "Enabling Cloud Run, Cloud Build, Artifact Registry and IAM (no-op if already on)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iam.googleapis.com

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

REQUIRED=true
[ "$EXISTS" = true ] && REQUIRED=false

echo
echo "Paste each value and press Enter once. Nothing is shown as you paste,"
echo "but each answer reports how many characters arrived."
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

# ── The API's identity ──────────────────────────────────────────────────────
# One permission, on one resource: invoke this service. If the key leaks, it
# can call the ML service -- inside the instance cap -- and nothing else in the
# project.
if ! gcloud iam service-accounts describe "$INVOKER_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$INVOKER" \
    --display-name "EAI API (Render) - invokes eai-ml"
fi
gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
  --member "serviceAccount:$INVOKER_EMAIL" --role roles/run.invoker --quiet >/dev/null

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

# ── A key for the API ───────────────────────────────────────────────────────
# Render is not Google, so the API cannot borrow a Google identity the way a
# Cloud Run service can; it needs a key. Made only when none exists, because
# every key is another credential to keep track of.
EXISTING_KEYS="$(gcloud iam service-accounts keys list --iam-account "$INVOKER_EMAIL" \
  --managed-by user --format 'value(name)' | wc -l)"
MAKE_KEY=true
if [ "$EXISTING_KEYS" -gt 0 ]; then
  read -rp "$INVOKER already has $EXISTING_KEYS key(s). Make a new one? [y/N] " ANSWER
  [ "${ANSWER:-n}" = "y" ] || MAKE_KEY=false
fi

echo
echo "Next, in Render > eai-api > Environment:"
echo "  ML_SERVICE_URL        = $URL"
if [ "$MAKE_KEY" = true ]; then
  KEY_FILE="$(umask 077; mktemp)"
  gcloud iam service-accounts keys create "$KEY_FILE" --iam-account "$INVOKER_EMAIL" --quiet
  echo "  ML_SERVICE_GOOGLE_KEY = the line between the markers below"
  echo
  echo "----- copy from the next line -----"
  base64 -w0 "$KEY_FILE"; echo
  echo "----- to the line above -----"
  echo
  echo "That line is a credential. Paste it into Render and nowhere else."
  rm -f "$KEY_FILE"
else
  echo "  ML_SERVICE_GOOGLE_KEY = (unchanged -- the key Render already has)"
fi
echo
echo "Saving those redeploys the API. Then suspend eai-ml on Render."
