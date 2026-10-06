import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentReply } from "./blocks.js";

test("splits text and ui fences into ordered blocks", () => {
  const reply = "Intro\n```ui\n{\"type\":\"callout\",\"tone\":\"warning\",\"text\":\"Cuidado\"}\n```\nCierre";
  const { blocks, text } = parseAgentReply(reply);
  assert.deepEqual(blocks.map((block) => block.type), ["text", "callout", "text"]);
  assert.match(text, /Cuidado/);
});

test("drops invalid or unknown blocks and non-Amazon links", () => {
  const reply = "```ui\n[{\"type\":\"unknown\"},{\"type\":\"actions\",\"items\":[{\"label\":\"x\",\"action\":\"open_url\",\"url\":\"https://evil.example/\"}]}]\n```";
  assert.deepEqual(parseAgentReply(reply).blocks, []);
});

test("keeps the text when the ui JSON is malformed", () => {
  const { blocks } = parseAgentReply("Hola\n```ui\n{not json\n```");
  assert.deepEqual(blocks, [{ type: "text", text: "Hola" }]);
});

test("tool fences are not treated as ui blocks", () => {
  const { blocks } = parseAgentReply("```tool\n{\"name\":\"list_stores\"}\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
});
