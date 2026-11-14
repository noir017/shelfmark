package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sync"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
)

// contract validates real responses against api/openapi.yaml.
type contract struct {
	router  routers.Router
	mu      sync.Mutex
	checked map[string]bool
}

var (
	contractOnce sync.Once
	contractVal  *contract
	contractErr  error
	// covered collects "METHOD path status" seen across tests.
	covered sync.Map
)

func loadContract(t *testing.T) *contract {
	t.Helper()
	contractOnce.Do(func() {
		for _, ct := range []string{"application/xml", "text/html", "image/png", "image/x-icon", "image/svg+xml"} {
			openapi3filter.RegisterBodyDecoder(ct, openapi3filter.FileBodyDecoder)
		}
		loader := openapi3.NewLoader()
		doc, err := loader.LoadFromFile("../../../api/openapi.yaml")
		if err != nil {
			contractErr = err
			return
		}
		if err := doc.Validate(context.Background()); err != nil {
			contractErr = err
			return
		}
		doc.Servers = nil
		r, err := legacy.NewRouter(doc)
		if err != nil {
			contractErr = err
			return
		}
		contractVal = &contract{router: r, checked: map[string]bool{}}
	})
	if contractErr != nil {
		t.Fatalf("load contract: %v", contractErr)
	}
	return contractVal
}

func (c *contract) check(t *testing.T, req *http.Request, r resp) {
	t.Helper()
	route, params, err := c.router.FindRoute(req)
	if err != nil {
		if r.status != http.StatusNotFound {
			t.Errorf("contract: %s %s is not in api/openapi.yaml", req.Method, req.URL.Path)
		}
		return
	}
	opts := &openapi3filter.Options{SchemaValidationOptions: []openapi3.SchemaValidationOption{openapi3.EnableJSONSchema2020()}, MultiError: true}
	in := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: &openapi3filter.RequestValidationInput{Request: req, PathParams: params, Route: route, Options: opts},
		Status:                 r.status,
		Header:                 r.header,
		Body:                   io.NopCloser(bytes.NewReader(r.body)),
		Options:                opts,
	}
	if err := openapi3filter.ValidateResponse(context.Background(), in); err != nil {
		t.Errorf("contract: %s %s -> %d does not match the schema: %v\n%s", req.Method, route.Path, r.status, err, r.body)
		return
	}
	covered.Store(req.Method+" "+route.Path, true)
}

// TestContractCoverage makes sure the main endpoints were validated by the other tests.
func TestContractCoverage(t *testing.T) {
	// run the flows (they record what they validated)
	for _, f := range []func(*testing.T){TestFloccusBrowserSync, TestWebFlowRevisionsAndRestore, TestGuardAndApprove, TestTransfer, TestLoginRateLimitAndTokens} {
		f(t)
	}
	main := []string{
		"POST /api/v1/setup", "POST /api/v1/auth/login", "GET /api/v1/auth/me", "POST /api/v1/tokens", "GET /api/v1/tokens",
		"POST /api/v1/floccus/setup", "GET /api/v1/libraries", "GET /api/v1/libraries/{slug}", "POST /api/v1/libraries",
		"GET /api/v1/libraries/{slug}/tree", "POST /api/v1/libraries/{slug}/items", "PATCH /api/v1/libraries/{slug}/items/{itemId}",
		"GET /api/v1/libraries/{slug}/items/{itemId}", "DELETE /api/v1/libraries/{slug}/items/{itemId}",
		"POST /api/v1/libraries/{slug}/items/{itemId}/transfer", "POST /api/v1/quick-save", "GET /api/v1/lookup", "GET /api/v1/search",
		"GET /api/v1/libraries/{slug}/revisions", "GET /api/v1/libraries/{slug}/revisions/{rev}", "POST /api/v1/libraries/{slug}/revisions/{rev}/restore",
		"GET /api/v1/libraries/{slug}/deleted", "POST /api/v1/libraries/{slug}/deleted/restore", "GET /api/v1/pending",
		"GET /api/v1/libraries/{slug}/pending/{pendingId}", "POST /api/v1/libraries/{slug}/pending/{pendingId}/approve",
		"GET /api/v1/settings", "PATCH /api/v1/settings", "GET /api/v1/jobs", "GET /api/v1/reports/duplicates", "GET /api/v1/reports/broken",
		"GET /api/v1/recent", "GET /api/v1/system/info", "GET /api/v1/users", "GET /api/v1/tags", "GET /api/v1/ai/status",
		"POST /api/v1/auth/token",
	}
	for _, m := range main {
		if _, ok := covered.Load(m); !ok {
			t.Errorf("no validated response for %s", m)
		}
	}
}
