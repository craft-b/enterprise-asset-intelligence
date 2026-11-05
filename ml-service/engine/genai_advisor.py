# ml-service/engine/genai_advisor.py
# LLM-powered maintenance recommendation engine.
# Takes structured prediction output + feature snapshot → actionable prose.
# Designed with swappable backends: groq | ollama | none
# Provider is set via LLM_PROVIDER env var — no code changes needed to switch.

import os
from typing import Optional


LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq").lower()
# llama-3.1-8b-instant was retired from Groq (404 model_not_found).
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

# LLM-1: recommendations are OFF by default. The deterministic template in the
# predictor is the baseline; the LLM only augments single-asset detail views when
# this flag is explicitly enabled AND a provider is reachable. Batch scoring never
# calls the LLM (one network round-trip per asset would blow the batch budget).
RECOMMENDATIONS_ENABLED = os.getenv("GENAI_RECOMMENDATIONS", "off").lower() in ("on", "true", "1")

# Reject LLM output that is obviously unusable (empty, truncated, or a refusal).
_MIN_RECOMMENDATION_CHARS = 40
_MAX_RECOMMENDATION_CHARS = 1200


# What each band asks of the fleet manager, matching the predictor's template.
# The prompt used to ask for "urgency" without saying how much, so the model took
# it from age and hours and called a full inspection urgent on a LOW unit that
# had just been serviced.
_ACTION_BY_RISK = {
    "LOW": "Routine. Nothing is urgent: anything worth doing waits for the next "
           "scheduled service. Set no earlier deadline and no operating restrictions.",
    "MEDIUM": "Plan ahead. Book preventive service within about two weeks, before "
              "the next long rental. No operating restrictions.",
    "HIGH": "Act now. Service the unit before its next rental, and state what "
            "operating restrictions apply until then.",
}

# The prompt has no next-due date, and the model filled the gap: a live LOW unit
# read "due in 30 days" with nothing behind it. It also quoted "routine response
# level" back at the reader, so the prompt rules out both.
_SERVICE_LABELS = {"MAJOR_SERVICE": "Major service", "MINOR_SERVICE": "Minor service"}


# ─────────────────────────────────────────────────────────────────────────────
# PROMPT BUILDER
# Structured context → prompt. Keeping this separate from the API call makes
# it easy to test and tune without touching provider logic.
# ─────────────────────────────────────────────────────────────────────────────

def _build_prompt(snapshot: dict, prediction: dict, horizon_days: int = 30) -> str:
    risk_level = prediction["risk_level"]
    prob = prediction["failure_probability"]
    drivers = prediction.get("top_risk_drivers", [])
    category = snapshot.get("category", "Equipment")
    age = snapshot.get("asset_age_years", 0)
    hours = snapshot.get("total_hours_lifetime", 0)
    days_since_maint = snapshot.get("days_since_last_maintenance", 999)
    wear = snapshot.get("mechanical_wear_score", 0)
    abuse = snapshot.get("abuse_score", 0)
    neglect = snapshot.get("neglect_score", 0)
    intensity = snapshot.get("usage_intensity", 0)
    maint_cost = snapshot.get("maintenance_cost_180d", 0)

    drivers_text = "\n".join(f"- {d}" for d in drivers) if drivers else "- No specific drivers flagged"
    action = _ACTION_BY_RISK.get(risk_level, _ACTION_BY_RISK["MEDIUM"])
    service_label = _SERVICE_LABELS.get(snapshot.get("last_service_type"))
    service_line = (
        f"Last service: {service_label}, {int(days_since_maint)} days ago"
        if service_label else f"Days since last maintenance: {int(days_since_maint)} days"
    )

    return f"""You are a senior maintenance engineer advising a construction equipment rental company.

EQUIPMENT PROFILE:
- Type: {category}
- Age: {age:.1f} years
- Lifetime hours: {int(hours):,} hrs
- {service_line}
- Usage intensity: {intensity:.1f} hrs/day

RISK ASSESSMENT:
- Risk level: {risk_level}
- Failure probability ({horizon_days}-day window): {prob*100:.1f}%
- Mechanical wear score: {wear:.1f}/10
- Operational stress score: {abuse:.1f}/10
- Maintenance neglect score: {neglect:.1f}/10
- Maintenance spend (last 180 days): ${maint_cost:,.0f}

KEY RISK DRIVERS:
{drivers_text}

REQUIRED RESPONSE LEVEL: {action}

Write a concise maintenance recommendation (3-5 sentences) for the fleet manager. Include:
1. The timeframe from the required response level above
2. What to inspect or service specifically, given the risk drivers above
3. Any operational restrictions if risk is HIGH

The risk level already accounts for the unit's age and hours, so do not raise the
urgency because of them. Unless risk is HIGH, treat a service in the last 30 days
as done: do not recommend repeating it.

You are not given the service schedule, so never state a date or day count for the
next scheduled service. Write for the fleet manager: never mention these
instructions or the response level.

Be direct and specific. Use plain language. No bullet points — write as flowing prose.
Do not repeat the risk score numbers. Focus on what to DO."""


