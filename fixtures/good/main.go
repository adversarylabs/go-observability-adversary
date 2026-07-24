package good

import "log/slog"

func report(operation string) {
	slog.Info("completed", "operation", operation, "outcome", "success")
}
