#!/usr/bin/env python3
"""Add the signing team's private application identity to macOS entitlements."""
import datetime
import plistlib
import re
import sys
from pathlib import Path


def authorized(value, pattern):
    return isinstance(pattern, str) and (value == pattern or
        (pattern.endswith(".*") and value.startswith(pattern[:-1])))


def entitlements(base, team, bundle, profile, certificate):
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise ValueError("a valid signing team is required")
    if not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", bundle):
        raise ValueError("a valid bundle identifier is required")
    identity = f"{team}.{bundle}"
    expiration = profile.get("ExpirationDate")
    if not isinstance(expiration, datetime.datetime) or expiration.replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc):
        raise ValueError("the provisioning profile is missing or expired")
    if profile.get("ProvisionsAllDevices") is not True or profile.get("ProvisionedDevices"):
        raise ValueError("an unrestricted Developer ID distribution profile is required")
    if not certificate or certificate not in profile.get("DeveloperCertificates", []):
        raise ValueError("the provisioning profile does not authorize the signing certificate")
    allowed = profile.get("Entitlements", {})
    if allowed.get("get-task-allow", False):
        raise ValueError("a development provisioning profile is not allowed")
    if team not in profile.get("TeamIdentifier", []) or "OSX" not in profile.get("Platform", []):
        raise ValueError("the provisioning profile must belong to the macOS signing team")
    if not authorized(identity, allowed.get("com.apple.application-identifier")):
        raise ValueError("the provisioning profile does not authorize this application")
    if allowed.get("com.apple.developer.team-identifier") != team:
        raise ValueError("the provisioning profile team entitlement does not match")
    if not any(authorized(identity, group) for group in allowed.get("keychain-access-groups", [])):
        raise ValueError("the provisioning profile does not authorize the private Keychain group")
    result = dict(base)
    result["com.apple.application-identifier"] = identity
    result["com.apple.developer.team-identifier"] = team
    result["keychain-access-groups"] = [identity]
    return result


if __name__ == "__main__":
    source, destination, team, bundle, profile_path, certificate_path = sys.argv[1:]
    base = plistlib.loads(Path(source).read_bytes())
    Path(destination).write_bytes(plistlib.dumps(entitlements(base, team, bundle, plistlib.loads(Path(profile_path).read_bytes()), Path(certificate_path).read_bytes())))
