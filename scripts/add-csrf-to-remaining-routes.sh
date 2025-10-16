#!/bin/bash

# Script to add CSRF protection to remaining API routes
# This script updates routes that still use old auth patterns

set -e

echo "🔒 Adding CSRF protection to remaining API routes..."

# Define the routes to update
ROUTES=(
  "apps/web/src/app/api/pages/[pageId]/permissions/route.ts"
  "apps/web/src/app/api/pages/[pageId]/agent-config/route.ts"
  "apps/web/src/app/api/channels/[pageId]/messages/route.ts"
  "apps/web/src/app/api/ai/chat/route.ts"
  "apps/web/src/app/api/ai/settings/route.ts"
  "apps/web/src/app/api/ai/tasks/[taskId]/status/route.ts"
  "apps/web/src/app/api/settings/notification-preferences/route.ts"
  "apps/web/src/app/api/agents/consult/route.ts"
  "apps/web/src/app/api/connections/route.ts"
  "apps/web/src/app/api/connections/[connectionId]/route.ts"
  "apps/web/src/app/api/contact/route.ts"
  "apps/web/src/app/api/debug/chat-messages/route.ts"
  "apps/web/src/app/api/files/[id]/convert-to-document/route.ts"
  "apps/web/src/app/api/messages/[conversationId]/route.ts"
  "apps/web/src/app/api/messages/conversations/route.ts"
  "apps/web/src/app/api/pages/[pageId]/reprocess/route.ts"
  "apps/web/src/app/api/permissions/batch/route.ts"
  "apps/web/src/app/api/storage/check/route.ts"
  "apps/web/src/app/api/stripe/portal/route.ts"
  "apps/web/src/app/api/track/route.ts"
  "apps/web/src/app/api/trash/[pageId]/route.ts"
  "apps/web/src/app/api/trash/drives/[driveId]/route.ts"
  "apps/web/src/app/api/admin/users/[userId]/subscription/route.ts"
)

update_count=0
skip_count=0

for route in "${ROUTES[@]}"; do
  file="$route"

  # Check if file exists
  if [ ! -f "$file" ]; then
    echo "⚠️  Skipping $file (not found)"
    ((skip_count++))
    continue
  fi

  # Check if already updated (has requireCSRF)
  if grep -q "requireCSRF" "$file"; then
    echo "✅ Already updated: $file"
    ((skip_count++))
    continue
  fi

  # Check if uses old auth pattern
  if ! grep -q "authenticateWebRequest\|verifyAuth\|decodeToken" "$file"; then
    echo "✅ No auth update needed: $file"
    ((skip_count++))
    continue
  fi

  echo "🔄 Updating: $file"

  # Create backup
  cp "$file" "$file.backup"

  # Update imports - handle multiple patterns
  if grep -q "import.*authenticateWebRequest" "$file"; then
    sed -i.tmp "s/import { authenticateWebRequest, isAuthError }/import { authenticateRequestWithOptions, isAuthError }/g" "$file"
  fi

  if grep -q "import.*verifyAuth" "$file"; then
    sed -i.tmp "s/import { verifyAuth }/import { authenticateRequestWithOptions, isAuthError }/g" "$file"
    sed -i.tmp "s/import { decodeToken }/import { authenticateRequestWithOptions, isAuthError }/g" "$file"
  fi

  # Add AUTH_OPTIONS constant after imports (before first export)
  if ! grep -q "const AUTH_OPTIONS" "$file"; then
    sed -i.tmp "/^export async function/i\\
const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };\\
" "$file"
  fi

  # Update auth calls
  sed -i.tmp "s/authenticateWebRequest(request)/authenticateRequestWithOptions(request, AUTH_OPTIONS)/g" "$file"

  # Clean up temp files
  rm -f "$file.tmp"

  ((update_count++))
done

echo ""
echo "✅ Update complete!"
echo "   Updated: $update_count files"
echo "   Skipped: $skip_count files"
echo ""
echo "⚠️  IMPORTANT: Manual review required for:"
echo "   1. Routes using verifyAuth() - need manual userId extraction"
echo "   2. Routes using decodeToken() - need manual conversion"
echo "   3. Variable naming conflicts (user vs userId)"
echo ""
echo "📝 Next steps:"
echo "   1. Review each updated file"
echo "   2. Test the routes"
echo "   3. Run TypeScript checks: pnpm typecheck"
echo "   4. Remove backup files: find . -name '*.backup' -delete"
