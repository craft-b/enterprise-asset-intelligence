# ml-service/tests/test_genai_advisor.py
#
# groq 0.11.0 passed `proxies` to httpx.Client, which httpx 0.28 removed. The
# local venv held httpx 0.27 and worked; a fresh install resolved 0.28, and
# every recommendation call raised TypeError -- swallowed by the advisor's
# fallback, so the only symptom was template text where LLM text should be.

import pytest

from engine import genai_advisor


def test_the_groq_client_constructs_with_the_installed_httpx():
    groq = pytest.importorskip("groq")
    # No network: constructing the client is where the incompatibility raised.
    groq.Groq(api_key="gsk_test")


def test_the_advisor_stays_off_unless_enabled(monkeypatch):
    monkeypatch.setattr(genai_advisor, "RECOMMENDATIONS_ENABLED", False)
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    assert genai_advisor.is_available() is False
    assert genai_advisor.generate_recommendation({}, {"risk_level": "HIGH", "failure_probability": 0.9}) is None


def test_enabled_with_a_key_reports_available(monkeypatch):
    monkeypatch.setattr(genai_advisor, "RECOMMENDATIONS_ENABLED", True)
    monkeypatch.setattr(genai_advisor, "LLM_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    assert genai_advisor.is_available() is True


def test_reasoning_models_get_room_to_answer(monkeypatch):
    # gpt-oss counts reasoning tokens against max_tokens; at 300 the content
    # came back empty. The call must lower effort and raise the budget.
    groq = pytest.importorskip("groq")
    sent = {}

    class _Msg:
        content = "Schedule an inspection of the hydraulic system within the week and keep the unit on light duty."

    class _Resp:
        choices = [type("C", (), {"message": _Msg(), "finish_reason": "stop"})()]

    def fake_create(self, **kwargs):
        sent.update(kwargs)
        return _Resp()

    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    monkeypatch.setattr(genai_advisor, "GROQ_MODEL", "openai/gpt-oss-20b")
    monkeypatch.setattr(groq.resources.chat.completions.Completions, "create", fake_create)
    assert genai_advisor._call_groq("prompt").startswith("Schedule")
    assert sent["reasoning_effort"] == "low"
    assert sent["max_tokens"] >= 1000


def _prompt(risk_level, **snapshot):
    return genai_advisor._build_prompt(
        snapshot, {"risk_level": risk_level, "failure_probability": 0.2}, horizon_days=60,
    )


def test_a_low_unit_is_not_asked_for_urgency():
    # An old, just-serviced LOW unit got "urgent ... within the next 14 days".
    low = _prompt("LOW", asset_age_years=9.0, total_hours_lifetime=14000)
    assert "Nothing is urgent" in low
    assert "Act now" not in low
    assert "do not raise the\nurgency" in low


@pytest.mark.parametrize("level,expected", [
    ("MEDIUM", "within about two weeks"),
    ("HIGH", "before its next rental"),
])
def test_the_response_level_follows_the_band(level, expected):
    assert expected in _prompt(level)


def test_the_prompt_forbids_an_invented_due_date():
    prompt = _prompt("LOW")
    assert "never state a date or day count" in prompt
    assert "never mention these\ninstructions" in prompt


def test_the_prompt_names_the_last_service():
    assert "Last service: Major service, 3 days ago" in _prompt(
        "LOW", last_service_type="MAJOR_SERVICE", days_since_last_maintenance=3,
    )
    # A snapshot without the field still builds a prompt.
    assert "Days since last maintenance: 40 days" in _prompt("LOW", days_since_last_maintenance=40)


def test_an_empty_reply_is_logged_not_silent(capsys):
    # The template fallback hid this: no exception, no log, just template text.
    assert genai_advisor._validate("") is None
    assert "empty content" in capsys.readouterr().out
