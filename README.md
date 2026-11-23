# promptc

> [!WARNING]
> **Not yet reviewed or tested by a human.** This code was written with AI
> assistance. It has an automated test suite, but no person has reviewed the
> code or tested it by hand. Treat it as experimental: read the code before
> relying on it, and don't use it in production without your own review.

Add basic logic to your prompts (variables, if/else, loops) so an AI
agent only sees the instructions that apply to the situation in front of it.

## The idea

Most prompts are still written as freeform blocks of text. Every case you
can think of goes into one big prompt, and the model has to work out which
parts apply.
That makes prompts long and results inconsistent: the model may follow the
wrong instruction, blend two together, or miss one.

promptc adds basic logic to prompts. You map out the possible
scenarios **once**, in the template: what to say to an enterprise customer,
a trial customer, someone with a billing question, and so on. Your code
already knows the facts (which plan the customer is on, what language they
speak, what an earlier step found), so the program works out which scenario
applies and sends the model only the details that matter.

The deciding happens in your code, cheaply and the same way every time,
instead of inside the model on every call. That means:

- **Less for the model to sort out.** It doesn't have to read every case,
  keep them all in mind, and reason about which one applies. That decision
  is already made, so it's left with just the relevant details.
- **Clearer instructions.** With no "other options" in the prompt, there's
  nothing to choose between or mix up. The model knows exactly what's being
  asked of it.
- **Lower token spend.** Shorter prompts cost fewer input tokens, and less
  deciding means less reasoning output too. The savings repeat on every
  call.
- **Deterministic.** The same inputs always produce the same prompt.
- **Specific.** You write exact instructions for exact scenarios, rather
  than a tangle of "if this, do that, unless..." for the model to untangle.
- **More reliable.** Less to interpret means fewer wrong turns, so AI
  generative and agentic experiences come out more accurate.

Because the logic is code, it can also be checked. A misspelled variable or
missing piece of data stops the prompt from being built, instead of quietly
sending the model a prompt with a blank in it.

## Example

A support agent's prompt:

```twig
You are a support agent for {{ company.name }}. Reply in {{ customer.language }}.

{% if customer.plan == 'enterprise' %}
This customer has a dedicated account manager, {{ customer.accountManager }}.
Offer to bring them into the conversation.
{% elseif status.isTrial %}
This customer is on a free trial with {{ customer.trialDaysLeft }} days left.
If it fits naturally, mention what the paid plan adds.
{% else %}
Point the customer to the help center for self-serve answers first.
{% endif %}

{% if ticket.category == 'billing' %}
@include("policies/refunds.md#eligibility")
{% endif %}
```

For a billing question from a trial customer, the agent gets the trial
paragraph and the refund-eligibility section of the policy doc. It never
sees the enterprise instructions, the help-center line, or the rest of the
refund policy. `status.isTrial` is a *computed property*: a condition
defined once (`"customer.plan == 'trial'"`) and reused across prompts by name.

## Example: visual styling

The same idea works for design instructions. One template covers dark and
light sites, on mobile and desktop:

```twig
Design the hero section of {{ site.name }}'s landing page.

{% if look.isDark %}
Use a dark background ({{ look.palette.background }}) with light text ({{ look.palette.text }}).
{% else %}
Use a light background ({{ look.palette.background }}) with dark text ({{ look.palette.text }}).
{% endif %}
Use {{ colors.accent }} for the main button, and nowhere else.

{% if site.device == 'mobile' %}
Stack the headline, text and button in a single column. Keep the headline under 6 words.
{% else %}
Put the headline and text on the left, and a product image on the right.
{% endif %}
{% if site.buttonLabel is defined %}
The button says "{{ site.buttonLabel }}".
{% endif %}
```

The colors are set up once, and two computed properties pick the right set:

