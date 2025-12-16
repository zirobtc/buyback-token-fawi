"""
Gradio control panel for the Node control API (src/scripts/server.ts).

Endpoints used:
  - GET  /health
  - GET  /settings
  - POST /holders/refresh
  - GET  /distribution/status
  - POST /distribution/start
  - POST /distribution/pause
"""
import json
import os
from typing import Any, Dict, Optional

import gradio as gr
import requests

DEFAULT_BASE_URL = os.getenv("CONTROL_API_BASE", "http://localhost:3001")


def as_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if value is not None else None
    try:
        n = float(value)
        return n if not (n != n) and n != float("inf") and n != float("-inf") else None
    except Exception:  # noqa: BLE001
        return None


def api_request(
    base_url: str,
    method: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = 10.0,
) -> Dict[str, Any]:
    url = base_url.rstrip("/") + path
    try:
        response = requests.request(method, url, json=payload, timeout=timeout)
        response.raise_for_status()
        return {"ok": True, "data": response.json()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def pretty(data: Any) -> str:
    try:
        return json.dumps(data, indent=2)
    except Exception:  # noqa: BLE001
        return str(data)


def check_health(base_url: str):
    return pretty(api_request(base_url, "GET", "/health"))


def load_settings(base_url: str):
    return pretty(api_request(base_url, "GET", "/settings"))


def load_settings_full(base_url: str):
    resp = api_request(base_url, "GET", "/settings")
    return parse_settings_response(resp)


def save_settings(
    base_url: str,
    poll_interval_ms: Optional[float],
    trigger_sol: Optional[float],
    sol_cap: Optional[float],
    batch_size: Optional[float],
    target_recipients: Optional[float],
    recipient_fetch_size: Optional[float],
    slippage_bps: Optional[float],
    tokens_csv: str,
    limit: Optional[float],
    min_token_amount: Optional[float],
    min_holder_balance_sol: Optional[float],
    refetch_existing: bool,
    balance_batch_size: Optional[float],
):
    tokens = [t.strip() for t in tokens_csv.split(",") if t.strip()] if tokens_csv else None
    poll_interval_ms = as_number(poll_interval_ms)
    trigger_sol = as_number(trigger_sol)
    sol_cap = as_number(sol_cap)
    batch_size = as_number(batch_size)
    target_recipients = as_number(target_recipients)
    recipient_fetch_size = as_number(recipient_fetch_size)
    slippage_bps = as_number(slippage_bps)
    limit = as_number(limit)
    min_token_amount = as_number(min_token_amount)
    min_holder_balance_sol = as_number(min_holder_balance_sol)
    balance_batch_size = as_number(balance_batch_size)
    payload = {
        "pollIntervalMs": poll_interval_ms,
        "triggerSol": trigger_sol,
        "solCap": sol_cap,
        "batchSize": batch_size,
        "targetRecipients": target_recipients,
        "recipientFetchSize": recipient_fetch_size,
        "slippageBps": slippage_bps,
        "tokens": tokens,
        "limit": limit,
        "minTokenAmount": min_token_amount,
        "minHolderBalanceSol": min_holder_balance_sol,
        "refetchExisting": refetch_existing,
        "balanceBatchSize": balance_batch_size,
    }
    resp = api_request(base_url, "POST", "/settings/update", payload, timeout=15.0)
    return parse_settings_response(resp)


def refresh_holders(
    base_url: str,
    tokens_csv: str,
    limit: int,
    min_token_amount: float,
    min_holder_balance_sol: float,
    balance_batch_size: Optional[float],
    refetch_existing: bool,
):
    tokens = [t.strip() for t in tokens_csv.split(",") if t.strip()] if tokens_csv else None
    limit = as_number(limit)
    min_token_amount = as_number(min_token_amount)
    min_holder_balance_sol = as_number(min_holder_balance_sol)
    balance_batch_size = as_number(balance_batch_size)
    payload = {
        "tokens": tokens,
        "limit": limit or None,
        "minTokenAmount": min_token_amount,
        "minHolderBalanceSol": min_holder_balance_sol,
        "balanceBatchSize": balance_batch_size,
        "refetchExisting": refetch_existing,
    }
    return pretty(api_request(base_url, "POST", "/holders/refresh", payload, timeout=30.0))


def distribution_status(base_url: str):
    return pretty(api_request(base_url, "GET", "/distribution/status"))


def start_distribution(
    base_url: str,
    mint: str,
    poll_interval_ms: int,
    trigger_sol: float,
    sol_cap: float,
    batch_size: int,
    slippage_bps: int,
):
    payload = {
        "mint": mint or None,
        "pollIntervalMs": poll_interval_ms or None,
        "triggerSol": trigger_sol or None,
        "solCap": sol_cap or None,
        "batchSize": batch_size or None,
        "slippageBps": slippage_bps or None,
    }
    return pretty(api_request(base_url, "POST", "/distribution/start", payload))


def pause_distribution(base_url: str):
    return pretty(api_request(base_url, "POST", "/distribution/pause"))


def parse_settings_response(resp: Dict[str, Any]):
    defaults = {
        "mint": "",
        "poll_interval": None,
        "trigger_sol": None,
        "sol_cap": None,
        "batch_size": None,
        "target_recipients": None,
        "recipient_fetch_size": None,
        "slippage_bps": None,
        "tokens_csv": "",
        "limit": None,
        "min_token_amount": None,
        "min_holder_balance_sol": None,
        "refetch_existing": False,
        "balance_batch_size": None,
        "unique_holders": None,
        "sent_count": None,
    }
    if resp.get("ok"):
        data = resp.get("data", {})
        settings = data.get("settings", {})
        buyback = settings.get("buyback", {})
        distribution = settings.get("distribution", {})
        holders = settings.get("holders", {})
        holder_tokens = data.get("holderTokens") or []
        holder_summary = data.get("holderSummary") or {}
        defaults = {
          "mint": data.get("mintPublicKey")
          or settings.get("mintPublicKey")
          or "",
          "poll_interval": as_number(buyback.get("pollIntervalMs")),
          "trigger_sol": as_number(buyback.get("triggerSol")),
          "sol_cap": as_number(buyback.get("solCap")),
          "batch_size": as_number(distribution.get("batchSize")),
          "target_recipients": as_number(distribution.get("targetRecipients")),
          "recipient_fetch_size": as_number(distribution.get("fetchSize")),
          "slippage_bps": as_number(settings.get("defaults", {}).get("defaultSlippageBps")),
          "tokens_csv": ", ".join(holder_tokens or holders.get("tokens", []) or []),
          "limit": as_number(holders.get("maxFetchHolders")),
          "min_token_amount": as_number(holders.get("minHolderTokenAmount")),
          "min_holder_balance_sol": as_number(holders.get("minHolderBalanceSol")),
          "refetch_existing": holders.get("refetchAll") is True,
          "balance_batch_size": as_number(holders.get("balanceBatchSize")),
          "unique_holders": holder_summary.get("uniqueHolders"),
          "sent_count": data.get("sentCount"),
        }
    return (
        pretty(resp),
        defaults["mint"],
        defaults["poll_interval"],
        defaults["trigger_sol"],
        defaults["sol_cap"],
        defaults["batch_size"],
        defaults["target_recipients"],
        defaults["recipient_fetch_size"],
        defaults["slippage_bps"],
        defaults["tokens_csv"],
        defaults["limit"],
        defaults["min_token_amount"],
        defaults["min_holder_balance_sol"],
        defaults["balance_batch_size"],
        defaults["refetch_existing"],
        defaults["unique_holders"],
        defaults["sent_count"],
    )

with gr.Blocks(title="Control API Panel") as demo:
    gr.Markdown(
        "### Control API Panel\n"
        "Keep the Node server running (`npm run start:server`). "
        "Set the base URL once, then use the compact controls below.\n"
        "- Start: starts or resumes the loop\n"
        "- Pause: pause the loop (use Start to resume)\n"
        "- Mint loads from env; holder tokens load from holders file"
    )

    with gr.Row(equal_height=True):
        base_url = gr.Textbox(
            label="Base URL",
            value=DEFAULT_BASE_URL,
            placeholder="http://localhost:3001",
            scale=2,
        )
        with gr.Column(scale=1):
            gr.Markdown("Quick")
            with gr.Row():
                health_btn = gr.Button("Health", variant="secondary", scale=1)
                settings_btn = gr.Button("Load Settings", variant="secondary", scale=1)
                save_settings_btn = gr.Button("Save Settings", variant="primary", scale=1)
                status_btn = gr.Button("Status", variant="secondary", scale=1)
            holders_total = gr.Number(
                label="Holders (unique)",
                value=None,
                interactive=False,
            )
            sent_total = gr.Number(
                label="Sent so far",
                value=None,
                interactive=False,
            )

    with gr.Row():
        with gr.Column(scale=3):
            with gr.Tab("Distribution"):
                with gr.Row():
                    mint = gr.Textbox(
                        label="Mint (from env)",
                        placeholder="Public key",
                        scale=2,
                    )
                    poll_interval = gr.Number(
                        label="Poll Interval (ms)", value=None, scale=1
                    )
                with gr.Row():
                    trigger_sol = gr.Number(
                        label="Buyback trigger (SOL)", value=None, scale=1
                    )
                    sol_cap = gr.Number(
                        label="Max buyback spend (SOL)", value=None, scale=1
                    )
                with gr.Row():
                    batch_size = gr.Number(
                        label="Recipients per batch", value=None, scale=1
                    )
                    target_recipients = gr.Number(
                        label="Targets per loop", value=None, scale=1
                    )
                with gr.Row():
                    recipient_fetch_size = gr.Number(
                        label="Recipients fetch size", value=None, scale=1
                    )
                    slippage_bps = gr.Number(label="Slippage BPS", value=None, scale=1)

                with gr.Row(equal_height=True):
                    start_btn = gr.Button("Start", variant="primary", scale=2)
                    pause_btn = gr.Button("Pause", scale=1)

            with gr.Tab("Holder Refresh"):
                tokens_csv = gr.Textbox(
                    label="Tokens (comma-separated, optional)",
                    placeholder="mint1, mint2, ...",
                    lines=2,
                )
                with gr.Row():
                    limit = gr.Number(label="Max holders", value=None, scale=1)
                    min_token_amount = gr.Number(label="Min token amt", value=None, scale=1)
                with gr.Row():
                    min_holder_balance_sol = gr.Number(
                        label="Min holder SOL", value=None, scale=1
                    )
                    balance_batch_size = gr.Number(
                        label="Balance batch size", value=None, scale=1
                    )
                    refetch_existing = gr.Checkbox(
                        label="Force refetch existing", value=False
                    )
                refresh_btn = gr.Button("Refresh Holders", variant="primary")

        with gr.Column(scale=2):
            output = gr.Textbox(label="Response / Logs", lines=18)

    # Wiring
    health_btn.click(check_health, inputs=base_url, outputs=output)
    settings_btn.click(
        load_settings_full,
        inputs=base_url,
        outputs=[
            output,
            mint,
            poll_interval,
            trigger_sol,
            sol_cap,
            batch_size,
            target_recipients,
            recipient_fetch_size,
            slippage_bps,
            tokens_csv,
            limit,
            min_token_amount,
            min_holder_balance_sol,
            balance_batch_size,
            refetch_existing,
            holders_total,
            sent_total,
        ],
    )
    status_btn.click(distribution_status, inputs=base_url, outputs=output)

    start_btn.click(
        start_distribution,
        inputs=[
            base_url,
            mint,
            poll_interval,
            trigger_sol,
            sol_cap,
            batch_size,
            slippage_bps,
        ],
        outputs=output,
    )
    pause_btn.click(pause_distribution, inputs=base_url, outputs=output)

    save_settings_btn.click(
        save_settings,
        inputs=[
            base_url,
            poll_interval,
            trigger_sol,
            sol_cap,
            batch_size,
            target_recipients,
            recipient_fetch_size,
            slippage_bps,
            tokens_csv,
            limit,
            min_token_amount,
            min_holder_balance_sol,
            refetch_existing,
            balance_batch_size,
        ],
        outputs=[
            output,
            mint,
            poll_interval,
            trigger_sol,
            sol_cap,
            batch_size,
            target_recipients,
            recipient_fetch_size,
            slippage_bps,
            tokens_csv,
            limit,
            min_token_amount,
            min_holder_balance_sol,
            balance_batch_size,
            refetch_existing,
            holders_total,
            sent_total,
        ],
    )

    refresh_btn.click(
        refresh_holders,
        inputs=[
            base_url,
            tokens_csv,
            limit,
            min_token_amount,
            min_holder_balance_sol,
            balance_batch_size,
            refetch_existing,
        ],
        outputs=output,
    )

    demo.load(
        load_settings_full,
        inputs=base_url,
        outputs=[
            output,
            mint,
            poll_interval,
            trigger_sol,
            sol_cap,
            batch_size,
            target_recipients,
            recipient_fetch_size,
            slippage_bps,
            tokens_csv,
            limit,
            min_token_amount,
            min_holder_balance_sol,
            balance_batch_size,
            refetch_existing,
            holders_total,
            sent_total,
        ],
    )

if __name__ == "__main__":
    demo.launch()
