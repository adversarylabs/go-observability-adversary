package server

import "github.com/prometheus/client_golang/prometheus"

var requests = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "requests_total",
	Help: "Total requests",
}, []string{"route"})

var connectionAttempts = prometheus.NewCounter(prometheus.CounterOpts{
	Name: "connection_attempts_total",
	Help: "Total connection attempts",
})
