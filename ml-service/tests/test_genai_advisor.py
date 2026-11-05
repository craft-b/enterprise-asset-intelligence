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


def test_an_empty_reply_is_logged_not_silent(capsys):
    # The template fallback hid this: no exception, no log, just template text.
    assert genai_advisor._validate("") is None
    assert "empty content" in capsys.readouterr().out
