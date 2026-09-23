import { baseIssues, harness, NOW, workBody } from "./fixtures/factory-intake";

const intake = require("../../.github/scripts/agentic-intake-runtime.cjs");

function proposal(h: ReturnType<typeof harness>) {
  const source = h.requireIssue(300);
  return {
    issue: 300,
    body: workBody({ "Acceptance criteria": "A new exact regression oracle." }),
    expected_body: source.body,
    expected_updated_at: source.updated_at,
  };
}

function apply(h: ReturnType<typeof harness>) {
  return intake.applyWorkItemProposal({
    github: h.github, core: h.core, context: h.context(), stage: "pm", now: NOW, proposal: proposal(h),
  });
}

function expectNoEnrollment(h: ReturnType<typeof harness>) {
  expect(h.github.rest.issues.create).not.toHaveBeenCalled();
  expect(h.github.rest.issues.update).not.toHaveBeenCalled();
  expect(h.github.rest.issues.addLabels).not.toHaveBeenCalled();
  expect(h.github.rest.issues.removeLabel).not.toHaveBeenCalled();
  expect(h.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  expect(h.github.request.mock.calls.some(([route]) => route.startsWith("POST "))).toBe(false);
}

describe("native membership is required before PM can materialize work", () => {
  it.each([
    ["external contributor", "untrusted-author", "User", "NONE"],
    ["repository member", "member-author", "User", "MEMBER"],
    ["workflow author", "github-actions[bot]", "Bot", "NONE"],
  ])("does not enroll a parentless %s issue with a matching goal body claim", async (_name, login, type, association) => {
    const issues = baseIssues();
    Object.assign(issues[2], { user: { login, type }, author_association: association });
    const h = harness({ issues, parents: { 300: null } });
    const source = structuredClone(h.requireIssue(300));
    // The writer has all workflow permissions; missing permission is not what protects this boundary.
    const result = await apply(h);
    expect(result).toMatchObject({ ok: false, reasons: expect.arrayContaining(["native-parent-required"]) });
    expect(h.requireIssue(300)).toEqual(source);
    expect(h.parents.get(300)).toBeNull();
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
    expectNoEnrollment(h);
  });

  it("rejects the same exploit through the privileged PM safe-output entry point", async () => {
    const h = harness({ parents: { 300: null } });
    const result = await intake.runIntakeSafeOutput({
      github: h.github, core: h.core, context: h.context(), stage: "pm",
      output: { items: [{ type: "apply_work_item", ...proposal(h) }] },
    });
    expect(result.ok).toBe(false);
    expect(h.core.setFailed).toHaveBeenCalledWith(expect.stringContaining("native-parent-required"));
    expectNoEnrollment(h);
  });

  it("does not use an unreadable native parent as an absent-parent creation path", async () => {
    const h = harness();
    const request = h.github.request.getMockImplementation()!;
    h.github.request.mockImplementation(async (route, params) => {
      if (route.endsWith("/parent")) throw Object.assign(new Error("Parent access denied"), { status: 403 });
      return request(route, params);
    });
    expect(await apply(h)).toMatchObject({ ok: false, reasons: expect.arrayContaining(["native-parent-unknown"]) });
    expectNoEnrollment(h);
  });

  it("rechecks native membership before reservation even when a parent removal leaves issue fields unchanged", async () => {
    const h = harness();
    const get = h.github.rest.issues.get.getMockImplementation()!;
    let sourceReads = 0;
    h.github.rest.issues.get.mockImplementation(async (params) => {
      if (params.issue_number === 300 && ++sourceReads === 2) h.parents.delete(300);
      return get(params);
    });
    expect(await apply(h)).toMatchObject({ ok: false, reasons: ["source-native-parent-unverified"] });
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
    expectNoEnrollment(h);
  });

  it("leaves only a recovery reservation if native membership is revoked during that write", async () => {
    const h = harness();
    const createComment = h.github.rest.issues.createComment.getMockImplementation()!;
    h.github.rest.issues.createComment.mockImplementation(async (params) => {
      const result = await createComment(params);
      h.parents.delete(300);
      return result;
    });
    expect(await apply(h)).toMatchObject({ ok: false, reserved: true, reasons: ["source-native-parent-unverified"] });
    expect(h.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expectNoEnrollment(h);
  });

  it("never links or advances a partial new leaf if source membership disappears during creation", async () => {
    const h = harness();
    const create = h.github.rest.issues.create.getMockImplementation()!;
    h.github.rest.issues.create.mockImplementation(async (params) => {
      const response = await create(params);
      h.parents.delete(300);
      return response;
    });
    const result = await apply(h);
    expect(result).toMatchObject({ ok: false, reserved: true, reasons: ["source-native-parent-unverified"] });
    expect(h.requireIssue(result.createdIssue).labels).toContain("needs-triage");
    expect(h.parents.has(result.createdIssue)).toBe(false);
    expect(h.github.request.mock.calls.some(([route]) => route.startsWith("POST "))).toBe(false);
    expect(h.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(h.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(h.github.rest.issues.create).toHaveBeenCalledTimes(1);
    expect((await apply(h)).ok).toBe(false);
    expect(h.github.rest.issues.create).toHaveBeenCalledTimes(1);
  });

  it("still refines an independently enrolled source without reparenting that source", async () => {
    const h = harness();
    const source = structuredClone(h.requireIssue(300));
    const result = await apply(h);
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.issue).not.toBe(300);
    expect(h.parents.get(result.issue)).toBe(248);
    expect(h.parents.get(300)).toBe(248);
    expect(h.requireIssue(300)).toEqual(source);
    expect(h.github.rest.issues.create).toHaveBeenCalledTimes(1);
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });
});
