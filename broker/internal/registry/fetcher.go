package registry

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// CanonicalIssuer accepts only a registry authority, never a URL/path supplied
// by an unverified stake. Registry identities are case-insensitive DNS names.
func CanonicalIssuer(issuer string) (string, error) {
	if issuer == "" || strings.HasSuffix(issuer, ":") || strings.ContainsAny(issuer, "/\\@?#%,; \t\r\n") {
		return "", errors.New("invalid registry issuer")
	}
	u, err := url.Parse("https://" + issuer)
	if err != nil || u.Host != issuer || u.Hostname() == "" || len(u.Hostname()) > 253 || u.User != nil {
		return "", errors.New("invalid registry issuer")
	}
	if port := u.Port(); port != "" {
		if number, err := strconv.Atoi(port); err != nil || number <= 0 || number > 65535 {
			return "", errors.New("invalid registry port")
		}
	}
	return strings.ToLower(issuer), nil
}

type KeyFetcher struct {
	overrides        map[string]string
	publicClient     *http.Client
	configuredClient *http.Client
}

func NewKeyFetcher(overrides map[string]string) (*KeyFetcher, error) {
	f := &KeyFetcher{overrides: make(map[string]string)}
	for issuer, endpoint := range overrides {
		canonical, err := CanonicalIssuer(issuer)
		if err != nil {
			return nil, err
		}
		u, err := url.Parse(endpoint)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
			return nil, fmt.Errorf("invalid key endpoint for %s", issuer)
		}
		f.overrides[canonical] = endpoint
	}
	publicTransport := http.DefaultTransport.(*http.Transport).Clone()
	// Resolve and validate at dial time; connect to that exact IP to avoid DNS
	// rebinding. Never route an untrusted issuer through an environment proxy.
	publicTransport.Proxy = nil
	publicTransport.DialContext = dialPublicRegistry
	noRedirects := func(*http.Request, []*http.Request) error {
		return errors.New("registry key redirects are not allowed")
	}
	f.publicClient = &http.Client{Timeout: 10 * time.Second, Transport: publicTransport, CheckRedirect: noRedirects}
	f.configuredClient = &http.Client{Timeout: 10 * time.Second, CheckRedirect: noRedirects}
	return f, nil
}

func (f *KeyFetcher) Fetch(ctx context.Context, issuer string) (*rsa.PublicKey, error) {
	canonical, err := CanonicalIssuer(issuer)
	if err != nil {
		return nil, err
	}
	endpoint, configured := f.overrides[canonical]
	client := f.publicClient
	if configured {
		// Explicit administrator mappings support local Docker/private registries.
		client = f.configuredClient
	} else {
		endpoint = "https://" + canonical + "/registry/public-key"
	}
	return fetchPublicKey(ctx, client, endpoint)
}

func publicIP(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !reservedAddressSpace(ip)
}

var reservedNetworks = func() []*net.IPNet {
	var networks []*net.IPNet
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		_, network, _ := net.ParseCIDR(cidr)
		networks = append(networks, network)
	}
	return networks
}()

func reservedAddressSpace(ip net.IP) bool {
	for _, network := range reservedNetworks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func dialPublicRegistry(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	var lastError error
	for _, address := range addresses {
		if !publicIP(address.IP) {
			return nil, errors.New("registry issuer resolves to a non-public address; use an explicit registry key mapping for private registries")
		}
	}
	for _, address := range addresses {
		conn, err := (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
		if err == nil {
			return conn, nil
		}
		lastError = err
	}
	if lastError == nil {
		lastError = errors.New("registry issuer has no IP addresses")
	}
	return nil, lastError
}
