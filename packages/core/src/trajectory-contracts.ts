export type TrajectoryAction = "checkpoint-approve" | "checkpoint-reject" | "pause" | "resume" | "steer" | "stop" | "retry";
export type TrajectoryTarget = { kind: "run" | "subagent"; id: string };

const TRAJECTORY_ACTIONS: readonly TrajectoryAction[] = ["checkpoint-approve", "checkpoint-reject", "pause", "resume", "steer", "stop", "retry"];

export function isTrajectoryAction(value: unknown): value is TrajectoryAction { return typeof value === "string" && TRAJECTORY_ACTIONS.includes(value as TrajectoryAction); }
export function isTrajectoryTarget(value: unknown): value is TrajectoryTarget {
  const target = value as { kind?: unknown; id?: unknown };
  return typeof value === "object" && value !== null && !Array.isArray(value) && (target.kind === "run" || target.kind === "subagent") && typeof target.id === "string" && target.id.length >= 1 && target.id.length <= 200;
}
export function trajectoryActionError(action: TrajectoryAction, target: TrajectoryTarget): string | undefined {
  return target.kind === "subagent" && (action === "checkpoint-approve" || action === "checkpoint-reject" || action === "pause" || action === "resume") ? `Trajectory action ${action} is not supported for subagent targets` : target.kind === "run" && action === "steer" ? "Trajectory action steer is not supported for run targets" : undefined;
}
