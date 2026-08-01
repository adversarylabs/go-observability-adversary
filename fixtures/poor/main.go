package poor

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
)

var requests = prometheus.NewCounterVec(
	prometheus.CounterOpts{Name: "requests_total"},
	[]string{"method", "user_id", "path"},
)

func handle(w http.ResponseWriter, r *http.Request) {
	requests.WithLabelValues(r.Method, r.Header.Get("X-User-Id"), r.URL.Path).Inc()
	w.WriteHeader(http.StatusOK)
}