```ts
const engine = createEngine({
  namespaces: {
    colors: {
      kind: "static",
      data: {
        accent: "#FF5A1F",
        dark:  { background: "#111827", text: "#F9FAFB" },
        light: { background: "#FFFFFF", text: "#111827" },
      },
    },
    site: { kind: "runtime" },
    look: {
      kind: "computed",
      rules: {
        isDark:  "site.theme == 'dark'",
        palette: "look.isDark ? colors.dark : colors.light", // returns a whole color set
      },
    },
  },
});
```

With `site` set to `{ name: "Acme", theme: "dark", device: "mobile", buttonLabel: "Start free" }`,
the model sees:

```text
Design the hero section of Acme's landing page.

Use a dark background (#111827) with light text (#F9FAFB).
Use #FF5A1F for the main button, and nowhere else.

Stack the headline, text and button in a single column. Keep the headline under 6 words.
The button says "Start free".
```

With `{ name: "Acme", theme: "light", device: "desktop" }` and no button
label, the model sees:

```text
Design the hero section of Acme's landing page.

Use a light background (#FFFFFF) with dark text (#111827).
Use #FF5A1F for the main button, and nowhere else.

Put the headline and text on the left, and a product image on the right.
```

The model is never told "if the site is dark, use these colors, otherwise
use those". It gets one set of colors and one layout, already decided.

