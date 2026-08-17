import {
  AdmissionCapacityError,
  type ExecutionDeadline,
} from "@/lib/execution-envelope";

const DEFAULT_CAPACITY = 1;
let activeRuns = 0;

export function resolveAdmissionCapacity(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.AGENT_RUN_ADMISSION_CAPACITY;
  if (raw === undefined && env.NODE_ENV !== "production") {
    return DEFAULT_CAPACITY;
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 32 ||
    (env.NODE_ENV === "production" && value !== 1)
  ) {
    throw new Error(
      "AGENT_RUN_ADMISSION_CAPACITY must be exactly 1 in production",
    );
  }
  return value;
}

export function tryAcquireRunAdmission(
  deadline?: ExecutionDeadline,
): () => void {
  deadline?.assertActive("process admission");
  const capacity = resolveAdmissionCapacity();
  if (activeRuns >= capacity) throw new AdmissionCapacityError();
  activeRuns += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRuns = Math.max(0, activeRuns - 1);
  };
}

export function admissionSnapshot(): {
  active: number;
  capacity: number;
  available: number;
} {
  const capacity = resolveAdmissionCapacity();
  return {
    active: activeRuns,
    capacity,
    available: Math.max(0, capacity - activeRuns),
  };
}

export function resetRunAdmissionForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Admission state can only be reset in tests");
  }
  activeRuns = 0;
}
