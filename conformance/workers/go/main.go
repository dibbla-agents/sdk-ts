// Command worker is the sdk-go implementation of the conformance worker
// profile (../../PROFILE.md). The conformance runner starts it as a child
// process and drives it over the wire; the scenarios it passes are, by
// definition, what sdk-go does.
//
// The module path sits under github.com/dibbla-agents/sdk-go so the worker can
// use the SDK's internal packages (event state, store, OAuth), exactly as a
// function inside sdk-go would. It can move into the sdk-go repository
// unchanged.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	sdk "github.com/dibbla-agents/sdk-go"
	"github.com/dibbla-agents/sdk-go/internal/oauth"
	"github.com/dibbla-agents/sdk-go/internal/state"
	"github.com/dibbla-agents/sdk-go/internal/types"
	"github.com/dibbla-agents/sdk-go/jobs"
)

func main() {
	log.SetOutput(os.Stderr)

	opts := []sdk.Option{}
	if v := os.Getenv("CONFORMANCE_PING_INTERVAL_SEC"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			log.Fatalf("CONFORMANCE_PING_INTERVAL_SEC: %v", err)
		}
		opts = append(opts, sdk.WithPingInterval(n))
	} else {
		opts = append(opts, sdk.WithPingInterval(0))
	}

	server, err := sdk.New(opts...)
	if err != nil {
		log.Fatalf("sdk.New: %v", err)
	}

	server.RegisterFunction(echoFunction())
	server.RegisterFunction(failFunction())
	server.RegisterFunction(whoamiFunction())
	server.RegisterFunction(cachedUpperFunction())
	server.RegisterFunction(storeAppendFunction())
	server.RegisterFunction(oauthTokenFunction())
	server.RegisterFunction(statusPingFunction())

	for _, p := range providers() {
		if err := server.RegisterCapabilityProvider(p); err != nil {
			log.Fatalf("RegisterCapabilityProvider: %v", err)
		}
	}

	server.RegisterJob(countJob{})

	if err := server.Start(); err != nil {
		log.Fatalf("Start: %v", err)
	}
}

// --- functions --------------------------------------------------------------

type EchoItem struct {
	Name string `json:"name"`
	Qty  int    `json:"qty"`
}

type EchoNested struct {
	Inner string `json:"inner"`
}

type Echo struct {
	Text   string            `json:"text"`
	Count  int               `json:"count"`
	Ratio  float64           `json:"ratio"`
	Flag   bool              `json:"flag"`
	Tags   []string          `json:"tags"`
	Items  []EchoItem        `json:"items"`
	Attrs  map[string]string `json:"attrs"`
	Nested EchoNested        `json:"nested"`
}

func echoFunction() sdk.FunctionBuilder {
	return sdk.NewSimpleFunction[Echo, Echo]("echo", "1.0.0", "Echo the input back").
		WithHandler(func(in Echo) (Echo, error) { return in, nil }).
		WithTags("conformance")
}

type TextIn struct {
	Text string `json:"text"`
}

type TextOut struct {
	Text string `json:"text"`
}

func failFunction() sdk.FunctionBuilder {
	return sdk.NewSimpleFunction[TextIn, TextOut]("fail", "1.0.0", "Always fails").
		WithHandler(func(TextIn) (TextOut, error) { return TextOut{}, errors.New("boom") })
}

type WhoamiIn struct {
	Query string `json:"query"`
}

