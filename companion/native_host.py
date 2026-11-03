#!/usr/bin/env python3
"""Hermes Browser's Chrome Native Messaging host and local OpenAI-compatible web-model relay.

The extension talks only through Chrome Native Messaging. This process binds a narrowly-scoped
loopback provider endpoint for Hermes; it is not a general browser-to-localhost HTTP client.
"""
from __future__ import annotations

import argparse
import base64
import codecs
import json
import os
import queue
import re
import select
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HOST_NAME = "com.hermextent.bridge"
BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 8765
MAX_NATIVE_FRAME = 8 * 1024 * 1024
MAX_HTTP_BODY = 2 * 1024 * 1024
MAX_PROXY_BODY = 8 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 300
SUPPORTED_PROVIDERS = frozenset({
    "chatgpt-web", "claude-web", "deepseek-web", "doubao-web", "gemini-web",
    "glm-web", "glm-intl-web", "kimi-web", "qwen-cn-web", "qwen-web", "rakuten-web",
})

_OUTBOUND: queue.Queue[dict[str, Any]] = queue.Queue()
_PENDING: dict[str, queue.Queue[dict[str, Any]]] = {}
_PENDING_LOCK = threading.Lock()
_API_ACTIVE: dict[str, tuple[threading.Event, Any | None]] = {}
_API_ACTIVE_LOCK = threading.Lock()
_WRITER_LOCK = threading.Lock()
_CLIENT_READY = threading.Event()
_RELAY_SERVER_READY = threading.Event()
_STOP = threading.Event()


def _hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".hermes"


def _dotenv_values(path: Path) -> dict[str, str]:
    """Read only simple KEY=value lines; never evaluate shell syntax or interpolate values."""
    values: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
                values[key] = value
    except OSError:
        pass
    return values


def _bridge_token() -> str:
    return os.environ.get("HERMEXTENT_BRIDGE_TOKEN", "") or _dotenv_values(_hermes_home() / ".env").get("HERMEXTENT_BRIDGE_TOKEN", "")


def _write_frame(message: dict[str, Any]) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_NATIVE_FRAME:
        payload = json.dumps({"type": "host_error", "error": "Réponse trop volumineuse pour Native Messaging."}).encode()
    with _WRITER_LOCK:
        sys.stdout.buffer.write(struct.pack("<I", len(payload)))
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()


def _write_outbound(message: dict[str, Any]) -> None:
    """Respect Chrome's 1 MiB host-to-extension Native Messaging frame limit."""
    if message.get("type") != "web_request":
        _write_frame(message)
        return
    serialized = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(serialized) <= 600_000:
        _write_frame(message)
        return
    request_id = message.get("id")
    chunk_size = 360_000
    chunks = [serialized[i:i + chunk_size] for i in range(0, len(serialized), chunk_size)]
    _write_frame({"type": "web_request_start", "id": request_id, "providerId": message.get("providerId"), "model": message.get("model"), "totalBytes": len(serialized), "totalChunks": len(chunks)})
    for index, chunk in enumerate(chunks):
        _write_frame({"type": "web_request_chunk", "id": request_id, "index": index, "data": base64.b64encode(chunk).decode("ascii")})
    _write_frame({"type": "web_request_end", "id": request_id})


def _read_exact(size: int, *, allow_eof: bool = False) -> bytes | None:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            if allow_eof and not chunks:
                return None
            raise EOFError("Native Messaging frame was truncated")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_frame() -> dict[str, Any] | None:
    header = _read_exact(4, allow_eof=True)
    if header is None:
        return None
    (size,) = struct.unpack("<I", header)
    if size <= 0 or size > MAX_NATIVE_FRAME:
        raise ValueError(f"Invalid Native Messaging frame size: {size}")
    payload = _read_exact(size)
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Native Messaging messages must be JSON objects")
    return value


