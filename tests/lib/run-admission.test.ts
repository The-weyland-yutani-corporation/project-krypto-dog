import {
  resetRunAdmissionForTest,
  tryAcquireRunAdmission,
} from "@/lib/run-admission";
import { AdmissionCapacityError } from "@/lib/execution-envelope";

describe("process admission", () => {
  beforeEach(() => {
    resetRunAdmissionForTest();
    process.env.AGENT_RUN_ADMISSION_CAPACITY = "1";
  });
  afterEach(() => {
    delete process.env.AGENT_RUN_ADMISSION_CAPACITY;
  });

  it("rejects excess work and releases idempotently", () => {
    const release = tryAcquireRunAdmission();
    expect(() => tryAcquireRunAdmission()).toThrow(AdmissionCapacityError);
    release();
    release();
    expect(() => tryAcquireRunAdmission()).not.toThrow();
  });
});
