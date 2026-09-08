import contextlib
import io
import unittest
import time
from unittest.mock import MagicMock, patch
import httpx
from apicostx import ApiClient, ApiError
from apicostx import cli


class SafetyTests(unittest.TestCase):
    def test_wait_deadline_bounds_retry_after(self):
        start = time.monotonic()
        with ApiClient(api_key="synthetic", transport=httpx.MockTransport(lambda request: httpx.Response(503, headers={"Retry-After": "60"}))) as client:
            with self.assertRaises(TimeoutError):
                client.wait_for_run("r", timeout=0.03)
        self.assertLess(time.monotonic() - start, 0.5)

    def test_custom_client_cannot_follow_redirect(self):
        calls = []
        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(307, headers={"Location": "https://other.test/leak"})
        with httpx.Client(base_url="https://api.test", follow_redirects=True, transport=httpx.MockTransport(handler)) as transport:
            with self.assertRaises(ApiError):
                ApiClient(api_key="synthetic", client=transport).get_preset("p")
        self.assertEqual(len(calls), 1)

    def test_pagination(self):
        urls = []
        def handler(request):
            urls.append(request.url)
            return httpx.Response(200, json={})
        with ApiClient(api_key="synthetic", transport=httpx.MockTransport(handler)) as client:
            client.get_generated_results("r", source_doc_id="a&b", limit=100, offset=50)
            client.get_evaluation_results("r", source_doc_id="a&b", offset=25)
        self.assertEqual(urls[0].params["source_doc_id"], "a&b")
        self.assertEqual(urls[0].params["offset"], "50")
        self.assertEqual(urls[1].params["offset"], "25")

    def test_wait_exit_codes_and_run_id(self):
        for status in ["completed", "failed", "cancelled", "completed_with_errors"]:
            with self.subTest(status=status):
                client = MagicMock()
                client.__enter__.return_value = client
                client.execute_preset.return_value = {"run_id": "r"}
                client.wait_for_run.return_value = {"status": status}
                err = io.StringIO()
                with patch.object(cli, "_client", return_value=client), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                    code = cli.main(["run", "p", "--wait"])
                self.assertEqual(code, 0 if status == "completed" else 1)
                self.assertIn("run_id=r", err.getvalue())

    def test_network_error_has_clean_nonzero_exit(self):
        with patch.object(cli, "_client", side_effect=httpx.ConnectError("test unavailable")), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["health"]), 2)
