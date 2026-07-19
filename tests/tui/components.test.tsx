import React from "react";















import { describe, it } from "node:test";















import assert from "node:assert/strict";















import { render } from "ink-testing-library";















import { createRef } from "react";















import { Box, ScrollBox, Text, useHasSelection, useStdin } from "../../src/tui/ink.js";















import type { ScrollBoxHandle } from "../../src/tui/ink.js";















import instances from "../../src/ink/instances.js";
import CursorDeclarationContext, { type CursorDeclaration } from "../../src/ink/components/CursorDeclarationContext.js";
import { ensureRefableStdin } from "../../src/tui/inkStdin.js";







import { PromptInput } from "../../src/tui/components/PromptInput/PromptInput.js";




























































import { RunLogPanel } from "../../src/tui/components/RunLogPanel.js";















import { WorkflowFlowChart } from "../../src/tui/components/WorkflowFlowChart.js";















import { Select, SelectMulti } from "../../src/tui/components/CustomSelect/index.js";
import type { SelectImageAttachment } from "../../src/tui/components/CustomSelect/index.js";


















import { UserQuestionPrompt } from "../../src/tui/components/UserQuestionPrompt.js";






























import { InteractionArea } from "../../src/tui/components/InteractionArea.js";
import { StatusLine } from "../../src/tui/components/StatusLine.js";















import { jumpMainScrollBy, resolveActiveChoiceCancel, resolveCtrlCBehavior, scrollMainDown, scrollMainUp, TuiApp } from "../../src/tui/TuiApp.js";































describe("PromptInput component", () => {















  it("renders the prompt without a mode prefix", () => {
    const output = render(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={() => undefined}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /> Type a request or \/help/);
    assert.doesNotMatch(frame, /INPUT >/);
    assert.doesNotMatch(frame, /workflow delivery/);
    output.unmount();
    output.cleanup();
  });































  it("renders mode and selection in the statusline", () => {
    const output = render(
      <StatusLine
        mode="input"
        permissionMode="fullAccess"
        workflowId="delivery"
        isLoading={false}
        hasSelection
        elements={["mode", "workflow", "selection"]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /mode Full access/);
    assert.match(frame, /workflow delivery/);
    assert.match(frame, /selection active/);
    output.unmount();
    output.cleanup();
  });

  it("does not show Plan as the mode after workflow execution has started", () => {
    const running = render(
      <StatusLine
        mode="running"
        permissionMode="plan"
        workflowId="delivery"
        isLoading
        hasSelection={false}
        elements={["mode", "workflow"]}
      />
    );

    const runningFrame = running.lastFrame() ?? "";
    assert.match(runningFrame, /mode running/);
    assert.doesNotMatch(runningFrame, /mode Plan/);
    running.unmount();
    running.cleanup();

    const input = render(
      <StatusLine
        mode="input"
        permissionMode="plan"
        workflowId="delivery"
        isLoading={false}
        hasSelection={false}
        elements={["mode", "workflow"]}
      />
    );

    const inputFrame = input.lastFrame() ?? "";
    assert.match(inputFrame, /mode Plan/);
    input.unmount();
    input.cleanup();

    const review = render(
      <StatusLine
        mode="waiting_plan_approval"
        permissionMode="plan"
        workflowId="delivery"
        isLoading={false}
        hasSelection={false}
        elements={["mode", "workflow"]}
      />
    );

    const reviewFrame = review.lastFrame() ?? "";
    assert.match(reviewFrame, /mode Plan Review/);
    review.unmount();
    review.cleanup();
  });



  it("renders an empty shell prompt with placeholder text", () => {















    const output = render(















      <PromptInput















        mode="input"















        workflowId="delivery"















        queued={[]}















        workflows={["delivery"]}















        isLoading={false}















        onEvent={() => undefined}















      />















    );































    const frame = output.lastFrame() ?? "";















    assert.match(frame, />/);















    assert.match(frame, /Type a request or \/help/);















    output.unmount();















    output.cleanup();















  });































  it("does not render a history counter after submitting input", async () => {

    const output = render(

      <PromptInput

        mode="input"

        workflowId="delivery"

        queued={[]}

        workflows={["delivery"]}

        isLoading={false}

        onEvent={() => undefined}

      />

    );



    await sendTuiLine(output, "remember me");



    assert.doesNotMatch(output.lastFrame() ?? "", /history \d+/);

    output.unmount();

    output.cleanup();

  });







  it("applies selectable slash command completions with Tab", async () => {









    const output = render(









      <PromptInput









        mode="input"









        workflowId="delivery"









        queued={[]}









        workflows={["delivery", "audit"]}









        isLoading={false}









        onEvent={() => undefined}









      />









    );



















    output.stdin.write("/r");









    await settleInkInput();




























































































    output.stdin.write("\t");









    await settleInkInput();









    assert.match(output.lastFrame() ?? "", /\/resume /);









    assert.match(output.lastFrame() ?? "", /<session>/);









    output.unmount();









    output.cleanup();









  });

  it("renders AskUserQuestion option previews beside choices", () => {

    const output = render(
      <InteractionArea
        mode="question"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onPromptEvent={() => undefined}
        choice={{
          title: "Which rollout path?",
          selectedValue: "staged",
          options: [
            { label: "Staged", value: "staged", description: "Release gradually", preview: "Phase 1\nPhase 2" },
            { label: "Big bang", value: "big_bang", description: "Release at once", preview: "All users" }
          ],
          onSubmit: () => undefined
        }}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Which rollout path\?/);
    assert.match(frame, /Phase 1/);
    assert.match(frame, /Phase 2/);
    assert.match(frame, /Notes: press n to add notes/);
    assert.doesNotMatch(frame, /Release gradually/);

    output.unmount();
    output.cleanup();

  });

  it("renders AskUserQuestion navigation tabs with tui-code style markers", () => {

    const output = render(
      <InteractionArea
        mode="question"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onPromptEvent={() => undefined}
        choice={{
          title: "Question 2/2: Which verification steps?",
          selectedValue: "unit",
          questionNavigation: {
            questions: [
              { text: "Which rollout path?", header: "Rollout" },
              { text: "Which verification steps?", header: "Verify" }
            ],
            currentIndex: 1,
            answers: { "Which rollout path?": "Staged" }
          },
          options: [
            { label: "Unit tests", value: "unit" },
            { label: "Manual smoke", value: "manual" }
          ],
          onSubmit: () => undefined
        }}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /☒ Rollout/);
    assert.match(frame, /☐ Verify/);
    assert.match(frame, /✓ Submit/);
    assert.doesNotMatch(frame, /\[x\] Rollout/);
    assert.doesNotMatch(frame, />\[ \] Verify</);

    output.unmount();
    output.cleanup();

  });



















  it("closes slash command completions with Escape", async () => {















    const output = render(















      <PromptInput















        mode="input"















        workflowId="delivery"















        queued={[]}















        workflows={["delivery"]}















        isLoading={false}















        onEvent={() => undefined}















      />















    );































    output.stdin.write("/r");















    await settleInkInput();















    assert.match(output.lastFrame() ?? "", /Resume a session/);















    output.stdin.write("\u001b");















    await settleTerminalEscape();















    assert.doesNotMatch(output.lastFrame() ?? "", /Resume a session/);















    assert.match(output.lastFrame() ?? "", /\/r/);















    output.unmount();















    output.cleanup();















  });































  it("keeps mouse reporting out of the prompt buffer", async () => {















    const output = render(















      <PromptInput















        mode="input"















        workflowId="delivery"















        queued={[]}















        workflows={["delivery"]}















        isLoading={false}















        onEvent={() => undefined}















      />















    );































    output.stdin.write("\u001b[<64;12;5M");















    await settleInkInput();















    const frame = output.lastFrame() ?? "";















    assert.doesNotMatch(frame, /64;12;5/);















    assert.match(frame, /Type a request or \/help/);















    output.unmount();















    output.cleanup();















  });






























































  it("resolves Ctrl+C to exit outside active workflow sessions", () => {















    assert.equal(resolveCtrlCBehavior("input", false), "exit");















    assert.equal(resolveCtrlCBehavior("completed", true), "exit");















    assert.equal(resolveCtrlCBehavior("running", true), "confirm_interrupt");
    assert.equal(resolveCtrlCBehavior("planning", true), "confirm_interrupt");
    assert.equal(resolveCtrlCBehavior("waiting_plan_approval", true), "confirm_interrupt");















    assert.equal(resolveCtrlCBehavior("confirm_interrupt", true), "interrupt");



    assert.equal(resolveCtrlCBehavior("input", false, true), "copy_selection");



    assert.equal(resolveCtrlCBehavior("running", true, true), "copy_selection");















  });































  it("resolves Escape for active choices with safe cancellation defaults", () => {















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "permission", permissionRequests: [{ requestId: "perm-1" }] }), { type: "deny_permission", requestId: "perm-1", key: "permission:perm-1" });















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "waiting_plan_approval", pendingReview: { nodeId: "product", attempt: 1 } }), { type: "cancel_plan_approval", key: "plan:product:1" });















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "confirm_interrupt", modeBeforeConfirmation: "running" }), { type: "restore_mode", mode: "running", key: "confirm_interrupt" });















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "confirm_new", modeBeforeConfirmation: "permission" }), { type: "restore_mode", mode: "permission", key: "confirm_new" });















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "confirm_resume", modeBeforeConfirmation: "running", pendingResumeRunId: "run-1" }), { type: "restore_mode", mode: "running", clearPendingResumeRunId: true, key: "confirm_resume:run-1" });















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "resume_picker" }), { type: "restore_mode", mode: "input", clearResumePicker: true, key: "resume_picker" });















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "select_workflow" }), { type: "exit", key: "select_workflow" });















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "select_workflow", workflowId: "delivery" }), { type: "restore_mode", mode: "input", key: "select_workflow" });















    assert.deepEqual(resolveActiveChoiceCancel({ mode: "input" }), { type: "none" });















  });















});































