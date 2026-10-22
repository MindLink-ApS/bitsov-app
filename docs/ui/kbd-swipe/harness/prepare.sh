#!/bin/sh
# Run from the repository root after npm ci. Requires Xcode and xcodegen.
set -eu
mkdir -p .cache/kbd/Tests .cache/kbd/KeyboardPreview.app
cp docs/ui/kbd-swipe/harness/Preview.swift docs/ui/kbd-swipe/harness/preview.html docs/ui/kbd-swipe/harness/preview.tsx docs/ui/kbd-swipe/harness/project.yml docs/ui/kbd-swipe/harness/capture.py .cache/kbd/
cp docs/ui/kbd-swipe/harness/KeyboardEvidence.swift .cache/kbd/Tests/
cp docs/ui/kbd-swipe/harness/Info.plist .cache/kbd/KeyboardPreview.app/
xcrun --sdk iphonesimulator swiftc -parse-as-library -target arm64-apple-ios17.0-simulator -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -module-cache-path .cache/kbd/swift-cache .cache/kbd/Preview.swift -o .cache/kbd/KeyboardPreview.app/KeyboardPreview
xcodegen generate --spec .cache/kbd/project.yml
xcodebuild build-for-testing -project .cache/kbd/KeyboardEvidence.xcodeproj -scheme KeyboardEvidence -destination 'platform=iOS Simulator,id=71E314A6-5C92-4507-994B-7F7E67DE9495' -derivedDataPath .cache/kbd/build CODE_SIGNING_ALLOWED=NO
