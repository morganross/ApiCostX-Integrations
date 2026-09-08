package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	api "github.com/morganross/apicostx-go"
	"os"
	"time"
)

func printJSON(v any) { b, _ := json.MarshalIndent(v, "", "  "); fmt.Println(string(b)) }
func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: apicostx-go health|presets|run|runs <args>")
		os.Exit(2)
	}
	c := api.New(os.Getenv("APICOSTX_API_KEY"))
	c.BaseURL = os.Getenv("APICOSTX_BASE_URL")
	if c.BaseURL == "" {
		c.BaseURL = api.DefaultBaseURL
	}
	ctx := context.Background()
	var v map[string]any
	var err error
	waited := false
	switch os.Args[1] {
	case "health":
		v, err = c.Health(ctx)
	case "presets":
		v, err = c.ListPresets(ctx, 1, 100)
	case "run":
		flags := flag.NewFlagSet("run", flag.ExitOnError)
		key := flags.String("idempotency-key", fmt.Sprintf("cli-%d", time.Now().UnixNano()), "stable retry key")
		input := flags.String("input-content-id", "", "input document ID")
		wait := flags.Bool("wait", false, "wait for completion")
		flags.Parse(os.Args[2:])
		args := flags.Args()
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: apicostx-go run [flags] <preset-id>")
			os.Exit(2)
		}
		opts := api.ExecuteOptions{IdempotencyKey: *key}
		if *input != "" {
			opts.InputContentIDs = []string{*input}
		}
		v, err = c.ExecutePreset(ctx, args[0], opts)
		if err == nil && *wait {
			waited = true
			fmt.Fprintln(os.Stderr, "run_id="+fmt.Sprint(v["run_id"]))
			v, err = c.WaitForRun(ctx, fmt.Sprint(v["run_id"]), 30*time.Minute, 2*time.Second)
		}
	case "runs":
		if len(os.Args) < 4 {
			fmt.Fprintln(os.Stderr, "usage: apicostx-go runs get|wait <run-id>")
			os.Exit(2)
		}
		switch os.Args[2] {
		case "get":
			v, err = c.GetRun(ctx, os.Args[3])
		case "wait":
			waited = true
			v, err = c.WaitForRun(ctx, os.Args[3], 30*time.Minute, 2*time.Second)
		default:
			fmt.Fprintln(os.Stderr, "unknown runs command")
			os.Exit(2)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	printJSON(v)
	if waited && v["status"] != "completed" {
		os.Exit(1)
	}
}