def _is_loopback_url(raw_url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return False
        return parsed.hostname.lower() in {"127.0.0.1", "localhost", "::1"}
    except (ValueError, TypeError):
        return False


def _send_api_error(request_id: str, message: str, status: int | None = None) -> None:
    _write_frame({"type": "api_error", "id": request_id, "error": message, "status": status})


def _cancel_api_request(request_id: str) -> bool:
    with _API_ACTIVE_LOCK:
        active = _API_ACTIVE.get(request_id)
    if active is None:
        return False
    cancelled, response = active
    cancelled.set()
    if response is not None:
        try:
            response.close()
        except OSError:
            pass
    return True


class _LoopbackRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        if not _is_loopback_url(new_url):
            raise urllib.error.HTTPError(new_url, 403, "Non-loopback redirect blocked", headers, fp)
        return super().redirect_request(request, fp, code, msg, headers, new_url)


def _proxy_api_request(message: dict[str, Any]) -> None:
    request_id = str(message.get("id", ""))
    url = message.get("url")
    method = message.get("method", "POST")
    body = message.get("body")
    if not request_id or not isinstance(url, str) or not _is_loopback_url(url):
        _send_api_error(request_id, "URL Hermes refusée : seule une API explicitement configurée sur loopback est permise.")
        return
    if method not in {"GET", "POST", "PATCH", "DELETE"}:
        _send_api_error(request_id, "Méthode HTTP non autorisée.")
        return
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.port is None or not (1 <= parsed.port <= 65535):
            raise ValueError("port manquant")
    except ValueError:
        _send_api_error(request_id, "Adresse de l’API Hermes invalide.")
        return
    payload: bytes | None = None
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_PROXY_BODY:
            _send_api_error(request_id, "Requête trop volumineuse.")
            return
    headers = {"Accept": "text/event-stream, application/json", "X-Hermes-Client": "hermextent"}
    api_key = message.get("apiKey")
    if isinstance(api_key, str) and api_key:
        headers["Authorization"] = f"Bearer {api_key[:4096]}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
    session_id = message.get("sessionId")
    if isinstance(session_id, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", session_id):
        headers["X-Hermes-Session-Id"] = session_id
    session_key = message.get("sessionKey")
    if isinstance(session_key, str) and 0 < len(session_key) <= 256 and not any(char in session_key for char in "\r\n\x00"):
        headers["X-Hermes-Session-Key"] = session_key
    request = urllib.request.Request(url, data=payload, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _LoopbackRedirectHandler())
    cancelled = threading.Event()
    with _API_ACTIVE_LOCK:
        if request_id in _API_ACTIVE:
            _send_api_error(request_id, "Duplicate request id")
            return
        _API_ACTIVE[request_id] = (cancelled, None)
    try:
        with opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            with _API_ACTIVE_LOCK:
                _API_ACTIVE[request_id] = (cancelled, response)
            _write_frame({"type": "api_headers", "id": request_id, "status": response.status, "contentType": response.headers.get("Content-Type", "application/octet-stream"), "sessionId": response.headers.get("X-Hermes-Session-Id", ""), "sessionKey": response.headers.get("X-Hermes-Session-Key", "")})
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            while not _STOP.is_set() and not cancelled.is_set():
                chunk = response.read1(4096)
                if not chunk:
                    break
                text = decoder.decode(chunk)
                if text and not cancelled.is_set():
                    _write_frame({"type": "api_chunk", "id": request_id, "chunk": text})
            if cancelled.is_set():
                _write_frame({"type": "api_result", "id": request_id, "cancelled": True})
            else:
                tail = decoder.decode(b"", final=True)
                if tail:
                    _write_frame({"type": "api_chunk", "id": request_id, "chunk": tail})
                _write_frame({"type": "api_result", "id": request_id, "status": response.status})
    except urllib.error.HTTPError as exc:
        if cancelled.is_set():
            _write_frame({"type": "api_result", "id": request_id, "cancelled": True})
        else:
            detail = exc.read(4096).decode("utf-8", "replace")
            _send_api_error(request_id, detail or f"Hermes a répondu HTTP {exc.code}.", exc.code)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        if cancelled.is_set():
            _write_frame({"type": "api_result", "id": request_id, "cancelled": True})
        else:
            _send_api_error(request_id, f"Connexion à Hermes impossible : {type(exc).__name__}.")
    finally:
        with _API_ACTIVE_LOCK:
            _API_ACTIVE.pop(request_id, None)


class ProviderRelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HermesBrowserRelay/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[hermes-browser-relay] " + fmt % args, file=sys.stderr)

    def _json_error(self, status: int, error: str) -> None:
        body = json.dumps({"error": {"message": error, "type": "hermes_browser_bridge_error"}}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            body = json.dumps({"ok": True, "browserConnected": _CLIENT_READY.is_set(), "providerCount": len(SUPPORTED_PROVIDERS)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        self._json_error(404, "Not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/chat/completions":
            self._json_error(404, "Not found")
            return
        if not self.client_address or self.client_address[0] not in {"127.0.0.1", "::1"}:
            self._json_error(403, "Loopback clients only")
            return
        host = self.headers.get("Host", "").split(":", 1)[0].strip("[]").lower()
        if host not in {"127.0.0.1", "localhost"}:
            self._json_error(403, "Host header rejected")
            return
        token = _bridge_token()
        if not token:
            self._json_error(503, "HERMEXTENT_BRIDGE_TOKEN is not configured in Hermes .env")
            return
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or not _constant_time_equal(auth[7:], token):
            self._json_error(401, "Invalid bridge credentials")
            return
        if not _CLIENT_READY.wait(timeout=5):
            self._json_error(503, "Ouvre l’extension Hermes Browser pour connecter un navigateur.")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json_error(400, "Invalid Content-Length")
            return
        if length <= 0 or length > MAX_HTTP_BODY:
            self._json_error(413, "Request body too large or empty")
            return
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("JSON body must be an object")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            self._json_error(400, "Invalid JSON request")
            return
        model = body.get("model")
        if not isinstance(model, str) or ":" not in model:
            self._json_error(400, "Model must be provider-id:model-id, e.g. gemini-web:gemini-3-flash")
            return
        provider_id, model_id = model.split(":", 1)
        if provider_id not in SUPPORTED_PROVIDERS or not model_id or len(model_id) > 160:
            self._json_error(400, "Unsupported provider/model")
            return
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages or len(messages) > 1000:
            self._json_error(400, "Invalid messages list")
            return
        if not all(isinstance(item, dict) for item in messages):
            self._json_error(400, "Invalid message entry")
            return
        request_id = uuid.uuid4().hex
        events: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=2048)
        with _PENDING_LOCK:
            if len(_PENDING) >= 8:
                self._json_error(429, "Too many concurrent browser model requests")
                return
            _PENDING[request_id] = events
        _OUTBOUND.put({"type": "web_request", "id": request_id, "providerId": provider_id, "model": model_id, "request": body})
        self._relay_events(request_id, events, body)

    def _client_disconnected(self) -> bool:
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable and self.connection.recv(1, socket.MSG_PEEK) == b"")
        except (OSError, ValueError):
            return True

    def _relay_events(self, request_id: str, events: queue.Queue[dict[str, Any]], body: dict[str, Any]) -> None:
        streaming = bool(body.get("stream", False))
        gathered_text = ""
        gathered_tools: list[dict[str, Any]] = []
        started = False
        deadline = time.monotonic() + REQUEST_TIMEOUT_SECONDS
        try:
            while True:
                if self._client_disconnected():
                    _OUTBOUND.put({"type": "provider_cancel", "id": request_id})
                    return
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    if not started:
                        self._json_error(504, "Browser provider timed out")
                    else:
                        self._sse_data({"error": {"message": "Browser provider timed out"}})
                        self.wfile.write(b"data: [DONE]\n\n")
                        self.wfile.flush()
                    return
                try:
                    event = events.get(timeout=min(0.25, remaining))
                except queue.Empty:
                    continue
                kind = event.get("type")
                if kind == "provider_error":
                    message = str(event.get("error", "Provider failed"))[:2000]
                    if not started:
                        self._json_error(502, message)
                    else:
                        self._sse_data({"error": {"message": message, "type": "provider_error"}})
                        self.wfile.write(b"data: [DONE]\n\n")
                        self.wfile.flush()
                    return
                if not streaming and kind in {"provider_delta", "provider_tool_call"}:
                    if kind == "provider_delta":
                        gathered_text += str(event.get("content", ""))
                    else:
                        call = event.get("toolCall")
                        if isinstance(call, dict):
                            gathered_tools.append(call)
                    continue
                if streaming and not started:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                    self.send_header("Cache-Control", "no-cache, no-transform")
                    self.send_header("Connection", "close")
                    self.close_connection = True
                    self.send_header("X-Accel-Buffering", "no")
                    self.end_headers()
                    started = True
                    self._sse_data({"id": f"chatcmpl-{request_id}", "object": "chat.completion.chunk", "created": int(time.time()), "model": body.get("model"), "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
                if kind == "provider_delta":
                    text = str(event.get("content", ""))
                    self._sse_data({"id": f"chatcmpl-{request_id}", "object": "chat.completion.chunk", "created": int(time.time()), "model": body.get("model"), "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]})
                elif kind == "provider_tool_call":
                    call = event.get("toolCall")
                    if isinstance(call, dict):
                        gathered_tools.append(call)
                        index = len(gathered_tools) - 1
                        self._sse_data({"id": f"chatcmpl-{request_id}", "object": "chat.completion.chunk", "created": int(time.time()), "model": body.get("model"), "choices": [{"index": 0, "delta": {"tool_calls": [{"index": index, "id": call.get("id", uuid.uuid4().hex), "type": "function", "function": {"name": call.get("name", ""), "arguments": json.dumps(call.get("arguments", {}), ensure_ascii=False)}}]}, "finish_reason": None}]})
                elif kind == "provider_done":
                    finish_reason = "tool_calls" if gathered_tools else str(event.get("finishReason", "stop"))
                    if streaming:
                        self._sse_data({"id": f"chatcmpl-{request_id}", "object": "chat.completion.chunk", "created": int(time.time()), "model": body.get("model"), "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]})
                        self.wfile.write(b"data: [DONE]\n\n")
                        self.wfile.flush()
                    else:
                        tool_calls = [{"id": call.get("id", uuid.uuid4().hex), "type": "function", "function": {"name": call.get("name", ""), "arguments": json.dumps(call.get("arguments", {}), ensure_ascii=False)}} for call in gathered_tools]
                        result = {"id": f"chatcmpl-{request_id}", "object": "chat.completion", "created": int(time.time()), "model": body.get("model"), "choices": [{"index": 0, "message": {"role": "assistant", "content": gathered_text or None, **({"tool_calls": tool_calls} if tool_calls else {})}, "finish_reason": finish_reason}], "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}
                        payload = json.dumps(result, ensure_ascii=False).encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Content-Length", str(len(payload)))
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        self.wfile.write(payload)
                    return
                if streaming:
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            _OUTBOUND.put({"type": "provider_cancel", "id": request_id})
        finally:
            with _PENDING_LOCK:
                _PENDING.pop(request_id, None)

    def _sse_data(self, value: dict[str, Any]) -> None:
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.wfile.write(b"data: " + data + b"\n\n")


def _constant_time_equal(left: str, right: str) -> bool:
    import hmac
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def _reader_loop() -> None:
    try:
        while not _STOP.is_set():
            message = _read_frame()
            if message is None:
                break
            kind = message.get("type")
            if kind == "hello":
                _CLIENT_READY.set()
                _OUTBOUND.put({"type": "host_ready", "protocol": 1, "providerRelay": _RELAY_SERVER_READY.is_set() and bool(_bridge_token())})
            elif kind == "provider_delta" or kind == "provider_tool_call" or kind == "provider_done" or kind == "provider_error":
                request_id = message.get("id")
                if isinstance(request_id, str):
                    with _PENDING_LOCK:
                        target = _PENDING.get(request_id)
                    if target is not None:
                        try:
                            target.put_nowait(message)
                        except queue.Full:
                            try:
                                target.get_nowait()
                            except queue.Empty:
                                pass
                            try:
                                target.put_nowait({"type": "provider_error", "id": request_id, "error": "Provider stream buffer exceeded."})
                            except queue.Full:
                                pass
            elif kind == "api_request":
                threading.Thread(target=_proxy_api_request, args=(message,), daemon=True).start()
            elif kind == "api_cancel":
                request_id = message.get("id")
                if isinstance(request_id, str):
                    _cancel_api_request(request_id)
            elif kind == "ping":
                _OUTBOUND.put({"type": "pong", "id": message.get("id")})
            else:
                _OUTBOUND.put({"type": "host_error", "error": "Unsupported native message."})
    except (EOFError, BrokenPipeError):
        pass
    except Exception as exc:  # malformed native input should not take down the extension worker silently
        print(f"[hermes-browser-host] Native message read failed: {type(exc).__name__}: {exc}", file=sys.stderr)
    finally:
        _STOP.set()
        _CLIENT_READY.clear()
        with _API_ACTIVE_LOCK:
            active_api = list(_API_ACTIVE.values())
        for cancelled, response in active_api:
            cancelled.set()
            if response is not None:
                try:
                    response.close()
                except OSError:
                    pass
        with _PENDING_LOCK:
            pending = list(_PENDING.values())
        for events in pending:
            try:
                events.put_nowait({"type": "provider_error", "error": "Extension native connection closed."})
            except queue.Full:
                pass


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--hermes-home")
    options, _unknown = parser.parse_known_args(sys.argv[1:])
    if options.hermes_home:
        os.environ["HERMES_HOME"] = str(Path(options.hermes_home).expanduser().resolve())
    if os.name == "nt":
        # Keep stdin/stdout in binary mode for Chrome's length-prefixed protocol.
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        server = ThreadingHTTPServer((BRIDGE_HOST, BRIDGE_PORT), ProviderRelayHandler)
        server.daemon_threads = True
        server.timeout = 0.5
        _RELAY_SERVER_READY.set()
        threading.Thread(target=server.serve_forever, name="provider-relay", daemon=True).start()
    except OSError as exc:
        print(f"[hermes-browser-host] Could not bind provider relay: {type(exc).__name__}: {exc}", file=sys.stderr)
        server = None
    reader = threading.Thread(target=_reader_loop, name="native-reader", daemon=True)
    reader.start()
    try:
        while not _STOP.is_set():
            try:
                message = _OUTBOUND.get(timeout=0.25)
            except queue.Empty:
                continue
            _write_outbound(message)
    except (BrokenPipeError, OSError):
        _STOP.set()
    finally:
        if server:
            server.shutdown()
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
