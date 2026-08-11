package reconciler

import "github.com/cilium/cilium/pkg/metrics/metric"

func newMetrics(labels metric.Labels) metric.Vec[metric.Counter] {
	return metric.NewCounterVecWithLabels(metric.CounterOpts{
		Name: "id_allocation_failures_total",
		Help: "Total number of ID allocation failures",
	}, labels)
}
