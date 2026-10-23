#!/bin/sh
set -eu
mkdir -p .cache/u5/PhoneShellPreview.app
cp docs/ui/u5-phone-shell/harness/Info.plist .cache/u5/PhoneShellPreview.app/
xcrun --sdk iphonesimulator swiftc -parse-as-library -target arm64-apple-ios17.0-simulator -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -module-cache-path .cache/u5/swift-cache docs/ui/u5-phone-shell/harness/Preview.swift -o .cache/u5/PhoneShellPreview.app/PhoneShellPreview
cp docs/ui/u5-phone-shell/harness/project.yml .cache/u5/
mkdir -p .cache/u5/Tests
cp docs/ui/u5-phone-shell/harness/PhoneShellEvidence.swift .cache/u5/Tests/
xcodegen generate --spec .cache/u5/project.yml
xcodebuild build-for-testing -project .cache/u5/PhoneShellEvidence.xcodeproj -scheme PhoneShellEvidence -destination "platform=iOS Simulator,id=${DEVICE:-71E314A6-5C92-4507-994B-7F7E67DE9495}" -derivedDataPath .cache/u5/build CODE_SIGNING_ALLOWED=NO
