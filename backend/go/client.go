package apicostx

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const DefaultBaseURL = "https://api.apicostx.com"

type Error struct {
	Status int
	Detail any
}

func (e *Error) Error() string {
	return fmt.Sprintf("APICostX request failed (%d): %v", e.Status, e.Detail)
}

type Client struct {
	APIKey       string
	BaseURL      string
	HTTP         *http.Client
	MaxRetries   int
	RetryBackoff time.Duration
}

type ExecuteOptions struct {
	InputContentIDs []string       `json:"input_content_ids,omitempty"`
	IdempotencyKey  string         `json:"idempotency_key,omitempty"`
	Overrides       map[string]any `json:"overrides,omitempty"`
}

func New(apiKey string) *Client {
	return &Client{APIKey: strings.TrimSpace(apiKey), BaseURL: DefaultBaseURL, HTTP: &http.Client{Timeout: 30 * time.Second}, MaxRetries: 2, RetryBackoff: 500 * time.Millisecond}
}

func (c *Client) request(ctx context.Context, method, path string, body any, out any, authenticated bool) error {
	return c.requestWithHeaders(ctx, method, path, body, out, authenticated, nil)
}

func (c *Client) requestWithHeaders(ctx context.Context, method, path string, body any, out any, authenticated bool, extra http.Header) error {
	if authenticated && c.APIKey == "" {
		return &Error{Status: 401, Detail: "APICOSTX_API_KEY is required"}
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(data))
	}
	safe := method == http.MethodGet || method == http.MethodHead
	// Copy the caller's client; never mutate its redirect policy or forward keys.
	httpClient := *c.HTTP
	httpClient.CheckRedirect = func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, reader)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if authenticated {
			req.Header.Set("X-ACM2-API-Key", c.APIKey)
		}
		for key, values := range extra {
			for _, value := range values { req.Header.Add(key, value) }
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			if !safe || attempt >= c.MaxRetries {
				return err
			}
			if err := sleep(ctx, c.RetryBackoff*time.Duration(1<<attempt)); err != nil {
				return err
			}
			continue
		}
		if safe && (resp.StatusCode == 429 || resp.StatusCode == 502 || resp.StatusCode == 503 || resp.StatusCode == 504) && attempt < c.MaxRetries {
			delay := c.RetryBackoff * time.Duration(1<<attempt)
			if raw := resp.Header.Get("Retry-After"); raw != "" {
				if seconds, err := strconv.Atoi(raw); err == nil && seconds >= 0 {
					delay = time.Duration(seconds) * time.Second
				} else if date, err := http.ParseTime(raw); err == nil {
					delay = time.Until(date)
				}
			}
			resp.Body.Close()
			if err := sleep(ctx, delay); err != nil {
				return err
			}
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			var detail any
			json.NewDecoder(resp.Body).Decode(&detail)
			return &Error{Status: resp.StatusCode, Detail: detail}
		}
		if out == nil {
			return nil
		}
		if resp.StatusCode == 204 || resp.StatusCode == 205 {
			return nil
		}
		if data, ok := out.(*[]byte); ok {
			*data, err = io.ReadAll(resp.Body)
			return err
		}
		return json.NewDecoder(resp.Body).Decode(out)
	}
}

func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	return out, c.request(ctx, http.MethodGet, "/api/health", nil, &out, false)
}
func (c *Client) ListPresets(ctx context.Context, page, pageSize int) (map[string]any, error) {
	out := map[string]any{}
	p := fmt.Sprintf("/api/presets?page=%d&page_size=%d", page, pageSize)
	return out, c.request(ctx, http.MethodGet, p, nil, &out, true)
}
func (c *Client) GetPreset(ctx context.Context, id string) (map[string]any, error) {
	out := map[string]any{}
	return out, c.request(ctx, http.MethodGet, "/api/presets/"+id, nil, &out, true)
}
func (c *Client) CheckPreset(ctx context.Context, id string) (map[string]any, error) {
	out := map[string]any{}
	return out, c.request(ctx, http.MethodGet, "/api/presets/"+id+"/runnable", nil, &out, true)
}
func (c *Client) ExecutePreset(ctx context.Context, id string, opts ExecuteOptions) (map[string]any, error) {
	out := map[string]any{}
	extra := make(http.Header)
	if opts.IdempotencyKey != "" { extra.Set("Idempotency-Key", opts.IdempotencyKey) }
	return out, c.requestWithHeaders(ctx, http.MethodPost, "/api/presets/"+id+"/execute", opts, &out, true, extra)
}
func (c *Client) GetRun(ctx context.Context, id string) (map[string]any, error) {
	out := map[string]any{}
	return out, c.request(ctx, http.MethodGet, "/api/runs/"+id, nil, &out, true)
}
func (c *Client) GetLiveSummary(ctx context.Context, id string) (map[string]any, error) {
	out := map[string]any{}
	return out, c.request(ctx, http.MethodGet, "/api/runs/"+id+"/live-summary", nil, &out, true)
}

type Page struct {
	Limit  int
	Offset int
}

func (c *Client) GetGeneratedResults(ctx context.Context, id, sourceDocID string, pages ...Page) (map[string]any, error) {
	return c.section(ctx, id, "generated", sourceDocID, 50, pages)
}
func (c *Client) GetEvaluationResults(ctx context.Context, id, sourceDocID string, pages ...Page) (map[string]any, error) {
	return c.section(ctx, id, "evaluation", sourceDocID, 25, pages)
}
func (c *Client) section(ctx context.Context, id, section, source string, limit int, pages []Page) (map[string]any, error) {
	page := Page{Limit: limit}
	if len(pages) > 0 {
		page = pages[0]
	}
	query := url.Values{"limit": {strconv.Itoa(page.Limit)}, "offset": {strconv.Itoa(page.Offset)}}
	if source != "" {
		query.Set("source_doc_id", source)
	}
	out := map[string]any{}
	return out, c.request(ctx, http.MethodGet, "/api/runs/"+url.PathEscape(id)+"/sections/"+section+"?"+query.Encode(), nil, &out, true)
}
func (c *Client) ListRuns(ctx context.Context, status string, limit, offset int) (map[string]any, error) {
	query := url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
	if status != "" {
		query.Set("status", status)
	}
	out := map[string]any{}
	return out, c.request(ctx, http.MethodGet, "/api/runs?"+query.Encode(), nil, &out, true)
}
func (c *Client) DownloadExport(ctx context.Context, id string) ([]byte, error) {
	var data []byte
	err := c.request(ctx, http.MethodGet, "/api/runs/"+url.PathEscape(id)+"/export", nil, &data, true)
	return data, err
}

func (c *Client) WaitForRun(ctx context.Context, id string, timeout, poll time.Duration) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		summary, err := c.GetLiveSummary(ctx, id)
		if err != nil {
			return nil, err
		}
		status := strings.ToLower(fmt.Sprint(summary["status"]))
		if status == "<nil>" {
			status = strings.ToLower(fmt.Sprint(summary["run_status"]))
		}
		if status == "completed" || status == "completed_with_errors" || status == "failed" || status == "cancelled" || status == "canceled" || status == "error" {
			return c.GetRun(ctx, id)
		}
		if err := sleep(ctx, poll); err != nil {
			return nil, err
		}
	}
}

func Int(v int) string { return strconv.Itoa(v) }
