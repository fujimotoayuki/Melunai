# Melunai UIUX Direction

## Product Identity

Melunai is not a clone of ChatGPT, Claude, or a conventional left-sidebar chat app.
It is a local AI workspace: a quiet, premium Mac-like surface where an assistant
appears only when useful, understands local context, and turns files into work.

The target feeling is:

- premium Mac application
- restrained JARVIS-like assistant
- dark, cinematic workspace
- calm at rest, dense during work
- understandable without instructions

## Visual Direction

- Base background: `#1D1D1F`
- Text: white and soft gray
- Accent: refined blue-green gradient inspired by Apple's M-series visual language
- Avoid cheap AI-template gradients, dated dashboards, and noisy card piles
- Use blur, depth, and soft translucency carefully
- Prefer fewer, more meaningful surfaces over many stacked panels

## Interaction Principles

1. The first screen should be quiet.
   The user should see an empty workspace and a compact input dock, not a busy dashboard.

2. Chat is not the permanent center.
   Chat appears as a floating panel when needed. The workspace, canvas, context, or result can become the main focus.

3. Modes should be invisible when possible.
   Users should not need to choose "document mode" or "multi-file reading mode". The UI may expose controls, but the product should feel like one assistant.

4. Context must be visible, not noisy.
   Show small chips for active Corpus/MCP/context states. Open deeper maps only when needed.

5. Density should respond to work.
   Idle state is sparse. During file/context work, panels can become denser like TradingView, but only where the task benefits.

6. Motion should communicate state.
   Use fade, blur, slide-up, magnetic docking, panel expansion, and subtle depth. Avoid heavy animation that hurts performance.

## Layout System

### Idle

- Full dark workspace
- Top bar with brand, model, Corpus, MCP, settings
- Compact input dock near bottom center
- No permanent left file sidebar
- No large chat transcript unless opened

### Chat

- Chat opens as a floating panel from the lower-right area
- The input dock remains the main command surface
- Chat can be dismissed/minimized without losing history

### Canvas

- When Canvas is active, it can take the left workspace area
- Chat remains on the right as a working companion
- Split ratio remains resizable

### Context Layer

Use three layers instead of a permanent file tree:

1. Context chips: always small, showing active references
2. Search palette: invoked when choosing local context
3. Dense inspector: opened only when deep inspection is useful

## Corpus2Skill UX

Corpus2Skill is primarily an assistant-side navigation map.

- Default display: small "Corpus" active chip
- During response: show what branch/document was used
- Full map view: available from the Corpus panel
- It should help small LLMs avoid reading unnecessary files

## MCP UX

- MCP setup remains in a dedicated panel
- Connected tools may appear as small icons/chips
- Tool calls should not be noisy
- Chat auto-tool use should be introduced carefully and with clear visibility

## Animation Rules

Use:

- fade + blur for panel entry
- slide-up for command dock expansion
- magnetic/docked feeling for floating panels
- card expansion for details
- subtle depth and scale

Avoid:

- decorative orbs
- random bokeh
- constant motion
- animations that make local LLM latency feel worse

## Anti-Patterns

- dated financial-site UI
- Microsoft-account style hidden complexity
- generic AI landing-page gradients
- permanent left file tree as the default mental model
- explanation-heavy onboarding
- mode buttons that the assistant could infer

## Implementation Phases

1. Establish quiet workspace and compact command dock.
2. Move chat transcript into a floating assistant panel.
3. Keep Canvas as a left workspace when active.
4. Add context chips for Corpus/MCP/model/workspace state.
5. Add command/search palette for file/context selection.
6. Add dense inspector only for deep context review.
7. Integrate Corpus2Skill and MCP into chat responses with visible context.