Templates use [Twig](https://twig.symfony.com/doc/3.x/templates.html)
syntax. Putting logic in prompt templates isn't a new idea, and several
good tools already do it (see [Related projects](#related-projects)). What
promptc focuses on is **checking**: computed properties defined once, every
variable checked against your data before anything is sent, and strict
rendering that refuses to send a prompt with gaps in it.

---

## What you get

| | |
|---|---|
| **Twig templating** | `{{ var }}`, `{% if %}/{% elseif %}`, `{% for %}`, filters (`upper`, `length`, `join`, `default`, ...), `~` concatenation, `in`, ternaries. Output is never HTML-escaped. |
| **Namespaces** | Variables live in named buckets: **static** (known up front), **runtime** (supplied per render), **computed** (derived). |
| **Computed properties** | Name a condition once (`status.isTrial`) instead of repeating a long comparison in every prompt. Rules are Twig expressions, evaluated in order, and keep real types (booleans, numbers, strings, arrays). |
| **Composition** | `@include("file.md")`, plus single sections (`#eligibility`), lists (`#eligibility,exceptions`) and ranges (`#eligibility..exceptions`) by heading. JSON/YAML files get fenced. Nested includes work. Cycles and paths outside the root are rejected. |
| **Static checks** | Every variable reference is parsed with twig.js's own parser (not regexes) and checked against your data, with did-you-mean hints. Runtime data is checked against a mock of its shape. |
| **Strict render** | `render()` refuses, with a list of every problem, instead of printing blanks for missing data. It only checks the branches that actually run, and values can be marked optional with `is defined`, `\|default(...)` or `??`. |
| **CLI** | `check` for CI, `render`, `computed` to inspect derived values, `refs` to list what a template reads. |

## Install

```bash
npm install promptc
```

Node 18.17+. Its only runtime dependency is [`twig`](https://github.com/twigjs/twig.js).

## Quick start (library)

```ts
import { createEngine } from "promptc";

const engine = createEngine({
  namespaces: {
    // Known up front.
    company: { kind: "static", data: { name: "Acme" } },

    // Supplied per request. The shape is an example used to check templates
    // before any real data exists.
    customer: {
      kind: "runtime",
      shape: { language: "English", plan: "trial", trialDaysLeft: 7, accountManager: "Sam" },
    },
    ticket: { kind: "runtime", shape: { category: "billing" } },

    // Conditions defined once, reused by name.
    status: {
      kind: "computed",
      rules: {
        isTrial:      "customer.plan == 'trial'",
        isEndingSoon: "status.isTrial and customer.trialDaysLeft <= 3",
      },
    },
  },
  includeRoot: "./prompts", // @include paths resolve here and may not leave it
});

// 1. Check templates at build/CI time. Nothing is rendered.
const result = engine.check({ "support.md": template });
if (!result.ok) console.error(result.diagnostics);

// 2. Render at request time with live data. Throws GuardrailError on any problem.
const prompt = engine.render(template, {
  data: { customer: await getCustomer(id), ticket },
});
```

## Quick start (folder + CLI)

Put each namespace in a JSON file and list them in a manifest:

```
my-prompts/
  vars/
    manifest.json        { "static": ["company"], "runtime": ["customer"], "computed": ["status"] }
    company.json         static data
    customer.mock.json   example shape of the runtime data (optional, enables key checks)
    customer.json        live runtime data (optional; re-read on every render)
    status.json          computed rules
  prompts/
    support.md
  policies/
    refunds.md           @include targets
```

```bash
npx promptc check my-prompts/prompts --vars my-prompts/vars
npx promptc render my-prompts/prompts/support.md --vars my-prompts/vars --data customer=customer.json
npx promptc computed --vars my-prompts/vars --data customer=customer.json
```

```ts
import { createEngineFromDir } from "promptc";
const engine = createEngineFromDir("my-prompts/vars", { includeRoot: "my-prompts" });
```

If there is no `manifest.json`, every `*.json` file (except `*.mock.json`) is
treated as a static namespace.

A working example is in [`examples/support-agent`](examples/support-agent). Run it with `npm run example`.

---

## Namespaces

| kind | Data comes from | Checked statically | Checked at render |
|---|---|---|---|
| `static` | `data` (or `<ns>.json`) | every key | every key |
| `runtime` | `render(..., { data })`, else `load()` (or `<ns>.json` on disk) | against `shape` / `<ns>.mock.json` if given; otherwise anything under the namespace is allowed | every unguarded key against the live data |
| `computed` | evaluated from the other namespaces on each render | rule names | rule names |

Namespace names must be plain identifiers that aren't Twig keywords. Data
keys with hyphens produce a `VAR_HYPHEN` warning, because `{{ labels.sign-in }}`
parses as subtraction. Use camelCase, or bracket syntax (`labels['sign-in']`).

## Computed properties

A computed namespace maps names to **Twig expression strings**:

```json
{
  "isTrial":         "customer.plan == 'trial'",
  "trialEndingSoon": "status.isTrial and customer.trialDaysLeft <= 3",
  "isPriority":      "customer.plan in ['business', 'enterprise']",
  "openTicketCount": "customer.openTickets|length",
  "summary":         "'Plan: ' ~ customer.plan ~ ' · Category: ' ~ ticket.category",
  "upgradeNote":     "'Mention the annual plan discount if the customer asks about pricing.'"
}
```

- **Order matters.** Rules evaluate top to bottom. A rule may use rules
  above it (`status.isTrial`) and computed namespaces declared before it.
  Forward and self references are `COMPUTED_FORWARD_REF`, so evaluation is
  always acyclic and deterministic.
- **Values keep their types.** `true`/`false`, numbers, strings, arrays,
  objects. `engine.evaluateComputed(data)` (or the `computed` CLI command)
  shows exactly what each rule produced.
- **Literal text must be quoted** inside the expression (`"'...'"`). Bare
  prose parses as variable names and fails the check with a hint saying so.
- **Missing inputs are falsy, not fatal.** If `customer` hasn't been
  loaded yet, `status.isTrial` is `false`. Computed rules are for
  routing, and strict checks apply to the templates that read them.
- **Pair routers with rationale.** The model only sees the branch that was
  taken, so consider surfacing a `summary` or note string so the rendered
  prompt explains itself.

## Optional values

Strict rendering only looks at the parts of the template that actually run.
A value used only inside a branch that isn't taken (like the enterprise
account manager for a trial customer) doesn't need to exist. Inside a
branch that *does* run, a missing value is an error, unless the template
marks it optional:

```twig
{{ customer.nickname|default(customer.name) }}
{{ ticket.orderId ?? 'no order number given' }}
{% if ticket.attachments is defined %}Attached: {{ ticket.attachments|join(', ') }}{% endif %}
```

Inside `{% if x is defined %}`, `x` and everything under it is treated as
present. Pass `strict: false` (engine or per render), or `--no-strict`, to
get plain Twig behavior where missing values print as empty.

## Includes

```text
@include("policies/refunds.md")                          whole file (trimmed)
@include("policies/refunds.md#eligibility")              that heading and its subsections
@include("policies/refunds.md#eligibility,exceptions")   several sections, joined by a blank line
@include("policies/refunds.md#eligibility..exceptions")  inclusive range of sections
@include("config/example.json")                          wrapped in a ```json fence
```

Heading slugs are lowercased, with punctuation removed and spaces turned into
hyphens (`## Returns & Exchanges` → `#returns-exchanges`). Includes resolve before
Twig runs, so included files can use variables and their own `@include`s.
Paths resolve against `includeRoot`. Absolute paths, `..` escapes and
symlinks that point outside the root are refused, so an untrusted template
can't read arbitrary files. Line numbers in diagnostics refer to the
template after includes are expanded.

## Diagnostics

Every problem has a stable `code`, a `severity`, and usually a `hint`:

```
error VAR_UNRESOLVED prompts/support.md:1
  company.escalation.emial does not exist: company.escalation has no key "emial"
  hint: Did you mean company.escalation.email?
error RUNTIME_NOT_PROVIDED prompts/support.md:2
  No data was provided for runtime namespace "customer" (needed by customer.language)
  hint: Pass render(..., { data: { customer: ... } }), or guard it with {% if customer is defined %}
```

| Code | Severity | Meaning |
|---|---|---|
| `TEMPLATE_SYNTAX` | error | Template doesn't parse |
| `VAR_UNKNOWN_NAMESPACE` | error (warning if guarded) | Root isn't a declared namespace |
| `VAR_UNRESOLVED` | error | Key doesn't exist in static data, the runtime shape, or the computed rules |
| `VAR_MISSING_AT_RENDER` | error | Key missing from the live data at render |
| `RUNTIME_NOT_PROVIDED` | error | Template needs a runtime namespace that has no data |
| `RUNTIME_UNDECLARED` | error | `render()` got data for an undeclared namespace |
| `VAR_HYPHEN` | warning / error | Hyphenated data key (warning) or computed rule name (error) |
| `NAMESPACE_INVALID` | error | Bad, reserved or duplicate namespace name |
| `COMPUTED_NOT_STRING` | error | Rule value isn't an expression string |
| `COMPUTED_SYNTAX` | error | Rule expression doesn't parse |
| `COMPUTED_FORWARD_REF` | error | Rule uses a rule defined after it, or itself |
| `COMPUTED_EVAL_ERROR` | warning | Rule threw while evaluating (value becomes `undefined`) |
| `UNUSED_COMPUTED` | warning | No checked template or rule uses this rule |
| `INCLUDE_NOT_FOUND` / `INCLUDE_FRAGMENT_NOT_FOUND` | error | Missing file / heading (the hint lists the available headings) |
| `INCLUDE_OUTSIDE_ROOT` / `INCLUDE_CYCLE` / `INCLUDE_DEPTH` | error | Unsafe or runaway includes |
| `CONFIG_INVALID` | error | Bad vars folder, manifest or JSON |

`UNUSED_COMPUTED` only makes sense when `check()` sees **all** your
templates. Pass `{ reportUnused: false }` (or `--no-unused`) when checking a
subset.

## CLI

```
promptc check <file|dir>... --vars <dir> [--include-root <dir>] [--json] [--warnings-as-errors] [--no-unused]
promptc render <file> --vars <dir> [--data ns=file.json]... [--out <file>] [--no-strict] [--json]
promptc computed --vars <dir> [--data ns=file.json]... [--json]
promptc refs <file> [--json]
```

- `--include-root` defaults to the parent folder of `--vars`.
- `check` scans directories recursively for `.md .txt .twig .prompt .tpl`.
- Exit codes: `0` ok · `1` check or render failed · `2` usage or config error.

## API

| Export | Purpose |
|---|---|
| `createEngine(options)` / `new PromptEngine(options)` | Build an engine from namespace declarations |
| `createEngineFromDir(dir, options?)` / `loadVarsDir(dir)` | Same, from a vars folder |
| `engine.check(templates, { reportUnused })` | Static check → `{ ok, diagnostics, references }` |
| `engine.checkTemplate(source, name?)` | Check one template |
| `engine.render(source, { data, name, strict })` / `engine.renderFile(path, opts)` | Render, or throw `GuardrailError` |
| `engine.evaluateComputed(data?)` | `{ values, diagnostics }` for all computed namespaces |
| `engine.context(data?)` | The full merged render context |
| `engine.configDiagnostics` | Problems with the declarations themselves |
| `extractReferences(source)` / `extractPaths(source)` | What a template reads (with `guarded` and `line`) |
| `expandIncludes(source, { root })`, `extractMarkdownSections(md, fragment)` | Composition on its own |
| `evaluateExpression(expr, context)` | Evaluate one Twig expression to a typed value |
| `GuardrailError`, `formatDiagnostics`, `hasErrors` | Error handling |

## Limits

- Twig support is whatever [twig.js](https://github.com/twigjs/twig.js) 3.x
  supports. `{% include %}`/`{% extends %}` of other templates is disabled;
  use `@include` instead.
- Reference checking is static. A dynamic key (`a[b]`) checks `a` and `b`,
  but not what `a[b]` resolves to.
- `??` / `?:` guard detection covers the common `x ?? fallback` form. For
  anything more complex, use `is defined` or `|default`.
- twig.js evaluates both sides of an inline ternary (`a ? b.c : d`), so
  `b.c` is checked even when `a` is false. Put branch-specific data in
  `{% if %}` blocks instead.
- If the same path is read with a guard in one place and without one in
  another, a miss from the guarded read still counts as an error. This
  errs on the side of caution.
- twig.js registers filters globally. This library adds one private filter
  (`__promptcCapture`) to read expression values.

## Related projects

Logic in prompts is a well-established approach. If one of these fits
your stack better, use it:

- [POML](https://github.com/microsoft/poml) (Microsoft): an HTML-like
  markup language for prompts, with variables, loops and conditionals.
- [Dotprompt](https://google.github.io/dotprompt/) (Google): Handlebars-based
  prompt files with front-matter config and input schemas, used by Firebase
  Genkit.
- [BAML](https://github.com/boundaryml/baml): typed prompt functions with
  Jinja templates and structured, type-checked outputs.
- [Prompt Poet](https://github.com/character-ai/prompt-poet) (Character.AI):
  YAML plus Jinja2 templates, with truncation to fit token limits.
- [Priompt](https://github.com/anysphere/priompt) (Anysphere) and
  [prompt-tsx](https://code.visualstudio.com/api/extension-guides/prompt-tsx)
  (Microsoft): JSX prompts that drop low-priority content to fit a token
  budget.
- Template support in [LangChain](https://docs.langchain.com/langsmith/prompt-template-format)
  and [Semantic Kernel](https://learn.microsoft.com/en-us/semantic-kernel/concepts/prompts/jinja2-prompt-templates)
  (Jinja2, Mustache, Handlebars).

Where promptc differs: it's a small, framework-free library and CLI for
plain-text templates, and it puts the emphasis on catching mistakes before
a prompt is sent: computed properties, reference checks against data and
mocks with did-you-mean hints, branch-aware strict rendering, and
markdown-section includes.

## Development

```bash
npm install
npm test          # node:test via tsx
npm run typecheck
npm run build     # → dist/
npm run example   # render the example brief
```
