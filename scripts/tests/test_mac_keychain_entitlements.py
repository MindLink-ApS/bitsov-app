"""Headless checks for private, signing-bound macOS Keychain entitlements."""
import datetime
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "mac_entitlements", Path(__file__).parents[1] / "mac-keychain-entitlements.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def profile():
    return {"TeamIdentifier": ["ABCDE12345"], "Platform": ["OSX"],
            "ExpirationDate": datetime.datetime(2099, 1, 1),
            "ProvisionsAllDevices": True, "DeveloperCertificates": [b"synthetic certificate"],
            "Entitlements": {"com.apple.application-identifier": "ABCDE12345.org.example.*",
                             "com.apple.developer.team-identifier": "ABCDE12345",
                             "keychain-access-groups": ["ABCDE12345.*"]}}


class Entitlements(unittest.TestCase):
    def test_private_group_uses_the_signing_team_and_bundle(self):
        result = module.entitlements({"com.apple.security.device.camera": True},
                                     "ABCDE12345", "org.example.client", profile(), b"synthetic certificate")
        self.assertEqual(result["keychain-access-groups"], ["ABCDE12345.org.example.client"])
        self.assertEqual(result["com.apple.application-identifier"], "ABCDE12345.org.example.client")
        self.assertEqual(result["com.apple.developer.team-identifier"], "ABCDE12345")
        self.assertTrue(result["com.apple.security.device.camera"])

    def test_missing_team_or_invalid_bundle_is_refused(self):
        for team, bundle in [("", "org.example.client"), ("not set", "org.example.client"),
                             ("ABCDE12345", ""), ("ABCDE12345", "org.example.*")]:
            with self.assertRaises(ValueError):
                module.entitlements({}, team, bundle, profile(), b"synthetic certificate")



class ProfileValidation(unittest.TestCase):
    def test_unauthorized_expired_and_wrong_platform_profiles_are_refused(self):
        mutations = [
            {"ProvisionsAllDevices": False},
            {"ProvisionedDevices": ["synthetic-device"]},
            {"DeveloperCertificates": [b"another certificate"]},
            {"TeamIdentifier": ["ZZZZZ99999"]},
            {"Platform": ["iOS"]},
            {"ExpirationDate": datetime.datetime(2000, 1, 1)},
            {"Entitlements": {"com.apple.developer.team-identifier": "ABCDE12345", "com.apple.application-identifier": "ABCDE12345.org.other.app",
                              "keychain-access-groups": ["ABCDE12345.*"]}},
            {"Entitlements": {"com.apple.developer.team-identifier": "ABCDE12345", "com.apple.application-identifier": "ABCDE12345.org.example.*",
                              "keychain-access-groups": ["ABCDE12345.org.other.app"]}},
        ]
        for changes in mutations:
            candidate = copy.deepcopy(profile())
            candidate.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                module.entitlements({}, "ABCDE12345", "org.example.client", candidate, b"synthetic certificate")


if __name__ == "__main__":
    unittest.main()
