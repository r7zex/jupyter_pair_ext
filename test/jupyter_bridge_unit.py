from __future__ import annotations

import base64
import builtins
import importlib.util
import math
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch
from queue import Empty


sys.dont_write_bytecode = True
BRIDGE = pathlib.Path(__file__).resolve().parents[1] / "media" / "jupyter_kernel_bridge.py"
SPEC = importlib.util.spec_from_file_location("pair_notebook_jupyter_bridge", BRIDGE)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def message(parent: str, message_type: str = "kernel_info_reply") -> dict[str, object]:
    return {
        "parent_header": {"msg_id": parent},
        "header": {"msg_type": message_type},
        "content": {"status": "ok"},
    }


class QueueGetter:
    def __init__(self, messages: list[dict[str, object]]) -> None:
        self.messages = list(messages)

    def __call__(self, timeout: float) -> dict[str, object]:
        del timeout
        if not self.messages:
            raise Empty
        return self.messages.pop(0)


class CorrelationTests(unittest.TestCase):
    def test_skips_unrelated_shell_replies(self) -> None:
        getter = QueueGetter([
            message("old-ready-probe"),
            message("wanted", "complete_reply"),
            message("wanted"),
        ])
        result = MODULE.wait_for_parent_message(getter, "wanted", 0.2, "kernel_info_reply")
        self.assertEqual(result["parent_header"]["msg_id"], "wanted")
        self.assertEqual(result["header"]["msg_type"], "kernel_info_reply")

    def test_timeout_names_the_missing_parent_and_skipped_reply(self) -> None:
        getter = QueueGetter([message("foreign")])
        with self.assertRaisesRegex(TimeoutError, "wanted.*foreign"):
            MODULE.wait_for_parent_message(getter, "wanted", 0.01, "kernel_info_reply")

    def test_serialization_bounds_large_kernel_output(self) -> None:
        value = MODULE.serializable({
            "text": "x" * (MODULE.MAX_SERIALIZED_CHARACTERS + 1),
            "many": list(range(1000)),
        })
        encoded = MODULE.json.dumps(value).encode("utf-8")
        self.assertLess(len(encoded), MODULE.MAX_EMIT_BYTES)
        self.assertIn("truncated", value["text"].lower())
        self.assertTrue("many" not in value or len(value["many"]) <= MODULE.MAX_COLLECTION_ITEMS + 1)

    def test_serialization_converts_non_finite_numbers_to_valid_json(self) -> None:
        value = MODULE.serializable({"nan": math.nan, "positive": math.inf, "negative": -math.inf})
        encoded = MODULE.json.dumps(value, allow_nan=False)
        self.assertIn('"nan": "nan"', encoded)
        self.assertIn('"positive": "inf"', encoded)

    def test_serialization_never_publishes_a_truncated_base64_image(self) -> None:
        small_image = base64.b64encode(b"valid image bytes").decode("ascii")
        preserved = MODULE.serializable({"data": {"image/png": small_image}})
        self.assertEqual(preserved["data"]["image/png"], small_image)

        oversized = base64.b64encode(b"x" * MODULE.MAX_SERIALIZED_CHARACTERS).decode("ascii")
        bounded = MODULE.serializable({"data": {"image/png": oversized}})
        self.assertNotIn("image/png", bounded["data"])
        self.assertIn("omitted", bounded["data"]["text/plain"].lower())

        invalid = MODULE.serializable({"data": {"image/png": "not-valid-base64"}})
        self.assertNotIn("image/png", invalid["data"])
        self.assertIn("invalid", invalid["data"]["text/plain"].lower())

    def test_kernel_buffers_are_bounded_before_base64_encoding(self) -> None:
        oversized = b"x" * (MODULE.MAX_KERNEL_BUFFER_BYTES + 1)
        self.assertEqual(MODULE.serialize_buffers([oversized]), [])

        buffers = [b"a"] * (MODULE.MAX_KERNEL_BUFFERS + 10)
        encoded = MODULE.serialize_buffers(buffers)
        self.assertEqual(len(encoded), MODULE.MAX_KERNEL_BUFFERS)
        self.assertTrue(all(base64.b64decode(item) == b"a" for item in encoded))

    def test_execution_code_decoder_rejects_malformed_and_oversized_input(self) -> None:
        self.assertEqual(MODULE.decode_code(base64.b64encode("print('ok')".encode()).decode()), "print('ok')")
        with self.assertRaises(ValueError):
            MODULE.decode_code("not-base64!")
        with self.assertRaises(ValueError):
            MODULE.decode_code("A" * ((MODULE.MAX_CODE_BYTES * 4 // 3) + 5))

    def test_kernel_death_finishes_pending_execution_and_reports_fatal(self) -> None:
        manager = Mock()
        manager.is_alive.return_value = False
        emitted: list[dict[str, object]] = []
        MODULE.PENDING["jupyter-id"] = {"requestId": "training"}
        MODULE.AUXILIARY["completion-id"] = ("completion", "completionResult")
        MODULE.STOP.clear()
        try:
            with patch.object(MODULE.STOP, "wait", return_value=False), patch.object(MODULE, "emit", side_effect=emitted.append):
                MODULE.monitor_kernel(manager)
            self.assertTrue(MODULE.STOP.is_set())
            self.assertFalse(MODULE.PENDING)
            self.assertFalse(MODULE.AUXILIARY)
            self.assertEqual(emitted[0]["type"], "complete")
            self.assertEqual(emitted[0]["requestId"], "training")
            self.assertEqual(emitted[0]["content"]["ename"], "KernelDied")
            self.assertEqual(emitted[1]["type"], "fatal")
        finally:
            MODULE.STOP.clear()
            MODULE.PENDING.clear()
            MODULE.AUXILIARY.clear()

    def test_missing_ipykernel_reports_install_command_without_startup_wait(self) -> None:
        emitted: list[dict[str, object]] = []
        original_import = builtins.__import__

        def import_without_ipykernel(name: str, *args: object, **kwargs: object) -> object:
            if name == "ipykernel":
                raise ModuleNotFoundError("No module named 'ipykernel'")
            return original_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=import_without_ipykernel), patch.object(MODULE, "emit", side_effect=emitted.append):
            self.assertEqual(MODULE.main(), 2)
        self.assertEqual(emitted[0]["type"], "fatal")
        self.assertIn("jupyter_client and ipykernel", emitted[0]["message"])
        self.assertIn("-m pip install jupyter_client ipykernel", emitted[0]["installCommand"])


if __name__ == "__main__":
    unittest.main()
