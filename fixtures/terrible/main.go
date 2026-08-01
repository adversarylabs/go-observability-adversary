package terrible

import (
	"context"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
)

var labels = []string{"method", "user_id", "error"}

type span struct{}

type tracer struct{}

func (tracer) Start(context.Context, string) (context.Context, span) {
	return context.Background(), span{}
}

func handle(w http.ResponseWriter, r *http.Request) {
	prometheus.MustRegister(prometheus.NewCounter(prometheus.CounterOpts{Name: "per_request"}))
	tr := tracer{}
	_, sp := tr.Start(context.Background(), "request")
	_ = sp
	defer func() { recover() }()
	w.WriteHeader(http.StatusOK)
}