describe("selection hooks", () => {



  it("subscribes to Ink selection changes with bound instance methods", async () => {

    const previous = instances.get(process.stdout);

    const fakeInk = {

      selected: false,

      listeners: new Set<() => void>(),

      hasTextSelection(this: { selected: boolean }) {

        return this.selected;

      },

      subscribeToSelectionChange(this: { listeners: Set<() => void> }, cb: () => void) {

        this.listeners.add(cb);

        return () => this.listeners.delete(cb);

      }

    };



    function SelectionProbe() {

      return <Text>{useHasSelection() ? "selected" : "empty"}</Text>;

    }



    instances.set(process.stdout, fakeInk as never);

    const output = render(<SelectionProbe />);

    try {

      assert.match(output.lastFrame() ?? "", /empty/);



      fakeInk.selected = true;

      for (const listener of fakeInk.listeners) listener();

      await settleInkInput();



      assert.match(output.lastFrame() ?? "", /selected/);

    } finally {

      output.unmount();

      output.cleanup();

      if (previous) instances.set(process.stdout, previous);

      else instances.delete(process.stdout);

    }

  });



});





describe("Workflow node status component", () => {














































  it("renders workflow nodes with model names, English statuses, and an active running border", () => {















    const output = render(















      <WorkflowFlowChart















        workflowNodes={[{ id: "product", role: "product", model: "gpt5.5", effort: "high" }, { id: "dev", role: "developer", model: "claude-dev", effort: "low" }, { id: "test", role: "tester" }]}















        nodes={[{ nodeId: "dev", attempt: 1, status: "running" }, { nodeId: "product", attempt: 1, status: "success" }]}















      />















    );































    const frame = output.lastFrame() ?? "";















    assert.match(frame, /product/);















    assert.match(frame, /model: gpt5\.5 high/);















    assert.match(frame, /done #1/);















    assert.match(frame, /dev/);















    assert.match(frame, /model: claude-dev low/);















    assert.match(frame, /running #1/);















    assert.match(frame, /◝/);















    assert.doesNotMatch(frame, /[◜◞◟]/);















    assert.match(frame, /test/);















    assert.match(frame, /pending/);















    assert.doesNotMatch(frame, /已完成|运行中|等待中/);















    assert.doesNotMatch(frame, /product #1 success/);















    output.unmount();















    output.cleanup();















  });















});














































































































































































function RefableStdinSelectProbe(props: Parameters<typeof Select<string>>[0]) {
  const { stdin } = useStdin();
  ensureRefableStdin(stdin);
  return <Select<string> {...props} />;
}

function RefableStdinSelectMultiProbe(props: Parameters<typeof SelectMulti<string>>[0]) {
  const { stdin } = useStdin();
  ensureRefableStdin(stdin);
  return <SelectMulti<string> {...props} />;
}

it("navigates CustomSelect with tui-code shortcut semantics", async () => {

  const submitted: string[] = [];

  const output = render(

    <RefableStdinSelectProbe

      options={[

        { label: "One", value: "one" },

        { label: "Two", value: "two" },

        { label: "Three", value: "three" }

      ]}

      defaultValue="one"

      onChange={(value) => submitted.push(value)}

    />

  );

  await settleInkInput();

  output.stdin.write("j");
  await settleInkInput();
  assert.match(output.lastFrame() ?? "", /> 2\. Two/);

  output.stdin.write("\u000e");
  await settleInkInput();
  assert.match(output.lastFrame() ?? "", /> 3\. Three/);

  output.stdin.write("k");
  await settleInkInput();
  assert.match(output.lastFrame() ?? "", /> 2\. Two/);

  output.stdin.write("\u0010");
  await settleInkInput();
  assert.match(output.lastFrame() ?? "", /> 1\. One/);

  output.stdin.write("2");
  await settleInkInput();

  assert.deepEqual(submitted, ["two"]);

  output.unmount();
  output.cleanup();

});

it("renders CustomSelect multi-select checkmarks without mutating option labels", async () => {
  const output = render(
    <RefableStdinSelectMultiProbe
      options={[
        { label: "Unit tests", value: "unit" },
        {
          type: "input",
          label: "Other",
          value: "other",
          placeholder: "Other",
          onChange: () => undefined
        }
      ]}
      defaultValue={["unit"]}
      submitButtonText="Submit"
      onSubmit={() => undefined}
    />
  );

  await settleInkInput();
  const frame = output.lastFrame() ?? "";

  assert.match(frame, /\[✓\] Unit tests/);
  assert.match(frame, /\[ \] Other/);
  assert.doesNotMatch(frame, /\[x\]/);

  output.unmount();
  output.cleanup();
});

it("keeps CustomSelect input cursor position across typed updates", async () => {
  let latest = "";
  const submitted: string[] = [];
  const output = render(
    <RefableStdinSelectProbe
      options={[
        {
          type: "input",
          label: "Other",
          value: "other",
          placeholder: "Other",
          onChange: (value) => {
            latest = value;
          }
        }
      ]}
      defaultValue="other"
      onChange={(value) => submitted.push(value)}
    />
  );

  output.stdin.write("abc");
  await settleInkInput();
  output.stdin.write("\u001b[D");
  await settleInkInput();
  output.stdin.write("\u001b[D");
  await settleInkInput();
  output.stdin.write("XY");
  await settleInkInput();
  output.stdin.write("\r");
  await settleInkInput();

  assert.equal(latest, "aXYbc");
  assert.deepEqual(submitted, ["other"]);

  output.unmount();
  output.cleanup();
});

it("declares the native cursor on the CustomSelect input text row", async () => {
  const declarations: CursorDeclaration[] = [];
  const output = render(
    <CursorDeclarationContext.Provider value={(declaration) => {
      if (declaration) declarations.push(declaration);
    }}>
      <RefableStdinSelectProbe
        options={[
          {
            type: "input",
            label: "Other",
            value: "other",
            placeholder: "Other",
            onChange: () => undefined
          }
        ]}
        defaultValue="other"
        onChange={() => undefined}
      />
    </CursorDeclarationContext.Provider>
  );

  output.stdin.write("ab");
  await settleInkInput();

  const afterType = declarations.at(-1);
  assert.equal(afterType?.relativeY, 0);
  assert.equal(afterType?.relativeX, 5);

  output.stdin.write("\u001b[D");
  await settleInkInput();

  const afterLeft = declarations.at(-1);
  assert.equal(afterLeft?.relativeY, 0);
  assert.equal(afterLeft?.relativeX, 4);

  output.unmount();
  output.cleanup();
});

function SelectImageRemovalProbe({ removed }: { removed: number[] }) {
  const [images, setImages] = React.useState<SelectImageAttachment[]>([
    { id: 1, type: "image", media_type: "image/png", data: "one" },
    { id: 2, type: "image", media_type: "image/png", data: "two" }
  ]);
  const { stdin } = useStdin();
  ensureRefableStdin(stdin);
  return (
    <Select<string>
      options={[{
        type: "input",
        label: "Other",
        value: "other",
        placeholder: "Other",
        onChange: () => undefined
      }]}
      defaultValue="other"
      imageAttachments={images}
      onRemoveImage={(id) => {
        removed.push(id);
        setImages((current) => current.filter((image) => image.id !== id));
      }}
      onChange={() => undefined}
    />
  );
}

it("selects and removes CustomSelect input image attachments with tui-code shortcuts", async () => {
  const removed: number[] = [];
  const output = render(<SelectImageRemovalProbe removed={removed} />);

  await settleInkInput();
  assert.match(output.lastFrame() ?? "", /2 images attached/);

  output.stdin.write("\u001b[B");
  await settleInkInput();
  assert.match(output.lastFrame() ?? "", /image 1\/2 selected/);

  output.stdin.write("\u001b[C");
  await settleInkInput();
  assert.match(output.lastFrame() ?? "", /image 2\/2 selected/);

  output.stdin.write("\u007f");
  await settleInkInput();

  assert.deepEqual(removed, [2]);
  assert.match(output.lastFrame() ?? "", /image 1\/1 selected/);

  output.stdin.write("\u001b");
  await settleEscapeInput();
  assert.match(output.lastFrame() ?? "", /1 image attached/);

  output.unmount();
  output.cleanup();
});































describe("UserQuestionPrompt", () => {

  it("renders question text without raw JSON", () => {

    const output = render(<UserQuestionPrompt questions={[{ id: "next_step", text: "用户已暂停当前节点，请输入下一步处理方式。", required: true }]} />);



    const frame = output.lastFrame() ?? "";

    assert.match(frame, /用户已暂停当前节点，请输入下一步处理方式。/);

    assert.doesNotMatch(frame, /User input required/);

    assert.doesNotMatch(frame, /\[\{/);

    assert.doesNotMatch(frame, /"id"/);

    assert.doesNotMatch(frame, /"required"/);

    output.unmount();

    output.cleanup();

  });

  it("renders tui-code style question fields", () => {

    const output = render(<UserQuestionPrompt questions={[{ header: "Rollout", question: "Which rollout path?", options: [{ label: "Staged", description: "Release gradually" }] }]} />);



    const frame = output.lastFrame() ?? "";

    assert.match(frame, /Which rollout path\?/);

    assert.doesNotMatch(frame, /Rollout/);

    assert.doesNotMatch(frame, /\[\{/);

    output.unmount();

    output.cleanup();

  });

});

















































































describe("RunLogPanel", () => {

  it("keeps logs continuous across workflow node transitions", () => {

    const output = render(

      <RunLogPanel

        detailMode={false}

        items={[

          { id: "product-1", kind: "status", nodeId: "product", attempt: 1, text: "product 已完成" },

          { id: "transition-1", kind: "status", text: "流程流转：product -> dev（success）" },

          { id: "dev-1", kind: "assistant", nodeId: "dev", attempt: 1, text: "我继续实现 dev 节点。" }

        ]}

      />

    );



    const frame = output.lastFrame() ?? "";

    assert.match(frame, /product 已完成/);

    assert.match(frame, /流程流转：product -> dev（success）/);

    assert.match(frame, /我继续实现 dev 节点。/);

    assert.ok(frame.indexOf("product 已完成") < frame.indexOf("流程流转：product -> dev（success）"));

    assert.ok(frame.indexOf("流程流转：product -> dev（success）") < frame.indexOf("我继续实现 dev 节点。"));

    output.unmount();

    output.cleanup();

  });

  it("renders plan requested permissions in plan review logs", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        items={[
          {
            id: "plan-1",
            kind: "plan",
            nodeId: "global-plan",
            attempt: 1,
            status: "pending",
            text: "Plan Review",
            document: "# Plan\n\nRun the migration.",
            requestedPermissions: [{ tool: "Bash", prompt: "run tests" }]
          }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Here is Einstein's plan:/);
    assert.match(frame, /⎿  # Plan/);
    assert.match(frame, /Requested permissions:/);
    assert.match(frame, /Bash\(prompt: run tests\)/);

    output.unmount();
    output.cleanup();
  });



















  it("renders compact logs with tui-code style tool rows", () => {















    const output = render(















      <RunLogPanel















        detailMode={false}















        items={[















          { id: "user-1", kind: "user", text: "实现功能" },















          {















            id: "tool-1",















            kind: "tool",















            nodeId: "dev",















            attempt: 1,















            toolCallId: "tool-1",















            tool: "Bash",















            status: "running",















            text: "Bash",















            summary: "npm test",















            detailText: "命令：npm test"















          },















          { id: "status-1", kind: "status", nodeId: "dev", attempt: 1, text: "dev 已完成：实现完成", detailText: "摘要：实现完成" }















        ]}















      />















    );































    const frame = output.lastFrame() ?? "";















    assert.doesNotMatch(frame, /ctrl\+o to expand/i);















    assert.match(frame, /实现功能/);















    assert.match(frame, /●\s+Running npm test/);















    assert.match(frame, /dev 已完成：实现完成/);















    assert.doesNotMatch(frame, /命令：npm test/);















    output.unmount();















    output.cleanup();















  });































  it("renders thinking logs compactly and expands details on demand", () => {



    const compact = render(



      <RunLogPanel



        detailMode={false}



        items={[{ id: "thinking-1", kind: "status", nodeId: "product", attempt: 1, text: "Thinking", detailText: "Checked constraints." }]}



      />



    );



    const compactFrame = compact.lastFrame() ?? "";



    assert.match(compactFrame, /Thinking/);

    assert.doesNotMatch(compactFrame, /● Thinking/);

    assert.doesNotMatch(compactFrame, /正在|生成|处理/);



    assert.doesNotMatch(compactFrame, /Checked constraints/);



    compact.unmount();



    compact.cleanup();







    const detailed = render(



      <RunLogPanel



        detailMode={true}



        items={[{ id: "thinking-1", kind: "status", nodeId: "product", attempt: 1, text: "Thinking", detailText: "Checked constraints." }]}



      />



    );



    const detailedFrame = detailed.lastFrame() ?? "";



    assert.match(detailedFrame, /Thinking/);

    assert.doesNotMatch(detailedFrame, /● Thinking/);

    assert.doesNotMatch(detailedFrame, /正在|生成|处理/);



    assert.match(detailedFrame, /⎿\s+Checked constraints/);



    detailed.unmount();



    detailed.cleanup();



  });







  it("renders detailed logs with message response indentation", () => {















    const output = render(















      <RunLogPanel















        detailMode={true}















        items={[















          {















            id: "tool-1",















            kind: "tool",















            nodeId: "dev",















            attempt: 1,















            toolCallId: "tool-1",















            tool: "Bash",















            status: "completed",















            text: "Bash",















            summary: "npm test",















            detailText: "输出：ok"















          },















          { id: "status-1", kind: "status", nodeId: "dev", attempt: 1, text: "dev completed", detailText: "hidden detail" }















        ]}















      />















    );































    const frame = output.lastFrame() ?? "";















    assert.doesNotMatch(frame, /ctrl\+o to collapse/i);















    assert.match(frame, /●\s+Ran npm test/);















    assert.match(frame, /⎿/);















    assert.match(frame, /输出/);















    // The status log with matching nodeId should be visible

    assert.match(frame, /dev completed/);















    output.unmount();















    output.cleanup();















  });































  it("renders tool rows as assistant message responses when parented", () => {

    const output = render(

      <RunLogPanel

        detailMode={false}

        items={[

          { id: "assistant-1", kind: "assistant", nodeId: "product", attempt: 1, text: "我先运行测试。" },

          { id: "tool-1", kind: "tool", nodeId: "product", attempt: 1, parentLogId: "assistant-1", toolCallId: "tool-1", tool: "Bash", status: "completed", text: "Bash", summary: "npm test", detailText: "输出：ok" }

        ]}

      />

    );

    const frame = output.lastFrame() ?? "";

    assert.match(frame, /我先运行测试/);

    assert.match(frame, /⎿\s+Ran npm test/);

    assert.doesNotMatch(frame, /输出：ok/);

    assert.doesNotMatch(frame, /⎿\s+Bash \(npm test\)/);

    output.unmount();

    output.cleanup();

  });



  it("renders failed tool rows with error details in compact logs", () => {

    const output = render(

      <RunLogPanel

        detailMode={false}

        items={[{ id: "tool-failed", kind: "tool", nodeId: "dev", attempt: 1, toolCallId: "tool-1", tool: "Bash", status: "failed", text: "Bash", summary: "npm test", detailText: "错误：exit 1\n输出：failed tests" }]}

      />

    );



    const frame = output.lastFrame() ?? "";

    assert.match(frame, /Ran npm test/);

    assert.match(frame, /错误：exit 1/);

    assert.doesNotMatch(frame, /输出：failed tests/);

    output.unmount();

    output.cleanup();

  });















});































































describe("InteractionArea", () => {















  it("separates logs from the prompt and aligns prompt with log content", () => {















    const output = render(















      <Box flexDirection="column">















        <RunLogPanel















          detailMode={false}















          items={[{ id: "user-1", kind: "user", text: "实现功能" }]}















        />















        <InteractionArea















          mode="input"















          workflowId="delivery"















          queued={[]}















          workflows={["delivery"]}















          isLoading={false}















          onPromptEvent={() => undefined}















        />















      </Box>















    );































    const lines = (output.lastFrame() ?? "").split("\n");















    const firstLogIndex = lines.findIndex((line) => line.includes("实现功能"));















    const promptIndex = lines.findIndex((line) => line.includes("Type a request or /help"));































    assert.notEqual(firstLogIndex, -1);















    assert.notEqual(promptIndex, -1);















    assert.equal(lines[promptIndex - 1], "");















    assert.equal(lines.some((line) => line.includes("Logs compact") || line.includes("Logs detailed")), false);















    assert.ok(firstLogIndex < promptIndex);















    assert.ok(lines[promptIndex].startsWith(">"));















    output.unmount();















    output.cleanup();















  });
































  it("renders activity status above the prompt when no choice is active", () => {
    const output = render(
      <InteractionArea
        mode="running"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        activityStatus="Working... 12s"
        onPromptEvent={() => undefined}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /- Working[.][.][.] 12s -+/);
    assert.match(frame, /> Type a request or \/help/);
    assert.ok(frame.indexOf("- Working... 12s") < frame.indexOf("> Type a request or /help"));
    const lines = frame.split("\n");
    const statusIndex = lines.findIndex((line) => line.includes("- Working... 12s"));
    const promptIndex = lines.findIndex((line) => line.includes("> Type a request or /help"));
    assert.equal(lines[statusIndex + 1]?.trim(), "");
    assert.equal(promptIndex, statusIndex + 2);

    output.unmount();
    output.cleanup();
  });

  it("keeps activity status out of active choice layouts", () => {
    const output = render(
      <InteractionArea
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        activityStatus="Working... 12s"
        onPromptEvent={() => undefined}
        choice={{
          title: "Ready to code?",
          selectedValue: "yes",
          options: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" }
          ],
          onSubmit: () => undefined
        }}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Ready to code\?/);
    assert.doesNotMatch(frame, /- Working[.][.][.] 12s -+/);

    output.unmount();
    output.cleanup();
  });

  it("can hide an active choice title while keeping actions visible", () => {
    const output = render(
      <InteractionArea
        mode="waiting_plan_review"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onPromptEvent={() => undefined}
        choice={{
          title: "Ready to code?",
          hideTitle: true,
          selectedValue: "yes",
          options: [
            { label: "Yes", value: "yes" },
            { label: "No, keep planning", value: "stay" }
          ],
          hidePromptInput: true,
          onSubmit: () => undefined
        }}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.doesNotMatch(frame, /Ready to code\?/);
    assert.match(frame, /Yes/);
    assert.match(frame, /No, keep planning/);

    output.unmount();
    output.cleanup();
  });

  it("scrolls long choice document blocks while keeping options visible", async () => {
    const output = render(
      <InteractionArea
        mode="waiting_plan_review"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onPromptEvent={() => undefined}
        choice={{
          title: "Ready to code?",
          documentBlock: {
            title: "Here is Einstein's plan:",
            text: Array.from({ length: 20 }, (_, index) => `Step ${String(index + 1).padStart(2, "0")}`).join("\n"),
            maxLines: 5,
            scrollable: true
          },
          selectedValue: "yes",
          options: [
            { label: "Yes", value: "yes" },
            { label: "No, keep planning", value: "stay" }
          ],
          hidePromptInput: true,
          onSubmit: () => undefined
        }}
      />
    );

    assert.match(output.lastFrame() ?? "", /Step 01/);
    assert.match(output.lastFrame() ?? "", /lines below/);
    assert.match(output.lastFrame() ?? "", /No, keep planning/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /PageUp\/PageDown or mouse wheel/);
    assert.match(frame, /No, keep planning/);

    output.unmount();
    output.cleanup();
  });

  it("hides the prompt while a choice is active in the bottom interaction area", () => {















    const output = render(















      <InteractionArea















        mode="permission"















        workflowId="delivery"















        queued={[]}















        workflows={["delivery"]}















        isLoading={true}















        onPromptEvent={() => undefined}















        choice={{















          title: "Permission required",















          detail: "LS .",















          selectedValue: "allow_once",















          options: [















            { label: "Allow once", value: "allow_once", shortcut: "y" },















            { label: "Deny once", value: "deny_once", shortcut: "n" }















          ],















          onSubmit: () => undefined















        }}















      />















    );































    const frame = output.lastFrame() ?? "";















    assert.match(frame, /Permission required/);















    assert.match(frame, /1\. Allow once/);
    assert.doesNotMatch(frame, /1\. Allow once\s+✓/);















    assert.match(frame, /Permission required/);















    assert.doesNotMatch(frame, /Type a request or \/help/);















    output.unmount();















    output.cleanup();















  });















});































describe("TuiApp", () => {















  it("renders missing config guidance", () => {















    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" initialError="Missing agent-team.yaml" />);































    assert.match(output.lastFrame() ?? "", /Missing agent-team.yaml/);















    assert.match(output.lastFrame() ?? "", /Create config\/prompt\.md/);















    output.unmount();















    output.cleanup();















  });































  it("keeps the prompt as the bottom interaction area in the running layout", () => {















    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" workflows={["delivery"]} workflowId="delivery" />);































    const frame = output.lastFrame() ?? "";















    assert.match(frame, /agent-team/);















    assert.match(frame, />/);















    assert.doesNotMatch(frame, /mode input \| Ctrl\+C stop/);















    assert.ok(frame.indexOf("Type a request or /help") > frame.indexOf("workflow delivery"));















    output.unmount();















    output.cleanup();















  });































































  it("shows user input requests only as regular log entries", async () => {

    const session = fakeInteractiveSession({

      runId: "run-question-log",

      workflowId: "delivery",

      events: [

        { type: "node_started", node_id: "product", attempt: 1, ts: "2026-06-24T00:00:00.000Z", seq: 1 },

        {

          type: "node_waiting_user",

          node_id: "product",

          questions: [{ id: "next_step", text: "节点无法继续执行：Node product returned no content and no tool calls", required: true }],

          ts: "2026-06-24T00:00:01.000Z",

          seq: 2

        },

        {

          type: "tool_invoked",

          node_id: "product",

          attempt: 1,

          tool_call_id: "tool-1",

          tool: "Bash",

          input: { command: "npm test" },

          ts: "2026-06-24T00:00:02.000Z",

          seq: 3

        }

      ]

    });

    const engine = { async startInteractive() { return session; } };



    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);



    await sendTuiLine(output, "start work");



    const frame = output.lastFrame() ?? "";

    assert.match(frame, /product 需要用户补充信息：节点无法继续执行：Node product returned no content and no tool calls/);

    assert.doesNotMatch(frame, /User input required/);

    assert.match(frame, /Running npm test/);

    assert.ok(frame.indexOf("节点无法继续执行") < frame.indexOf("Running npm test"));



    output.unmount();

    output.cleanup();

  });









  it("renders assistant preambles and completed command tools in the main transcript", async () => {

    const session = fakeInteractiveSession({

      runId: "run-preamble-tool-log",

      workflowId: "delivery",

      events: [

        { type: "node_started", node_id: "product", attempt: 1, ts: "2026-06-24T00:00:00.000Z", seq: 1 },

        { type: "model_stream_delta", node_id: "product", attempt: 1, text: "我先检查项目结构，再运行测试确认现状。", ts: "2026-06-24T00:00:01.000Z", seq: 2 },

        { type: "tool_invoked", node_id: "product", attempt: 1, tool_call_id: "tool-1", tool: "Bash", input: { command: "npm test" }, ts: "2026-06-24T00:00:02.000Z", seq: 3 },

        { type: "tool_completed", node_id: "product", attempt: 1, tool_call_id: "tool-1", tool: "Bash", result: { output: "ok", exit_code: 0 }, ts: "2026-06-24T00:00:03.000Z", seq: 4 },

        { type: "model_stream_delta", node_id: "product", attempt: 1, text: "{\"direction\":\"forward\",\"summary\":\"done\"}", ts: "2026-06-24T00:00:04.000Z", seq: 5 }

      ]

    });

    const engine = { async startInteractive() { return session; } };



    const output = render(<TuiApp cwd="D:\CodeAI\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);



    await sendTuiLine(output, "分析当前项目架构");



    const frame = output.lastFrame() ?? "";

    assert.match(frame, /我先检查项目结构，再运行测试确认现状。/);

    assert.match(frame, /⎿\s+Ran npm test/);

    assert.doesNotMatch(frame, /status/);

    assert.doesNotMatch(frame, /准备使用 Bash/);

    assert.ok(frame.indexOf("我先检查项目结构") < frame.indexOf("Ran npm test"));



    output.unmount();

    output.cleanup();

  });

  it("toggles transcript mode with Ctrl+O and exits it with Escape", async () => {

    const session = fakeInteractiveSession({

      runId: "run-transcript-toggle",

      workflowId: "delivery",

      events: [

        { type: "node_started", node_id: "product", attempt: 1, ts: "2026-06-24T00:00:00.000Z", seq: 1 },

        { type: "tool_invoked", node_id: "product", attempt: 1, tool_call_id: "tool-1", tool: "Bash", input: { command: "npm test" }, ts: "2026-06-24T00:00:01.000Z", seq: 2 },

        { type: "tool_completed", node_id: "product", attempt: 1, tool_call_id: "tool-1", tool: "Bash", result: { output: "ok", exit_code: 0 }, ts: "2026-06-24T00:00:02.000Z", seq: 3 }

      ]

    });

    const engine = { async startInteractive() { return session; } };

    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);

    await sendTuiLine(output, "run tests");

    assert.match(output.lastFrame() ?? "", /Ran npm test/);
    assert.doesNotMatch(output.lastFrame() ?? "", /输出：ok/);

    output.stdin.write("\u000f");
    await settleInkInput();

    assert.match(output.lastFrame() ?? "", /输出：ok/);

    output.stdin.write("\u001b");
    await settleTerminalEscape();

    assert.match(output.lastFrame() ?? "", /Ran npm test/);
    assert.doesNotMatch(output.lastFrame() ?? "", /输出：ok/);

    output.unmount();
    output.cleanup();

  });



  it("continues the same session from ordinary input after the workflow pauses", async () => {









    let starts = 0;









    const continued: unknown[] = [];









    const session = fakeCompletedSession("run-1", "delivery", "first request", async (input) => {









      continued.push(input);









    });









    const engine = {









      async startInteractive() {









        starts += 1;









        return session;









      }









    };









    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);









    await settleInkInput();



















    await sendTuiLine(output, "first request");









    await sendTuiLine(output, "second request");



















    assert.equal(starts, 1);









    assert.deepEqual(continued, [{ request: "second request", images: [] }]);









    output.unmount();









    output.cleanup();









  });



















  it("starts a new workflow only after /new resets the TUI session", async () => {















    let starts = 0;















    const engine = {















      async startInteractive() {















        starts += 1;















        return fakeCompletedSession(`run-${starts}`, "delivery", `request-${starts}`);















      }















    };















    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);















    await settleInkInput();































    await sendTuiLine(output, "first request");















    await sendTuiLine(output, "/new");















    await sendTuiLine(output, "second request");































    assert.equal(starts, 2);















    output.unmount();















    output.cleanup();















  });































  it("resumes a historical workflow run from /resume", async () => {















    const resumed: string[] = [];















    const engine = {















      async resumeInteractive(_config: unknown, runId: string) {















        resumed.push(runId);















        return fakeCompletedSession(runId, "delivery", "historical request");















      },















      async startInteractive() {















        throw new Error("/resume should not start a new workflow");















      }















    };















    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);















    await settleInkInput();































    await sendTuiLine(output, "/resume run-123");































    assert.deepEqual(resumed, ["run-123"]);















    output.unmount();















    output.cleanup();















  });

















  it("returns to ordinary input after /resume finds no sessions", async () => {

    let starts = 0;

    const engine = {

      async listRuns() {

        return [];

      },

      async startInteractive() {

        starts += 1;

        return fakeCompletedSession("run-empty-resume", "delivery", "fresh request");

      }

    };



    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);

    await settleInkInput();



    await sendTuiLine(output, "/resume");

    assert.match(output.lastFrame() ?? "", /No sessions found/);



    await sendTuiLine(output, "fresh request");



    assert.equal(starts, 1);

    output.unmount();

    output.cleanup();

  });















  it("closes the resume picker immediately after selecting a session", async () => {

    const resumed: string[] = [];

    const engine = {

      async listRuns() {

        return [{ runId: "run-picked", workflowId: "delivery", status: "completed", updatedAt: "2026-06-24T00:00:00.000Z", inputPreview: "historical request" }];

      },

      async resumeInteractive(_config: unknown, runId: string) {

        resumed.push(runId);

        return new Promise(() => undefined);

      }

    };



    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);

    await settleInkInput();



    await sendTuiLine(output, "/resume");

    assert.match(output.lastFrame() ?? "", /Resume workflow run/);



    output.stdin.write("\r");

    await settleInkInput();



    assert.deepEqual(resumed, ["run-picked"]);

    assert.doesNotMatch(output.lastFrame() ?? "", /Resume workflow run/);

    output.unmount();

    output.cleanup();

  });















































  it("keeps resume picker navigation out of the prompt history", async () => {

    const resumed: string[] = [];

    const engine = {

      async startInteractive() {

        return fakeCompletedSession("run-first", "delivery", "first request");

      },

      async listRuns() {

        return [

          { runId: "run-alpha", workflowId: "delivery", status: "completed", updatedAt: "2026-06-24T00:00:00.000Z", inputPreview: "alpha" },

          { runId: "run-beta", workflowId: "delivery", status: "completed", updatedAt: "2026-06-24T00:00:01.000Z", inputPreview: "beta" }

        ];

      },

      async resumeInteractive(_config: unknown, runId: string) {

        resumed.push(runId);

        return fakeCompletedSession(runId, "delivery", "historical request");

      }

    };



    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);

    await settleInkInput();



    await sendTuiLine(output, "first request");

    await sendTuiLine(output, "/resume");

    assert.match(output.lastFrame() ?? "", /> 1\. delivery completed alpha/);



    output.stdin.write("\u001b[A");

    await settleInkInput();

    assert.match(output.lastFrame() ?? "", /> 2\. delivery completed beta/);

    assert.doesNotMatch(output.lastFrame() ?? "", /> \/resume/);

    assert.doesNotMatch(output.lastFrame() ?? "", /> first request/);



    output.stdin.write("\r");

    await settleInkInput();



    assert.deepEqual(resumed, ["run-beta"]);

    assert.doesNotMatch(output.lastFrame() ?? "", /Resume workflow run/);

    output.unmount();

    output.cleanup();

  });







  it("denies the active permission choice once when Escape is pressed", async () => {















    const resolved: Array<[string, "allow_once" | "deny_once"]> = [];















    const session = fakeInteractiveSession({















      runId: "run-permission",















      workflowId: "delivery",















      events: [{















        type: "permission_requested",















        request_id: "perm-1",















        node_id: "dev",















        attempt: 1,















        tool_call_id: "tool-1",















        tool: "PowerShell",















        input: { command: "npm test" },















        specifier: "npm test",















        ts: "2026-06-24T00:00:00.000Z",















        seq: 1















      }],















      permissions: { resolve: (requestId: string, decision: "allow_once" | "deny_once") => resolved.push([requestId, decision]) }















    });















    const engine = { async startInteractive() { return session; } };















    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);































    await sendTuiLine(output, "needs permission");















    output.stdin.write("\u001b");















    await settleTerminalEscape();































    assert.deepEqual(resolved, [["perm-1", "deny_once"]]);















    output.unmount();















    output.cleanup();















  });

  it("exits transcript mode with Escape without denying the active permission", async () => {

    const resolved: Array<[string, "allow_once" | "deny_once"]> = [];

    const session = fakeInteractiveSession({

      runId: "run-permission-transcript-escape",

      workflowId: "delivery",

      events: [{

        type: "permission_requested",

        request_id: "perm-1",

        node_id: "dev",

        attempt: 1,

        tool_call_id: "tool-1",

        tool: "Bash",

        input: { command: "npm test" },

        specifier: "npm test",

        ts: "2026-06-24T00:00:00.000Z",

        seq: 1

      }],

      permissions: { resolve: (requestId, decision) => resolved.push([requestId, decision]) }

    });

    const engine = { async startInteractive() { return session; } };

    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);

    await sendTuiLine(output, "needs permission");

    output.stdin.write("\u000f");
    await settleInkInput();

    output.stdin.write("\u001b");
    await settleTerminalEscape();

    assert.deepEqual(resolved, []);
    assert.match(output.lastFrame() ?? "", /Permission required/);

    output.stdin.write("\u001b");
    await settleTerminalEscape();

    assert.deepEqual(resolved, [["perm-1", "deny_once"]]);

    output.unmount();
    output.cleanup();

  });





  it("aligns selection copying and clearing with tui-code", async () => {
    const previous = instances.get(process.stdout);
    let copied = 0;
    let autoCopied = 0;
    let cleared = 0;
    let exited = 0;
    const fakeInk = {
      selected: false,
      selection: { isDragging: false },
      listeners: new Set<() => void>(),
      hasTextSelection(this: { selected: boolean }) {
        return this.selected;
      },
      subscribeToSelectionChange(this: { listeners: Set<() => void> }, cb: () => void) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
      },
      copySelection(this: { selected: boolean }) {
        copied += 1;
        this.selected = false;
        for (const listener of fakeInk.listeners) listener();
        return "selected text";
      },
      copySelectionNoClear() {
        autoCopied += 1;
        return "selected text";
      },
      clearTextSelection(this: { selected: boolean }) {
        if (!this.selected) return;
        cleared += 1;
        this.selected = false;
        for (const listener of fakeInk.listeners) listener();
      }
    };

    instances.set(process.stdout, fakeInk as never);
    const output = render(
      <TuiApp
        cwd="D:\\CodeAI\\agent-team"
        workflows={["delivery"]}
        workflowId="delivery"
        onExit={() => {
          exited += 1;
        }}
      />
    );

    try {
      output.stdin.write("\u001b[99;9u");
      await settleTerminalEscape();
      assert.equal(copied, 0);
      assert.equal(exited, 0);

      fakeInk.selected = true;
      fakeInk.selection.isDragging = true;
      for (const listener of fakeInk.listeners) listener();
      assert.equal(autoCopied, 0);

      fakeInk.selection.isDragging = false;
      for (const listener of fakeInk.listeners) listener();
      await settleInkInput();
      assert.equal(autoCopied, 1);
      assert.equal(fakeInk.selected, true);
      assert.match(output.lastFrame() ?? "", /selection active/);

      output.stdin.write("\u001b[99;9u");
      await settleTerminalEscape();
      assert.equal(copied, 1);
      assert.equal(exited, 0);
      assert.equal(fakeInk.selected, false);
      assert.doesNotMatch(output.lastFrame() ?? "", /selection active/);

      fakeInk.selected = true;
      for (const listener of fakeInk.listeners) listener();
      await settleInkInput();
      output.stdin.write("x");
      await settleInkInput();
      assert.equal(cleared, 1);
      assert.equal(fakeInk.selected, false);
      assert.match(output.lastFrame() ?? "", /x/);

      fakeInk.selected = true;
      for (const listener of fakeInk.listeners) listener();
      await settleInkInput();
      output.stdin.write("\u0003");
      await settleInkInput();
      assert.equal(copied, 2);
      assert.equal(fakeInk.selected, false);

      fakeInk.selected = true;
      for (const listener of fakeInk.listeners) listener();
      await settleInkInput();
      output.stdin.write("\u001b");
      await settleTerminalEscape();
      assert.equal(cleared, 2);
      assert.equal(fakeInk.selected, false);
      assert.equal(exited, 0);

      fakeInk.selected = true;
      for (const listener of fakeInk.listeners) listener();
      await settleInkInput();
      output.stdin.write("\u001b[1;2D");
      await settleTerminalEscape();
      assert.equal(fakeInk.selected, true);

      output.stdin.write("\u001b[<64;1;1M");
      await settleInkInput();
      assert.equal(cleared, 3);
      assert.equal(fakeInk.selected, false);
    } finally {
      output.unmount();
      output.cleanup();
      if (previous) instances.set(process.stdout, previous);
      else instances.delete(process.stdout);
    }
  });





  it("exits after interrupt confirmation when Ctrl+C is pressed again", async () => {

    let interrupted = 0;

    let exited = 0;

    const session = fakeInteractiveSession({

      runId: "run-interrupt",

      workflowId: "delivery",

      events: [],

      interrupt: () => {

        interrupted += 1;

      }

    });



    const engine = { async startInteractive() { return session; } };

    const output = render(

      <TuiApp

        cwd="D:\\CodeAI\\agent-team"

        config={tuiConfig()}

        workflows={["delivery"]}

        workflowId="delivery"

        engine={engine as unknown as never}

        onExit={() => {

          exited += 1;

        }}

      />

    );



    await sendTuiLine(output, "start work");

    output.stdin.write("\u0003");

    await settleInkInput();

    assert.match(output.lastFrame() ?? "", /Stop current run\?/);



    output.stdin.write("\u0003");

    await settleInkInput();



    assert.equal(interrupted, 1);

    assert.equal(exited, 1);

    output.unmount();

    output.cleanup();

  });







  it("pins configured workflow nodes above the prompt", () => {















    const config = {















      providers: {















        default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } }















      },















      roles: {















        product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } },















        developer: { description: "", system_prompt: "developer", default_model: "gpt5.5", requires: { tool_calling: false, vision: false } }















      },















      workflows: {















        delivery: {















          nodes: [















            { id: "product", role: "product", provider: "default", permission_mode: "default" as const },















            { id: "dev", role: "developer", provider: "default", permission_mode: "default" as const }















          ],















          edges: []















        }















      }















    };















    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={config} workflows={["delivery"]} workflowId="delivery" />);































    const frame = output.lastFrame() ?? "";















    assert.match(frame, /product/);















    assert.match(frame, /dev/);















    assert.match(frame, /pending/);















    assert.match(frame, /model: gpt-test/);















    assert.match(frame, /model: gpt5\.5 medium/);















    assert.doesNotMatch(frame, /Logs compact|Logs detailed/);















    assert.ok(frame.indexOf("product") < frame.indexOf("Type a request or /help"));















    output.unmount();















    output.cleanup();















  });















});































