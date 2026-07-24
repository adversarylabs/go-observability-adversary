package average

import "context"

type tracer struct{}

func (tracer) Start(context.Context, string) {}

func observe(tr tracer) {
	tr.Start(context.Background(), "work")
}