type WhoamiOut struct {
	Present  bool   `json:"present"`
	IsUser   bool   `json:"is_user"`
	Identity string `json:"identity"`
	UserID   string `json:"user_id"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	OrgID    string `json:"org_id"`
	OrgRole  string `json:"org_role"`
}

func whoamiFunction() sdk.FunctionBuilder {
	return sdk.NewSimpleFunction[WhoamiIn, WhoamiOut]("whoami", "1.0.0", "Report the verified caller").
		WithContextHandler(func(ctx context.Context, _ WhoamiIn) (WhoamiOut, error) {
			c, ok := sdk.CallerFromContext(ctx)
			return WhoamiOut{
				Present:  ok,
				IsUser:   c.IsUser(),
				Identity: c.Identity,
				UserID:   c.UserID,
				Email:    c.Email,
				Name:     c.Name,
				OrgID:    c.OrgID,
				OrgRole:  c.OrgRole,
			}, nil
		})
}

func cachedUpperFunction() sdk.FunctionBuilder {
	return sdk.NewFunction[TextIn, TextOut]("cached_upper", "1.0.0", "Upper-case with a 60s cache").
		WithHandler(func(in TextIn, _ *types.EventMessage, _ *state.GlobalState) (TextOut, error) {
			return TextOut{Text: strings.ToUpper(in.Text)}, nil
		}).
		WithCacheTTL(60 * time.Second)
}

type HistoryOut struct {
	History []string `json:"history"`
}

func storeAppendFunction() sdk.FunctionBuilder {
	return sdk.NewFunction[TextIn, HistoryOut]("store_append", "1.0.0", "Append to a per-workflow history").
		WithHandler(func(in TextIn, ev *types.EventMessage, gs *state.GlobalState) (HistoryOut, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			var history []string
			if data, err := gs.GrpcStore.Get(ctx, ev.Workflow, "history"); err == nil && len(data) > 0 {
				if json.Unmarshal(data, &history) != nil {
					history = nil
				}
			}
			history = append(history, in.Text)

			encoded, err := json.Marshal(history)
			if err != nil {
				return HistoryOut{}, err
			}
			if err := gs.GrpcStore.Set(ctx, ev.Workflow, "history", encoded); err != nil {
				return HistoryOut{}, err
			}
			return HistoryOut{History: history}, nil
		})
}

type TokenOut struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Provider    string `json:"provider"`
}

func oauthTokenFunction() sdk.FunctionBuilder {
	return sdk.NewFunction[TextIn, TokenOut]("oauth_token", "1.0.0", "Fetch a Google access token").
		WithHandler(func(_ TextIn, ev *types.EventMessage, gs *state.GlobalState) (TokenOut, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			tok, err := gs.OAuth.GetAccessToken(ctx, oauth.ProviderGoogle, ev.Run)
			if err != nil {
				return TokenOut{}, err
			}
			return TokenOut{AccessToken: tok.AccessToken, TokenType: tok.TokenType, Provider: tok.Provider}, nil
		})
}

type OkOut struct {
	OK bool `json:"ok"`
}

func statusPingFunction() sdk.FunctionBuilder {
	return sdk.NewFunction[TextIn, OkOut]("status_ping", "1.0.0", "Send a status message").
		WithHandler(func(_ TextIn, ev *types.EventMessage, gs *state.GlobalState) (OkOut, error) {
			if err := gs.RpcClient.SendStatusEvent(ev, "working", map[string]int{"step": 1}); err != nil {
				return OkOut{}, err
			}
			return OkOut{OK: true}, nil
		})
}

// --- capability providers ---------------------------------------------------

func providers() []sdk.CapabilityProvider {
	return []sdk.CapabilityProvider{
		sdk.ToolSearchProvider{
			Name:        "reverse",
			Description: "Reverse the offered stubs",
			Version:     "1.0.0",
			Select: func(query string, stubs []sdk.ProviderStub, topN int) ([]string, error) {
				if query == "error" {
					return nil, errors.New("kaboom")
				}
				out := []string{}
				for i := len(stubs) - 1; i >= 0 && len(out) < topN; i-- {
					out = append(out, stubs[i].Name)
				}
				return out, nil
			},
		},
		sdk.ToolSearchProvider{
			Name:               "ports",
			Description:        "Filter stubs by a wired prefix",
			Version:            "1.0.0",
			ExtraInputsSchema:  json.RawMessage(`{"type":"object","properties":{"prefix":{"type":"string"}}}`),
			ExtraOutputsSchema: json.RawMessage(`{"type":"object","properties":{"count":{"type":"integer"}}}`),
			SelectFull: func(_ context.Context, req sdk.SelectRequest) (sdk.SelectResponse, error) {
				prefix, _ := req.ExtraInputs["prefix"].(string)
				selected := []string{}
				for _, s := range req.Stubs {
					if strings.HasPrefix(s.Name, prefix) {
						selected = append(selected, s.Name)
					}
				}
				return sdk.SelectResponse{
					Selected:     selected,
					ExtraOutputs: map[string]any{"count": len(selected)},
				}, nil
			},
		},
		sdk.ToolSearchProvider{
			Name:        "inert",
			Description: "Registered without a handler",
			Version:     "1.0.0",
		},
		sdk.MemoryProvider{
			Name:               "marker",
			Description:        "Inject a marker turn and the last turn",
			Version:            "1.0.0",
			MaxHistoryFraction: 0.5,
			ExtraInputsSchema:  json.RawMessage(`{"type":"object","properties":{"note":{"type":"string"}}}`),
			TransformFull: func(_ context.Context, req sdk.TransformRequest) (sdk.TransformResponse, error) {
				user := "none"
				if req.Meta.UserID != nil {
					user = *req.Meta.UserID
				}
				summary := "[marker msg=" + req.CurrentMessage +
					" org=" + req.Meta.OrgID +
					" user=" + user +
					" budget=" + strconv.Itoa(req.TokenBudget) +
					" turns=" + strconv.Itoa(len(req.Turns)) + "]"
				date, _ := time.Parse(time.RFC3339, "2026-01-01T00:00:00Z")
				out := []sdk.Turn{{
					ID:    "marker",
					Role:  "assistant",
					Date:  date,
					Parts: []sdk.Part{{Type: sdk.PartTypeText, Text: &sdk.TextPart{Text: summary}}},
				}}
				if len(req.Turns) > 0 {
					out = append(out, req.Turns[len(req.Turns)-1])
				}
				resp := sdk.TransformResponse{Turns: out}
				if note, ok := req.ExtraInputs["note"].(string); ok {
					resp.ExtraOutputs = map[string]any{"note": note}
				}
				return resp, nil
			},
		},
		sdk.MemoryProvider{
			Name:        "blocking",
			Description: "Block until the call is cancelled",
			Version:     "1.0.0",
			Transform: func(ctx context.Context, _ string, _ []sdk.Turn, _ int, _ sdk.ThreadMeta) ([]sdk.Turn, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			},
		},
	}
}

// --- jobs -------------------------------------------------------------------

type countJob struct{}

func (countJob) GetJobID() string   { return "count_job" }
func (countJob) GetJobName() string { return "Count Job" }

func (countJob) GetParameters() []jobs.JobParameter {
	return []jobs.JobParameter{
		{Name: "limit", Type: "int", Required: true},
		{Name: "label", Type: "string", Required: false, Default: "items"},
	}
}

func (countJob) Execute(ctx *jobs.JobContext) error {
	limit := ctx.GetIntArg("limit", 0)
	label := ctx.GetStringArg("label", "items")

	ctx.Logger.Info("starting")
	if ctx.GetBoolArg("fail", false) {
		ctx.Logger.Error("failing")
		return errors.New("count failed")
	}

	ctx.Logger.TaskStarted("count")
	for i := 1; i <= limit; i++ {
		ctx.Logger.Progress(i, limit, "counting "+label)
	}
	ctx.Logger.TaskCompleted()
	ctx.Logger.Warn("done")
	return nil
}
