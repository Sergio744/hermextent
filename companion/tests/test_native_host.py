from __future__ import annotations

import json
import os
import queue
import struct
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from companion import native_host as host
from companion import install as installer
from companion import uninstall as uninstaller


class NativeHostUnitTests(unittest.TestCase):
    def test_loopback_url_policy_blocks_remote_and_userinfo_urls(self):
        self.assertTrue(host._is_loopback_url("http://127.0.0.1:8642/v1/chat/completions"))
        self.assertTrue(host._is_loopback_url("http://localhost:8642/health"))
        self.assertFalse(host._is_loopback_url("https://api.example.com/v1"))
        self.assertFalse(host._is_loopback_url("http://127.0.0.1@evil.example:8642/"))
        self.assertFalse(host._is_loopback_url("file:///etc/passwd"))

    def test_dotenv_reads_values_without_shell_evaluation(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temp:
            env_file = Path(temp) / ".env"
            env_file.write_text("# comment\nHERMEXTENT_BRIDGE_TOKEN='abc-123'\nnot valid!=$(id)\n", encoding="utf-8")
            values = host._dotenv_values(env_file)
        self.assertEqual(values, {"HERMEXTENT_BRIDGE_TOKEN": "abc-123"})

    def test_native_host_segments_large_web_requests_below_chrome_frame_limit(self):
        import base64
        import io
        from unittest.mock import patch

        class FakeStdout:
            def __init__(self):
                self.buffer = io.BytesIO()

        original = {"type": "web_request", "id": "req-large", "providerId": "gemini-web", "model": "model-x", "request": {"messages": [{"role": "user", "content": "x" * 1_200_000}]}}
        fake = FakeStdout()
        with patch.object(host.sys, "stdout", fake):
            host._write_outbound(original)
        raw = fake.buffer.getvalue()
        messages = []
        offset = 0
        while offset < len(raw):
            size = struct.unpack("<I", raw[offset:offset + 4])[0]
            offset += 4
            self.assertLess(size, 1_000_000)
            messages.append(json.loads(raw[offset:offset + size]))
            offset += size
        self.assertEqual(messages[0]["type"], "web_request_start")
        self.assertEqual(messages[-1]["type"], "web_request_end")
        encoded = b"".join(base64.b64decode(message["data"]) for message in messages[1:-1])
        self.assertEqual(json.loads(encoded), original)

    def test_redirect_handler_refuses_non_loopback_redirects(self):
        handler = host._LoopbackRedirectHandler()
        request = urllib.request.Request("http://127.0.0.1:8642/v1/chat/completions")
        self.assertIsNotNone(handler.redirect_request(request, None, 302, "Found", {}, "http://127.0.0.1:9000/next"))
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://example.com/steal")

    def test_native_messaging_reader_rejects_oversized_frames(self):
        class FakeStdin:
            def __init__(self, raw: bytes):
                import io
                self.buffer = io.BytesIO(raw)
        raw = struct.pack("<I", host.MAX_NATIVE_FRAME + 1)
        with patch.object(host.sys, "stdin", FakeStdin(raw)):
            with self.assertRaises(ValueError):
                host._read_frame()

    def test_loopback_provider_bridge_streams_chat_and_tool_call_chunks(self):
        self._exercise_bridge(stream=True)

    def test_loopback_provider_bridge_returns_non_streaming_chat_completion(self):
        self._exercise_bridge(stream=False)

    def test_installer_preserves_existing_hermes_profile_data_and_registers_host(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / 'hermes'
            plugin_dir = home / 'plugins' / 'model-providers' / 'hermes-browser'
            plugin_dir.mkdir(parents=True)
            (plugin_dir / 'local-note.txt').write_text('preserve', encoding='utf-8')
            installed = installer.install_provider(home)
            self.assertTrue((installed / '__init__.py').is_file())
            self.assertEqual((installed / 'local-note.txt').read_text(encoding='utf-8'), 'preserve')
            manifest = installer.host_manifest('a' * 32, home)
            self.assertEqual(manifest['allowed_origins'], [f"chrome-extension://{'a' * 32}/"])
            self.assertEqual(manifest['args'][-1], str(home))
            self.assertEqual(manifest['type'], 'stdio')

    def test_cli_install_upgrade_uninstall_cycle_in_isolated_hermes_home(self):
        import subprocess
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home = root / 'hermes'
            config = root / 'config'
            env = {**os.environ, 'XDG_CONFIG_HOME': str(config), 'HERMES_HOME': str(home)}
            extension_id = 'a' * 32
            install_cmd = [sys.executable, str(installer.ROOT / 'companion' / 'install.py'), '--extension-id', extension_id, '--hermes-home', str(home)]
            subprocess.run(install_cmd, check=True, env=env, capture_output=True, text=True)
            manifest = config / 'google-chrome' / 'NativeMessagingHosts' / f'{installer.HOST_NAME}.json'
            first_token = installer.env_token(home / '.env')
            self.assertTrue(manifest.is_file())
            self.assertTrue((home / 'plugins/model-providers/hermes-browser/__init__.py').is_file())
            subprocess.run(install_cmd, check=True, env=env, capture_output=True, text=True)
            self.assertEqual(installer.env_token(home / '.env'), first_token)
            uninstall_cmd = [sys.executable, str(installer.ROOT / 'companion' / 'uninstall.py'), '--browser', 'chrome', '--hermes-home', str(home), '--remove-plugin', '--remove-token']
            subprocess.run(uninstall_cmd, check=True, env=env, capture_output=True, text=True)
            self.assertFalse(manifest.exists())
            self.assertIsNone(installer.env_token(home / '.env'))
            self.assertFalse((home / 'plugins/model-providers/hermes-browser/__init__.py').exists())

    def test_uninstaller_removes_only_its_registration_plugin_and_token(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            xdg = root / 'config'
            manifest = xdg / 'google-chrome' / 'NativeMessagingHosts' / f'{installer.HOST_NAME}.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'name': installer.HOST_NAME}), encoding='utf-8')
            with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(xdg)}):
                self.assertEqual(uninstaller.uninstall_manifest('chrome'), manifest)
                self.assertFalse(manifest.exists())
            home = root / 'hermes'
            installed = installer.install_provider(home)
            (installed / 'user-data.txt').write_text('keep', encoding='utf-8')
            (installed / '__init__.py').write_text('user custom change', encoding='utf-8')
            env = home / '.env'
            env.write_text('KEEP=yes\nHERMEXTENT_BRIDGE_TOKEN=secret\n', encoding='utf-8')
            self.assertTrue(uninstaller.remove_provider(home))
            self.assertEqual((installed / 'user-data.txt').read_text(encoding='utf-8'), 'keep')
            self.assertTrue((installed / '__init__.py').exists())
            self.assertTrue(uninstaller.remove_bridge_token(home))
            self.assertEqual(env.read_text(encoding='utf-8'), 'KEEP=yes\n')

    def test_installer_creates_and_reuses_private_bridge_token(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temp:
            env = Path(temp) / '.hermes' / '.env'
            env.parent.mkdir(parents=True)
            env.write_text('EXISTING=value\n', encoding='utf-8')
            token = installer.install_token(env)
            self.assertGreaterEqual(len(token), 32)
            self.assertEqual(installer.install_token(env), token)
            self.assertIn('EXISTING=value', env.read_text(encoding='utf-8'))

    def test_http_client_disconnect_emits_provider_cancel(self):
        import http.client
        while True:
            try: host._OUTBOUND.get_nowait()
            except queue.Empty: break
        with host._PENDING_LOCK: host._PENDING.clear()
        host._CLIENT_READY.set()
        with patch.dict(os.environ, {"HERMEXTENT_BRIDGE_TOKEN": "cancel-test-secret"}):
            server = ThreadingHTTPServer(("127.0.0.1", 0), host.ProviderRelayHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            result = {}
            def request_worker():
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                connection.request('POST', '/v1/chat/completions', json.dumps({'model': 'gemini-web:test', 'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True}), {'Authorization': 'Bearer cancel-test-secret', 'Content-Type': 'application/json'})
                response = connection.getresponse()
                result['status'] = response.status
                response.close()
                connection.close()
            client = threading.Thread(target=request_worker, daemon=True)
            client.start()
            try:
                outbound = host._OUTBOUND.get(timeout=3)
                request_id = outbound['id']
                with host._PENDING_LOCK: pending = host._PENDING[request_id]
                pending.put({'type': 'provider_delta', 'id': request_id, 'content': 'first'})
                client.join(timeout=3)
                self.assertEqual(result.get('status'), 200)
                cancel = host._OUTBOUND.get(timeout=3)
                self.assertEqual(cancel, {'type': 'provider_cancel', 'id': request_id})
            finally:
                server.shutdown()
                server.server_close()
                client.join(timeout=2)
                host._CLIENT_READY.clear()
                with host._PENDING_LOCK: host._PENDING.clear()

    def test_http_client_disconnect_detection_for_provider_cancellation(self):
        import socket
        server_sock, client_sock = socket.socketpair()
        try:
            handler = object.__new__(host.ProviderRelayHandler)
            handler.connection = server_sock
            self.assertFalse(handler._client_disconnected())
            client_sock.close()
            self.assertTrue(handler._client_disconnected())
        finally:
            server_sock.close()
            client_sock.close()

    def test_api_proxy_forwards_session_headers_and_returns_rotated_values(self):
        import io
        class FakeResponse:
            status = 200
            headers = {'Content-Type': 'text/event-stream', 'X-Hermes-Session-Id': 'session-next', 'X-Hermes-Session-Key': 'memory-scope'}
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read1(self, _size): return b''
        class FakeOpener:
            request = None
            def open(self, request, timeout):
                self.request = request
                return FakeResponse()
        class FakeStdout:
            def __init__(self): self.buffer = io.BytesIO()
        opener = FakeOpener()
        output = FakeStdout()
        with patch('companion.native_host.urllib.request.build_opener', return_value=opener), patch.object(host.sys, 'stdout', output):
            host._proxy_api_request({'id': 'session-test', 'url': 'http://127.0.0.1:8642/v1/chat/completions', 'sessionId': 'session-old', 'sessionKey': 'memory-old', 'apiKey': 'secret', 'body': {'messages': []}})
        self.assertEqual(opener.request.get_header('X-hermes-session-id'), 'session-old')
        self.assertEqual(opener.request.get_header('X-hermes-session-key'), 'memory-old')
        raw = output.buffer.getvalue()
        decoded = []
        offset = 0
        while offset < len(raw):
            size = struct.unpack('<I', raw[offset:offset + 4])[0]
            offset += 4
            decoded.append(json.loads(raw[offset:offset + size]))
            offset += size
        headers = next(message for message in decoded if message['type'] == 'api_headers')
        self.assertEqual(headers['sessionId'], 'session-next')
        self.assertEqual(headers['sessionKey'], 'memory-scope')

    def test_api_cancel_closes_active_hermes_response(self):
        class FakeResponse:
            closed = False
            def close(self):
                self.closed = True
        response = FakeResponse()
        event = threading.Event()
        with host._API_ACTIVE_LOCK:
            host._API_ACTIVE['cancel-test'] = (event, response)
        try:
            self.assertTrue(host._cancel_api_request('cancel-test'))
            self.assertTrue(event.is_set())
            self.assertTrue(response.closed)
            self.assertFalse(host._cancel_api_request('missing'))
        finally:
            with host._API_ACTIVE_LOCK:
                host._API_ACTIVE.pop('cancel-test', None)

    def test_loopback_provider_bridge_rejects_wrong_bearer_token(self):
        with patch.dict(os.environ, {"HERMEXTENT_BRIDGE_TOKEN": "correct-secret-token"}):
            server = ThreadingHTTPServer(("127.0.0.1", 0), host.ProviderRelayHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                body = json.dumps({"model": "gemini-web:test", "messages": [{"role": "user", "content": "hi"}]}).encode()
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    data=body,
                    headers={"Authorization": "Bearer wrong", "Content-Type": "application/json"},
                )
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request, timeout=3)
                self.assertEqual(caught.exception.code, 401)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def _exercise_bridge(self, *, stream: bool):
        while True:
            try:
                host._OUTBOUND.get_nowait()
            except queue.Empty:
                break
        with host._PENDING_LOCK:
            host._PENDING.clear()
        host._CLIENT_READY.set()
        with patch.dict(os.environ, {"HERMEXTENT_BRIDGE_TOKEN": "unit-test-secret"}):
            server = ThreadingHTTPServer(("127.0.0.1", 0), host.ProviderRelayHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            result: dict[str, object] = {}
            request_body = {
                "model": "gemini-web:test-model",
                "messages": [{"role": "user", "content": "hello"}],
                "tools": [{"type": "function", "function": {"name": "read_file", "parameters": {}}}],
                "stream": stream,
            }

            def request_worker():
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    data=json.dumps(request_body).encode(),
                    headers={"Authorization": "Bearer unit-test-secret", "Content-Type": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    result["status"] = response.status
                    result["content_type"] = response.headers.get("Content-Type")
                    result["body"] = response.read().decode()

            client = threading.Thread(target=request_worker, daemon=True)
            client.start()
            try:
                message = host._OUTBOUND.get(timeout=3)
                self.assertEqual(message["type"], "web_request")
                self.assertEqual(message["providerId"], "gemini-web")
                request_id = message["id"]
                with host._PENDING_LOCK:
                    pending = host._PENDING[request_id]
                pending.put({"type": "provider_delta", "id": request_id, "content": "Bonjour"})
                pending.put({"type": "provider_tool_call", "id": request_id, "toolCall": {"id": "call-1", "name": "read_file", "arguments": {"path": "README.md"}}})
                pending.put({"type": "provider_done", "id": request_id, "finishReason": "tool_calls"})
                client.join(timeout=5)
                self.assertFalse(client.is_alive(), "HTTP client should receive the terminal event")
                self.assertEqual(result["status"], 200)
                self.assertEqual(result["content_type"].split(";", 1)[0], "text/event-stream" if stream else "application/json")
                if stream:
                    text = str(result["body"])
                    self.assertIn('"content":"Bonjour"', text)
                    self.assertIn('"name":"read_file"', text)
                    self.assertIn('"finish_reason":"tool_calls"', text)
                    self.assertIn("data: [DONE]\n\n", text)
                else:
                    payload = json.loads(str(result["body"]))
                    self.assertEqual(payload["choices"][0]["message"]["content"], "Bonjour")
                    self.assertEqual(payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"], "read_file")
            finally:
                server.shutdown()
                server.server_close()
                client.join(timeout=2)
                host._CLIENT_READY.clear()
                with host._PENDING_LOCK:
                    host._PENDING.clear()


if __name__ == "__main__":
    unittest.main()
