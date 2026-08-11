package server

import "github.com/prometheus/client_golang/prometheus"

var requestErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "request_errors_total",
	Help: "Total number of failed requests",
}, []string{"route"})

var activeRequests = prometheus.NewGauge(prometheus.GaugeOpts{
	Name: "active_requests",
	Help: "Requests currently in flight",
})

var processRestarts = prometheus.NewCounter(prometheus.CounterOpts{
	Name: "process_restarts_total",
	Help: "Total process restarts",
})

var diskCorruptionIncidents = prometheus.NewCounter(prometheus.CounterOpts{
	Name: "disk_corruption_incidents_total",
	Help: "Total disk corruption incidents",
})