describe("main scroll helpers", () => {















  it("jumps by half pages from the effective pending scroll position", () => {















    const handle = createScrollHandle({ top: 8, pending: 2, height: 20, viewport: 4 });































    assert.equal(jumpMainScrollBy(handle, -3), false);































    assert.deepEqual(handle.calls, [["scrollTo", 7]]);















  });































  it("restores sticky scroll when page jumps reach the bottom", () => {















    const handle = createScrollHandle({ top: 7, pending: 1, height: 12, viewport: 4 });































    assert.equal(jumpMainScrollBy(handle, 3), true);































    assert.deepEqual(handle.calls, [["scrollTo", 8], ["scrollToBottom"]]);















  });































  it("clears pending wheel movement when scrolling above the top", () => {















    const handle = createScrollHandle({ top: 1, pending: -1, height: 12, viewport: 4 });































    scrollMainUp(handle, 3);































    assert.deepEqual(handle.calls, [["scrollTo", 0]]);















  });































  it("restores sticky scroll when wheeling down reaches the bottom", () => {















    const handle = createScrollHandle({ top: 6, pending: 1, height: 10, viewport: 3 });































    assert.equal(scrollMainDown(handle, 2), true);































    assert.deepEqual(handle.calls, [["scrollToBottom"]]);















  });































  it("attaches the ScrollBox imperative handle through React refs", async () => {















    const ref = createRef<ScrollBoxHandle>();















    const output = render(















      <ScrollBox ref={ref} height={3} flexDirection="column">















        <Text>line</Text>















      </ScrollBox>















    );































    await settleInkInput();















    assert.equal(typeof (ref.current as { scrollBy?: unknown } | null)?.scrollBy, "function");















    output.unmount();















    output.cleanup();















  });















});































