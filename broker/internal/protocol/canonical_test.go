package protocol

import "testing"

func TestCanonicalJSONMatchesClientHTMLAndUnicodeEncoding(t *testing.T) {
	raw := []byte("{\"iat\":1700000000,\"content\":\"<b>& café 😀\\u2028\\u2029\",\"__proto__\":{\"signed\":true}}")
	want := "{\"__proto__\":{\"signed\":true},\"content\":\"<b>& café 😀\\u2028\\u2029\",\"iat\":1700000000}"
	got, err := canonicalJSONBytes(raw)
	if err != nil || string(got) != want {
		t.Fatalf("canonical bytes differ: %s (%v)", got, err)
	}
}
