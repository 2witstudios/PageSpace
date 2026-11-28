# Fly's MachineRequest.GetExitCode prefers MonitorEvent, then exit_event.
# The Go API omits zero fields; require the exit record before defaulting them.
def exit_record:
  [.events[]? | select(.type == "exit")] | sort_by(.timestamp) | last |
  (.request.MonitorEvent.exit_event // .request.exit_event);
def failed:
  (.exit_code // 0) != 0 or (.guest_exit_code // 0) != 0 or
  (.signal // 0) > 0 or (.guest_signal // 0) > 0 or
  (.oom_killed // false) != false or (.requested_stop // false) != false;
if $ARGS.named.mode == "failed" then
  exit_record | type == "object" and failed
else
  .state == "stopped" and (
    exit_record | type == "object" and .exited_at != null and
    # Fly uses -1 for no signal; positive signals indicate termination.
    (failed | not)
  )
end
