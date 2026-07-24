package terrible

import (
	"context"
	"log/slog"
)

var labels = []string{"method", "user_id", "error"}

type tracer struct{}

func (tracer) Start(context.Context, string) {}

func observe(tr tracer, token string) {
	slog.Info("request", "authorization", token)
	tr.Start(context.Background(), "request")
}
