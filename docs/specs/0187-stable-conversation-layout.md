# Stable conversation layout

Artifact-Version: 1
Status: Implemented

## Intent

The human-approved five-point interaction plan requires stable entry dialogs, one stationary input/progress surface, natural conversation scrolling and removal of the redundant decision notice. Implementation happens in the primary checkout. Contextual suggestions are a separate checked work unit.

## Contract

- Identity selection and character customization share a 66rem maximum width and `min(48rem, 100dvh - 2rem)` height. Headers and actions stay outside the scrolling body. Only content fades; world awakening remains a distinct fullscreen state.
- One participant frame owns input and progress decoration. Its minimum height is 64px; editing can grow with text. Submission freezes the edited height until input returns. Progress changes never remount or move that frame.
- New messages follow the conversation naturally. Reading older messages suspends automatic following; explicit submission and the latest-message control restore it. Optimistic and accepted actions have the same message identity. Footer clearance follows its measured height plus 24px.
- The ordinary decision state contains only the input. Exceptional actionable states retain their explanation and controls. Background updates never reclaim input focus.
- Keyboard operation, small viewports, zoom, forced colors and reduced motion remain supported.

## Plan

Unify dialog geometry and participant frame ownership, remove stage-keyed spatial animations and the decision notice, then exercise the actual browser flow and update the presentation reference.

## Verification

Measure dialog and progress frame rectangles through transitions. Cover multiline submission, manual history scrolling, response growth, optimistic acceptance and focus retention. Run `npm run check:fast` and `npm run check:ui`.

## Evidence

[Conversation visual flows](../../e2e/flows/conversation-visual.spec.ts) measure dialog geometry and retain platform-specific baselines. [Participant flow](../../e2e/flows/immersive-game.spec.ts) checks multiline frame continuity, natural message placement, manual reading position and stable acknowledgement identity. [Accessibility flows](../../e2e/a11y/immersive-game.a11y.spec.ts) cover keyboard, constrained space, forced colors and zoom. `check:fast` and `check:ui` pass.
