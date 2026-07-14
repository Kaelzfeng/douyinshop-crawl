import os
import unittest
from unittest.mock import patch

from sign import ABogusSigner, SignerError, _build_query, generate_verify_fp
from tools.verify_h5_api import CaptureError, extract_capture_request


class SignerHelpersTest(unittest.TestCase):
    def test_build_query_preserves_existing_query_and_parameter_order(self):
        query = _build_query(
            "https://example.test/path?first=1",
            [("word", "two words"), ("item", 2)],
        )
        self.assertEqual(query, "first=1&word=two+words&item=2")

    def test_raw_query_is_accepted(self):
        self.assertEqual(_build_query("first=1&second=2", None), "first=1&second=2")

    def test_verify_fp_must_be_supplied(self):
        with patch.dict(os.environ, {"DOUYIN_VERIFY_FP": ""}):
            with self.assertRaises(SignerError):
                generate_verify_fp()
        self.assertEqual(generate_verify_fp({"verifyFp": "verify_test_session"}), "verify_test_session")

    def test_capture_extraction_changes_only_a_bogus(self):
        capture = {
            "transformations": [
                {
                    "identity": (
                        "POST https://haohuo.jinritemai.com"
                        "/aweme/v2/shop/promotion/pack/h5/"
                    ),
                    "unsignedUrl": (
                        "/aweme/v2/shop/promotion/pack/h5/"
                        "?first=1&verifyFp=verify_test&blank="
                    ),
                    "signedUrl": (
                        "https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/"
                        "?first=1&verifyFp=verify_test&a_bogus=old%2Fvalue&blank="
                    ),
                    "body": "promotion_ids=123&item_id=0",
                }
            ]
        }
        base_url, query, body = extract_capture_request(capture)
        self.assertEqual(
            base_url,
            "https://haohuo.jinritemai.com/aweme/v2/shop/promotion/pack/h5/",
        )
        self.assertEqual(query, "first=1&verifyFp=verify_test&blank=")
        self.assertEqual(body, "promotion_ids=123&item_id=0")

    def test_capture_extraction_requires_a_body(self):
        with self.assertRaises(CaptureError):
            extract_capture_request({"transformations": []})


class PersistentSignerIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signer = ABogusSigner()

    @classmethod
    def tearDownClass(cls):
        cls.signer.close()

    def test_ready_metadata_matches_checked_in_vm(self):
        self.assertEqual(self.signer.metadata["initEntryPc"], 7959)
        self.assertEqual(self.signer.metadata["signerEntryPc"], 6217)
        self.assertEqual(self.signer.metadata["signerArity"], 2)

    def test_repeated_signatures_are_well_formed_and_fresh(self):
        query = "is_h5=1&verifyFp=verify_repeatability_test"
        body = "promotion_ids=3713354677006499920&item_id=0"
        signatures = [self.signer.sign(query, body) for _ in range(12)]
        self.assertEqual({len(value) for value in signatures}, {44})
        self.assertEqual(len(set(signatures)), len(signatures))
        self.assertIsNone(self.signer._process.poll())

    def test_existing_a_bogus_is_rejected_without_stopping_service(self):
        with self.assertRaisesRegex(SignerError, "already contains a_bogus"):
            self.signer.sign("first=1&a_bogus=already-signed", "")
        self.assertEqual(len(self.signer.sign("first=1", "")), 44)

    def test_inputs_must_be_strings(self):
        with self.assertRaises(TypeError):
            self.signer.sign("first=1", None)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
