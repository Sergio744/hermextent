"""OpenAI-compatible model provider backed by a browser session through Hermes Browser."""
from providers import register_provider
from providers.base import ProviderProfile


browser = ProviderProfile(
    name="hermes-browser",
    aliases=("hermes-web",),
    display_name="Hermes Browser Session",
    description="Uses a signed-in browser provider via the Hermes Browser Native Messaging relay.",
    base_url="http://127.0.0.1:8765/v1",
    env_vars=("HERMEXTENT_BRIDGE_TOKEN",),
    auth_type="api_key",
    supports_streaming=True,
    supports_model_listing=False,
    supports_health_check=False,
    hidden=False,
)

register_provider(browser)
