# Review Vector: Model Capabilities

## Standards
- review.mdc
- javascript.mdc
- please.mdc

## Scope
**Files**: `apps/web/src/lib/ai/**`
**Level**: service

## Context
Model capability mappings define which features each AI model supports, including tool calling, vision, streaming, and extended thinking. These flags drive conditional logic throughout the chat and agent systems, determining whether tools are offered, images are sent, or fallback behavior is triggered. Incorrect capability flags cause silent failures or wasted tokens on unsupported features.