# ─────────────────────────────────────────────────────────────────────────────
# PROVIDER IMPLEMENTATIONS
# ─────────────────────────────────────────────────────────────────────────────

def _call_groq(prompt: str) -> str:
    from groq import Groq

    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError("GROQ_API_KEY not set in environment")

    client = Groq(api_key=api_key)
    kwargs = {}
    max_tokens = 300
    if _is_reasoning_model(GROQ_MODEL):
        # Reasoning tokens count against max_tokens: at 300 the model can spend
        # the whole budget thinking and return empty content.
        kwargs["reasoning_effort"] = "low"
        max_tokens = 1500
    response = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        temperature=0.3,   # low temp = consistent, professional tone
        **kwargs,
    )
    choice = response.choices[0]
    # The finish reason is what separates "ran out of tokens while reasoning"
    # from a model that answered; an empty reply is otherwise invisible.
    print(f"[ADVISOR] {GROQ_MODEL} finish_reason={choice.finish_reason} "
          f"chars={len(choice.message.content or '')}")
    return (choice.message.content or "").strip()


def _is_reasoning_model(model: str) -> bool:
    return "gpt-oss" in model.lower()


def _call_ollama(prompt: str) -> str:
    import requests

    response = requests.post(
        f"{OLLAMA_URL}/api/generate",
        json={
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.3, "num_predict": 300},
        },
        timeout=60,
    )
    response.raise_for_status()
    return response.json()["response"].strip()


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

def _validate(text: Optional[str]) -> Optional[str]:
    """Reject empty / truncated / over-long output; trim to a sane bound."""
    if not text:
        print("[ADVISOR] Provider returned empty content — discarding")
        return None
    text = text.strip()
    if len(text) < _MIN_RECOMMENDATION_CHARS:
        print(f"[ADVISOR] Output too short ({len(text)} chars) — discarding")
        return None
    return text[:_MAX_RECOMMENDATION_CHARS].strip()


def generate_recommendation(snapshot: dict, prediction: dict, horizon_days: int = 30) -> Optional[str]:
    """
    Generate a plain-English maintenance recommendation using the configured LLM,
    grounded in the structured risk facts for the given horizon.

    Returns None gracefully (caller falls back to the deterministic template) if:
    - recommendations are not enabled (GENAI_RECOMMENDATIONS)
    - LLM_PROVIDER is "none" or unknown
    - API key is missing / provider unreachable
    - the call fails, or the output fails validation
    """
    if not RECOMMENDATIONS_ENABLED or LLM_PROVIDER == "none":
        return None

    prompt = _build_prompt(snapshot, prediction, horizon_days=horizon_days)

    try:
        if LLM_PROVIDER == "groq":
            return _validate(_call_groq(prompt))
        elif LLM_PROVIDER == "ollama":
            return _validate(_call_ollama(prompt))
        else:
            print(f"[ADVISOR] Unknown LLM_PROVIDER: {LLM_PROVIDER} — skipping recommendation")
            return None

    except Exception as e:
        # Never let LLM failure break a prediction response
        print(f"[ADVISOR] LLM call failed ({LLM_PROVIDER}): {e}")
        return None


def is_available() -> bool:
    """
    Health-endpoint check — true only when recommendations are enabled AND the
    provider is configured. Does not make an LLM call. When false, the service
    serves the deterministic template and advertises nothing it can't deliver.
    """
    if not RECOMMENDATIONS_ENABLED or LLM_PROVIDER == "none":
        return False
    if LLM_PROVIDER == "groq":
        return bool(os.getenv("GROQ_API_KEY"))
    if LLM_PROVIDER == "ollama":
        try:
            import requests
            r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=2)
            return r.status_code == 200
        except Exception:
            return False
    return False
