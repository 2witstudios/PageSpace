# Fly's MachineRequest.GetExitCode prefers MonitorEvent, then exit_event.
# The Go API omits zero fields; require the exit record before defaulting them.
.state == "stopped" and (
  [.events[]? | select(.type == "exit")] | sort_by(.timestamp) | last |
  (.request.MonitorEvent.exit_event // .request.exit_event) |
  type == "object" and .exited_at != null and
  (.exit_code // 0) == 0 and (.guest_exit_code // 0) == 0 and
  (.signal // 0) == 0 and (.guest_signal // 0) == 0 and
  (.oom_killed // false) == false and (.requested_stop // false) == false
)
