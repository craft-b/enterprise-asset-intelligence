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
