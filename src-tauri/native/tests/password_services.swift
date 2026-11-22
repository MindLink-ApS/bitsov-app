// Pure service-name checks against the compiled bridge; no native storage calls.
let node = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
let service = "bitsov.node.\(node).seed-password"
let profiles = ["", "tech.mindlink.bitsov.remotetest.", "tech.mindlink.bitsov.beta."]
var checks = 0

for profile in profiles {
    let name = profile + service
    precondition(passwordNode(name) == node, "valid profile service rejected: \(profile)")
    precondition(wrappedService(name) == name + ".wrapped-v1")
    checks += 2
    for invalid in [
        "", "bitsov.node..seed-password",
        "bitsov.node.\(node.dropLast()).seed-password",
        "bitsov.node.\(node)0.seed-password",
        "bitsov.node.\(node.uppercased()).seed-password",
        "bitsov.node.\(node.dropLast())g.seed-password",
        "bitsov.node.\(node).box-transport",
        service + ".extra", service + ".wrapped-v1", service + "\n",
    ] {
        precondition(passwordNode(profile + invalid) == nil)
        checks += 1
    }
    for nested in profiles.dropFirst() {
        precondition(passwordNode(nested + "tech.mindlink.bitsov.beta." + name) == nil)
        precondition(passwordNode(nested + "tech.mindlink.bitsov.remotetest." + name) == nil)
        checks += 2
    }
}
for unknown in [
    "tech.mindlink.bitsov.", "tech.mindlink.bitsov.other.",
    "tech.mindlink.bitsov.beta.extra.", "tech.mindlink.bitsov.remotetest.extra.",
    "TECH.MINDLINK.BITSOV.BETA.", "TECH.MINDLINK.BITSOV.REMOTETEST.",
    "tech.mindlink.bitsov.beta", "tech.mindlink.bitsov.remotetest",
] {
    precondition(passwordNode(unknown + service) == nil)
    checks += 1
}
print("Completed \(checks) service-name checks")
