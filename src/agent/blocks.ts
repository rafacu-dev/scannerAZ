import { z } from "zod";

/**
 * UI-agnostic reply blocks. The model mixes plain text with ```ui fenced JSON;
 * each client renders the block types it knows and ignores the rest, so new
 * block types can ship without breaking older apps.
 */
const short = z.string().trim().min(1).max(120);
const medium = z.string().trim().min(1).max(600);
const tone = z.enum(["info", "success", "warning", "danger"]);
const appTarget = z.enum(["store", "repricing", "scanner", "inventory", "finances", "more"]);

const textBlock = z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(4000) });
const metricsBlock = z.object({
  type: z.literal("metrics"),
  items: z.array(z.object({ label: short, value: short, hint: short.optional(), tone: tone.optional() })).min(1).max(6)
});
const chartBlock = z.object({
  type: z.literal("chart"),
  chart: z.enum(["bar"]).default("bar"),
  title: short.optional(),
  unit: z.string().trim().max(8).optional(),
  data: z.array(z.object({ label: short, value: z.number().finite() })).min(1).max(12)
});
const tableBlock = z.object({
  type: z.literal("table"),
  title: short.optional(),
  columns: z.array(short).min(1).max(6),
  rows: z.array(z.array(z.union([z.string().max(160), z.number()]).transform(String)).max(6)).min(1).max(20)
});
const choicesBlock = z.object({
  type: z.literal("choices"),
  prompt: medium.optional(),
  options: z.array(z.object({ label: short, value: z.string().trim().min(1).max(300) })).min(1).max(6)
});
const stepsBlock = z.object({
  type: z.literal("steps"),
  title: short.optional(),
  items: z.array(medium).min(1).max(10)
});
const calloutBlock = z.object({
  type: z.literal("callout"),
  tone: tone.default("info"),
  title: short.optional(),
  text: medium
});
const actionsBlock = z.object({
  type: z.literal("actions"),
  items: z.array(z.union([
    z.object({ label: short, action: z.literal("open_app"), target: appTarget }),
    z.object({
      label: short,
      action: z.literal("open_url"),
      url: z.string().url().max(500).refine((url) => /^https:\/\/([a-z0-9-]+\.)*amazon\.(com|com\.mx|ca)\//i.test(url), "Only Amazon links")
    })
  ])).min(1).max(4)
});

export const agentBlockSchema = z.discriminatedUnion("type", [
  textBlock,
  metricsBlock,
  chartBlock,
  tableBlock,
  choicesBlock,
  stepsBlock,
  calloutBlock,
  actionsBlock
]);

export type AgentBlock = z.infer<typeof agentBlockSchema>;

// ```ui (preferred), ```json, or a bare JSON block on its own lines that
// starts with {"type" / [{"type" — models don't always use the right fence.
const fencePattern = /```(?:ui|json)?\s*\n([\s\S]*?)```|^[ \t]*(\[?\s*\{\s*"type"[\s\S]*?\}\s*\]?)[ \t]*$/gm;

/** Splits a model reply into ordered blocks; invalid UI JSON is dropped. */
export function parseAgentReply(reply: string) {
  const blocks: AgentBlock[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    const text = value.replace(/\n{3,}/g, "\n\n").trim();
    if (text) {
      blocks.push({ type: "text", text });
    }
  };

  for (const match of reply.matchAll(fencePattern)) {
    pushText(reply.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;

    try {
      const parsed: unknown = JSON.parse(match[1] ?? match[2] ?? "");
      for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
        const block = agentBlockSchema.safeParse(candidate);
        if (block.success) {
          blocks.push(block.data);
        }
      }
    } catch {
      // Not UI JSON (e.g. a plain code snippet): keep its content as text.
      pushText(match[1] ?? match[2] ?? "");
    }
  }

  pushText(reply.slice(cursor));

  // Plain-text version for history, previews and clients without block support.
  const text = blocks.map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "callout":
        return [block.title, block.text].filter(Boolean).join(": ");
      case "steps":
        return block.items.map((item, index) => `${index + 1}. ${item}`).join("\n");
      case "metrics":
        return block.items.map((item) => `${item.label}: ${item.value}`).join("\n");
      case "choices":
        return [block.prompt, ...block.options.map((option) => `- ${option.label}`)].filter(Boolean).join("\n");
      default:
        return "";
    }
  }).filter(Boolean).join("\n\n");

  return { blocks, text };
}

export const blockProtocolPrompt = `
RICH REPLIES: besides plain text you can add interactive blocks that the app renders natively.
Write normal text, and where a block helps, insert a fenced code block with the language "ui" containing ONE JSON object or an ARRAY of objects.
Use blocks only when they add clarity (numbers, comparisons, lists of steps, options). Keep text short around them.
Available block types (exact keys; strings are plain text, no markdown inside JSON):
- {"type":"metrics","items":[{"label":"Inventory value","value":"$1,240","hint":"58 products","tone":"info|success|warning|danger"}]}  (max 6 items)
- {"type":"chart","chart":"bar","title":"Units to buy","unit":"u","data":[{"label":"Item A","value":12}]}  (max 12 bars, numbers only)
- {"type":"table","title":"...","columns":["SKU","Price","Min"],"rows":[["ABC","$19.99","$15.00"]]}  (max 6 columns, 20 rows)
- {"type":"choices","prompt":"What do you want to check?","options":[{"label":"Repricing","value":"Show my repricing status"}]}  (the value is sent as the user's next message; max 6)
- {"type":"steps","title":"How to request approval","items":["Open Add a Product","Search the ASIN"]}
- {"type":"callout","tone":"warning","title":"Policy risk","text":"..."}
- {"type":"actions","items":[{"label":"Open Repricing","action":"open_app","target":"store|repricing|scanner|inventory|finances|more"},{"label":"Account Health","action":"open_url","url":"https://sellercentral.amazon.com/performance/dashboard"}]}  (urls must be amazon.com/.ca/.com.mx)
Use real numbers from the business data in metrics, charts and tables; never invent data. Write block labels in the user's language.
`.trim();
