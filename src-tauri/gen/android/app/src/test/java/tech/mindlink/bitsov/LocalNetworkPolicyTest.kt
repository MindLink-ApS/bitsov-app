package tech.mindlink.bitsov

import java.net.InetAddress
import org.junit.Assert.*
import org.junit.Test

class LocalNetworkPolicyTest {
    private fun ip(text: String) = InetAddress.getByName(text)

    @Test
    fun privateAndLinkLocalNeedPermissionButPublicVpnAndLoopbackDoNot() {
        for (host in listOf("192.168.1.2", "10.0.0.2", "172.16.0.2", "169.254.1.2", "fd00::2", "fe80::2")) {
            assertTrue(host, requiresLanPermission(ip(host), emptyList()))
        }
        for (host in listOf("8.8.8.8", "100.64.0.2", "127.0.0.1", "::1", "2001:4860:4860::8888")) {
            assertFalse(host, requiresLanPermission(ip(host), emptyList()))
        }
    }

    @Test
    fun globalIpv6OnTheLocalLinkNeedsPermissionWithoutBlockingPublicFallback() {
        val subnets = listOf(ip("2001:db8:abcd:1::1").address to 64)
        assertTrue(requiresLanPermission(ip("2001:db8:abcd:1::2"), subnets))
        assertFalse(requiresLanPermission(ip("2001:db8:abcd:2::2"), subnets))
        assertFalse(requiresLanPermission(ip("8.8.8.8"), subnets))
    }

    @Test
    fun prefixesRespectPartialBytesAndNeverTreatTheDefaultRouteAsLocal() {
        val local = ip("192.0.2.128").address
        assertTrue(sameSubnet(ip("192.0.2.255").address, local, 25))
        assertFalse(sameSubnet(ip("192.0.2.127").address, local, 25))
        assertFalse(sameSubnet(ip("8.8.8.8").address, local, 0))
        assertFalse(sameSubnet(ip("::1").address, local, 24))
    }
}
