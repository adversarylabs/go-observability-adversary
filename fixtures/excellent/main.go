package excellent

import "context"

type span struct{}
type tracer struct{}
type provider struct{}

func (tracer) Start(context.Context, string) (context.Context, span) { return context.Background(), span{} }
func (provider) Shutdown(context.Context) error                    { return nil }

func observe(ctx context.Context, tr tracer, tp provider) {
	defer tp.Shutdown(ctx)
	_, _ = tr.Start(ctx, "work")
}
