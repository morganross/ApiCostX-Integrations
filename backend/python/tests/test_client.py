import json
import unittest

import httpx

from apicostx import ApiClient, AuthenticationError, NotFoundError


class ClientTests(unittest.TestCase):
    def test_authenticated_request_uses_user_api_key(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.path
            seen["key"] = request.headers.get("X-ACM2-API-Key")
            return httpx.Response(200, json={"items": []})

        with ApiClient(api_key="acm2.ak_test.secret", transport=httpx.MockTransport(handler)) as client:
            self.assertEqual(client.list_presets(), {"items": []})
        self.assertEqual(seen, {"path": "/api/presets", "key": "acm2.ak_test.secret"})

    def test_execute_sends_only_supported_input_override(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.url.path, "/api/presets/p1/execute")
            self.assertEqual(json.loads(request.content), {
                "input_content_ids": ["d1", "d2"],
                "idempotency_key": "retry-001",
                "overrides": {"iterations": 2},
            })
            return httpx.Response(200, json={"status": "started", "run_id": "r1"})

        with ApiClient(api_key="acm2.ak_test.secret", transport=httpx.MockTransport(handler)) as client:
            self.assertEqual(
                client.execute_preset(
                    "p1",
                    input_content_ids=["d1", "d2"],
                    idempotency_key="retry-001",
                    overrides={"iterations": 2},
                )["run_id"],
                "r1",
            )

    def test_error_mapping(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"detail": "Preset not found"})

        with self.assertRaises(NotFoundError):
            with ApiClient(api_key="acm2.ak_test.secret", transport=httpx.MockTransport(handler)) as client:
                client.get_preset("missing")

    def test_authenticated_call_requires_key(self):
        with self.assertRaises(AuthenticationError):
            with ApiClient(transport=httpx.MockTransport(lambda _: httpx.Response(200))) as client:
                client.list_presets()

    def test_safe_get_retries_transient_failure(self):
        attempts = {"count": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            attempts["count"] += 1
            if attempts["count"] == 1:
                return httpx.Response(503, json={"detail": "busy"})
            return httpx.Response(200, json={"items": []})

        with ApiClient(
            api_key="acm2.ak_test.secret",
            max_retries=1,
            retry_backoff=0,
            transport=httpx.MockTransport(handler),
        ) as client:
            self.assertEqual(client.list_presets(), {"items": []})
        self.assertEqual(attempts["count"], 2)

    def test_wait_polls_live_summary_then_fetches_final_run(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if request.url.path.endswith("/live-summary"):
                status = "running" if calls.count(request.url.path) == 1 else "completed"
                return httpx.Response(200, json={"id": "r1", "status": status})
            return httpx.Response(200, json={"id": "r1", "status": "completed", "result": "final"})

        with ApiClient(
            api_key="acm2.ak_test.secret",
            retry_backoff=0,
            transport=httpx.MockTransport(handler),
        ) as client:
            result = client.wait_for_run("r1", timeout=2, poll_interval=0)
        self.assertEqual(result["result"], "final")
        self.assertEqual(calls[-1], "/api/runs/r1")


if __name__ == "__main__":
    unittest.main()
