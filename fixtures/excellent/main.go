package excellent

import "context"

type span struct{}

func (span) End() {}

type tracer struct{}

func (tracer) Start(ctx context.Context, _ string) (context.Context, span) {
	return ctx, span{}
}

type provider struct{}

func (provider) Shutdown(context.Context) error { return nil }

func observe(ctx context.Context, tr tracer, tp provider) {
	defer tp.Shutdown(ctx)
	_, sp := tr.Start(ctx, "work")
	defer sp.End()
}
