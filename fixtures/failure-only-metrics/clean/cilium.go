package server

import "github.com/cilium/cilium/pkg/metrics/metric"

func newAllocationMetrics(labels metric.Labels) (metric.Vec[metric.Counter], metric.Vec[metric.Counter]) {
	attempts := metric.NewCounterVecWithLabels(metric.CounterOpts{
		Name: "id_allocation_attempts_total",
		Help: "Total number of ID allocation attempts",
	}, labels)
	failures := metric.NewCounterVecWithLabels(metric.CounterOpts{
		Name: "id_allocation_failures_total",
		Help: "Total number of ID allocation failures",
	}, labels)
	return attempts, failures
}
