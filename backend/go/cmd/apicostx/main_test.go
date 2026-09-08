package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
)

func TestCLIHelper(t *testing.T) {
	if os.Getenv("APICOSTX_CLI_TEST_HELPER") != "1" {
		return
	}
	os.Args = []string{"apicostx", "run", "--wait", "p"}
	main()
}

func TestWaitExitCodes(t *testing.T) {
	for _, status := range []string{"completed", "failed", "cancelled", "completed_with_errors"} {
		t.Run(status, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					w.Write([]byte(`{"run_id":"r"}`))
				} else {
					w.Write([]byte(`{"status":"` + status + `"}`))
				}
			}))
			defer s.Close()
			cmd := exec.Command(os.Args[0], "-test.run=^TestCLIHelper$")
			cmd.Env = append(os.Environ(), "APICOSTX_CLI_TEST_HELPER=1", "APICOSTX_API_KEY=synthetic", "APICOSTX_BASE_URL="+s.URL)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			err := cmd.Run()
			if status == "completed" && err != nil {
				t.Fatal(err)
			}
			if status != "completed" && (err == nil || cmd.ProcessState.ExitCode() != 1) {
				t.Fatal("unsuccessful run reported success", err)
			}
			if !bytes.Contains(stderr.Bytes(), []byte("run_id=r")) {
				t.Fatal("run ID missing")
			}
		})
	}
}
