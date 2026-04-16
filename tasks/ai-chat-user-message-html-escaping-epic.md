# AI Chat User Message HTML Escaping

**Status**: IN PROGRESS

## Requirements

- Given a user-authored AI chat message that contains tag-shaped text such as `<style>`, `<html>`, or `<iframe>`, should render those characters literally in the message bubble instead of truncating or interpreting them as HTML.
- Given a user-authored AI chat message that contains markdown formatting or page mentions alongside tag-shaped text, should preserve that formatting and mention rendering while still displaying the tag-shaped text literally.
