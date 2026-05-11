import assert from "node:assert/strict";
import test from "node:test";

import { parseActionPlan } from "../../src/agent/actionPlanParser.js";

test("parseActionPlan accepts a valid ActionPlan", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Create a docs folder",
      actions: [
        {
          id: "action-1",
          type: "create_folder",
          description: "Create docs",
          path: "docs",
        },
      ],
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.summary, "Create a docs folder");
    assert.equal(result.data.actions[0]?.type, "create_folder");
  }
});

test("parseActionPlan extracts JSON wrapped in assistant text", () => {
  const result = parseActionPlan(`
Here is the plan:
{
  "summary": "Prepare notes",
  "actions": [
    {
      "id": "action-1",
      "type": "create_file",
      "description": "Write notes",
      "path": "notes/today.md",
      "content": "# Notes"
    }
  ]
}
`);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.actions[0]?.type, "create_file");
  }
});

test("parseActionPlan rejects invalid JSON", () => {
  const result = parseActionPlan("{ invalid json }");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_json");
  }
});

test("parseActionPlan rejects an empty response", () => {
  const result = parseActionPlan("   ");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "empty_response");
  }
});

test("parseActionPlan rejects a missing summary", () => {
  const result = parseActionPlan(
    JSON.stringify({
      actions: [],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "missing_summary");
  }
});

test("parseActionPlan rejects missing actions", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Missing actions",
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "missing_actions");
  }
});

test("parseActionPlan rejects unknown action types", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Unknown action",
      actions: [
        {
          id: "action-1",
          type: "compress_file",
          description: "Compress a file",
          path: "docs/readme.md",
        },
      ],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "unknown_action_type");
  }
});

test("parseActionPlan rejects actions missing required fields", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Missing path",
      actions: [
        {
          id: "action-1",
          type: "create_folder",
          description: "Create docs",
        },
      ],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "missing_required_field");
  }
});

test("parseActionPlan rejects empty action arrays", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Nothing to do",
      actions: [],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "empty_actions");
  }
});

test("parseActionPlan rejects unsupported delete actions", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Delete file",
      actions: [
        {
          id: "action-1",
          type: "delete_file",
          description: "Delete secret",
          path: "secret.txt",
        },
      ],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "unknown_action_type");
  }
});

test("parseActionPlan rejects non-object responses", () => {
  const result = parseActionPlan('["not", "an", "object"]');

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "non_object_action_plan");
  }
});

test("parseActionPlan rejects multiple JSON objects in one response", () => {
  const result = parseActionPlan(
    '{"summary":"one","actions":[{"id":"a1","type":"create_folder","description":"one","path":"one"}]}\n{"summary":"two","actions":[{"id":"a2","type":"create_folder","description":"two","path":"two"}]}',
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "multiple_json_objects");
  }
});

test("parseActionPlan accepts generate_word actions", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Create Word draft",
      actions: [
        {
          id: "action-1",
          type: "generate_word",
          description: "Create a proposal draft",
          path: "generated/proposal.docx",
          title: "Proposal",
          sections: [
            {
              heading: "Overview",
              paragraphs: ["Summarize the proposal."],
              bullets: ["Goal", "Scope"],
            },
          ],
        },
      ],
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    const action = result.data.actions[0];
    assert.equal(action?.type, "generate_word");
    if (action?.type === "generate_word") {
      assert.equal(action.sections[0]?.id, "section-1");
      assert.equal(action.sections[0]?.heading, "Overview");
    }
  }
});

test("parseActionPlan accepts generate_powerpoint actions", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Create deck",
      actions: [
        {
          id: "action-1",
          type: "generate_powerpoint",
          description: "Create a kickoff deck",
          path: "generated/kickoff.pptx",
          title: "Kickoff",
          slides: [
            {
              title: "Agenda",
              bullets: ["Background", "Plan"],
              speakerNotes: "Open with context.",
            },
          ],
        },
      ],
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    const action = result.data.actions[0];
    assert.equal(action?.type, "generate_powerpoint");
    if (action?.type === "generate_powerpoint") {
      assert.equal(action.slides[0]?.id, "slide-1");
      assert.deepEqual(action.slides[0]?.bullets, ["Background", "Plan"]);
    }
  }
});

test("parseActionPlan accepts generate_excel actions and validates sample values", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Create workbook",
      actions: [
        {
          id: "action-1",
          type: "generate_excel",
          description: "Create a task tracker",
          path: "generated/tasks.xlsx",
          title: "Tasks",
          sheets: [
            {
              name: "Tasks",
              columns: [
                { header: "Task", valueType: "text" },
                { header: "Done", valueType: "boolean" },
              ],
              sampleRows: [{ Task: "Review", Done: false }],
            },
          ],
        },
      ],
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    const action = result.data.actions[0];
    assert.equal(action?.type, "generate_excel");
    if (action?.type === "generate_excel") {
      assert.equal(action.sheets[0]?.id, "sheet-1");
      assert.equal(action.sheets[0]?.columns[0]?.id, "col-1");
      assert.deepEqual(action.sheets[0]?.sampleRows, [{ Task: "Review", Done: false }]);
    }
  }
});

test("parseActionPlan rejects malformed generate_word sections", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Create Word draft",
      actions: [
        {
          id: "action-1",
          type: "generate_word",
          description: "Create a proposal draft",
          path: "generated/proposal.docx",
          title: "Proposal",
          sections: [{ heading: "Overview", paragraphs: ["ok", 123] }],
        },
      ],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "missing_required_field");
  }
});

test("parseActionPlan rejects malformed generate_excel sample rows", () => {
  const result = parseActionPlan(
    JSON.stringify({
      summary: "Create workbook",
      actions: [
        {
          id: "action-1",
          type: "generate_excel",
          description: "Create workbook",
          path: "generated/tasks.xlsx",
          title: "Tasks",
          sheets: [
            {
              name: "Tasks",
              columns: [{ header: "Task", valueType: "text" }],
              sampleRows: [{ Task: { nested: "bad" } }],
            },
          ],
        },
      ],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "missing_required_field");
  }
});
