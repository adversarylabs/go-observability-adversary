package average

import (
	"context"
	"log/slog"
)

type tracer struct{}

func (tracer) Start(context.Context, string) {}

func observe(tr tracer) {
	// Orphan span — drops parent context.
	tr.Start(context.Background(), "work")
	// Unbalanced slog key/value pairs.
	slog.Info("done", "operation")
}