function tuiConfig() {















  return {















    providers: {















      default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } }















    },















    roles: {















      dev: { description: "", system_prompt: "dev", requires: { tool_calling: false, vision: false } }















    },















    workflows: {















      delivery: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] }















    }















  };















}































function fakeInteractiveSession(input: {















  runId: string;















  workflowId: string;















  events: unknown[];















  permissions?: { resolve(requestId: string, decision: "allow_once" | "deny_once"): void };


  resumeWithUserInput?: (input: unknown) => void | Promise<void>;


  interrupt?: () => void | Promise<void>;















}) {















  const state = { status: "running" as const, workflow_id: input.workflowId, attempts: [], handoff: undefined };















  return {















    runId: input.runId,















    state,















    events: (async function* () {















      for (const event of input.events) yield event;















    })(),















    permissions: {















      resolve: input.permissions?.resolve ?? (() => undefined),















      resolveAll: () => undefined,















      hasPending: () => false















    },















    interrupt: async () => input.interrupt?.(),















    resumeWithUserInput: async (resumeInput: unknown) => input.resumeWithUserInput?.(resumeInput),














    result: new Promise(() => undefined)















  };















}































function fakeCompletedSession(runId: string, workflowId: string, request: string, continueWithInput?: (input: unknown) => void | Promise<void>) {















  const state = { status: "completed" as const, workflow_id: workflowId, attempts: [], handoff: undefined };















  const events = [















    { type: "run_started", workflow_id: workflowId, input: { request }, ts: "2026-06-24T00:00:00.000Z", seq: 1 },















    { type: "run_completed", result: state, ts: "2026-06-24T00:00:01.000Z", seq: 2 }















  ];















  return {















    runId,















    state,















    events: (async function* () {















      for (const event of events) yield event;















    })(),















    permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },















    interrupt: async () => undefined,















    resumeWithUserInput: async () => undefined,














    continueWithInput: async (input: unknown) => continueWithInput?.(input),







    result: Promise.resolve(state)















  };















}































async function sendTuiLine(output: { stdin: { write(value: string): void } }, text: string): Promise<void> {















  output.stdin.write(text);















  await settleTuiWork();















  output.stdin.write("\r");















  await settleTuiWork();















}































function settleTuiWork(): Promise<void> {















  return new Promise((resolve) => setTimeout(resolve, 20));















}































function settleInkInput(): Promise<void> {















  return new Promise((resolve) => setTimeout(resolve, 0));















}

function settleEscapeInput(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}































function settleTerminalEscape(): Promise<void> {















  return new Promise((resolve) => setTimeout(resolve, 35));















}































function createScrollHandle(input: { top: number; pending: number; height: number; viewport: number }) {















  const calls: Array<["scrollTo", number] | ["scrollBy", number] | ["scrollToBottom"]> = [];















  return {















    calls,















    scrollTo: (value: number) => calls.push(["scrollTo", value]),















    scrollBy: (value: number) => calls.push(["scrollBy", value]),















    scrollToBottom: () => calls.push(["scrollToBottom"]),















    getScrollTop: () => input.top,















    getPendingDelta: () => input.pending,















    getScrollHeight: () => input.height,















    getViewportHeight: () => input.viewport















  };















}
