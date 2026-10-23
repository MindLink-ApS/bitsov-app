#!/bin/sh
set -eu
DEVICE=${DEVICE:-71E314A6-5C92-4507-994B-7F7E67DE9495}
mkdir -p .cache/u2b/Tests .cache/u2b/DynamicTypePreview.app
cp docs/ui/u2b-dynamic-type/harness/Preview.swift docs/ui/u2b-dynamic-type/harness/project.yml .cache/u2b/
cp docs/ui/u2b-dynamic-type/harness/DynamicTypeEvidence.swift .cache/u2b/Tests/
cp docs/ui/u2b-dynamic-type/harness/Info.plist .cache/u2b/DynamicTypePreview.app/
xcrun --sdk iphonesimulator swiftc -parse-as-library -target arm64-apple-ios17.0-simulator -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -module-cache-path .cache/u2b/swift-cache .cache/u2b/Preview.swift -o .cache/u2b/DynamicTypePreview.app/DynamicTypePreview
xcodegen generate --spec .cache/u2b/project.yml
xcodebuild build-for-testing -project .cache/u2b/DynamicTypeEvidence.xcodeproj -scheme DynamicTypeEvidence -destination "platform=iOS Simulator,id=$DEVICE" -derivedDataPath .cache/u2b/build CODE_SIGNING_ALLOWED=NO
