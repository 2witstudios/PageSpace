#!/bin/bash

# Script to complete CSRF implementation for remaining routes
# This script provides commands to update each remaining route

BASE_DIR="/Users/jono/production/PageSpace/apps/web/src/app/api"

echo "==================================================================="
echo "CSRF Protection - Remaining Routes Conversion Commands"
echo "==================================================================="
echo ""
echo "36 routes still need conversion from inline auth to AUTH_OPTIONS."
echo ""
echo "For each route below, use the Edit tool to:"
echo "1. Add: import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';"
echo "2. Add: const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };"
echo "3. Replace inline auth with: const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);"
echo "4. Replace user.id/decoded.userId with userId"
echo ""
echo "==================================================================="
echo ""

cat << 'EOF'
Routes to convert:

1. Admin Routes (1):
   - $BASE_DIR/admin/users/[userId]/subscription/route.ts (PUT)

2. Agent Routes (1):
   - $BASE_DIR/agents/consult/route.ts (POST)

3. AI Routes (7):
   - $BASE_DIR/ai_conversations/[id]/messages/route.ts (POST)
   - $BASE_DIR/ai_conversations/[id]/route.ts (PATCH, DELETE)
   - $BASE_DIR/ai_conversations/route.ts (POST)
   - $BASE_DIR/ai/chat/route.ts (POST, PATCH)
   - $BASE_DIR/ai/settings/route.ts (POST, PATCH, DELETE)
   - $BASE_DIR/ai/tasks/[taskId]/status/route.ts (PATCH)

4. Auth Routes (3):
   - $BASE_DIR/auth/logout/route.ts (POST)
   - $BASE_DIR/auth/mcp-tokens/[tokenId]/route.ts (DELETE)
   - $BASE_DIR/auth/mcp-tokens/route.ts (POST)

5. Channel Routes (1):
   - $BASE_DIR/channels/[pageId]/messages/route.ts (POST)

6. Connection Routes (2):
   - $BASE_DIR/connections/[connectionId]/route.ts (PATCH, DELETE)
   - $BASE_DIR/connections/route.ts (POST)

7. Contact Route (1):
   - $BASE_DIR/contact/route.ts (POST)

8. Debug Route (1):
   - $BASE_DIR/debug/chat-messages/route.ts (POST)

9. Drive Member Routes (3):
   - $BASE_DIR/drives/[driveId]/members/[userId]/route.ts (PATCH)
   - $BASE_DIR/drives/[driveId]/members/invite/route.ts (POST)
   - $BASE_DIR/drives/[driveId]/members/route.ts (POST)

10. File Routes (1):
    - $BASE_DIR/files/[id]/convert-to-document/route.ts (POST)

11. Message Routes (2):
    - $BASE_DIR/messages/[conversationId]/route.ts (POST, PATCH)
    - $BASE_DIR/messages/conversations/route.ts (POST)

12. Notification Routes (3):
    - $BASE_DIR/notifications/[id]/read/route.ts (PATCH)
    - $BASE_DIR/notifications/[id]/route.ts (DELETE)
    - $BASE_DIR/notifications/read-all/route.ts (PATCH)

13. Page Routes (3):
    - $BASE_DIR/pages/[pageId]/agent-config/route.ts (PATCH)
    - $BASE_DIR/pages/[pageId]/permissions/route.ts (POST, DELETE)
    - $BASE_DIR/pages/[pageId]/reprocess/route.ts (POST)

14. Permission Route (1):
    - $BASE_DIR/permissions/batch/route.ts (POST)

15. Settings Route (1):
    - $BASE_DIR/settings/notification-preferences/route.ts (PATCH)

16. Storage Route (1):
    - $BASE_DIR/storage/check/route.ts (POST)

17. Stripe Route (1):
    - $BASE_DIR/stripe/portal/route.ts (POST)

18. Tracking Route (1):
    - $BASE_DIR/track/route.ts (POST, PUT)

19. Trash Routes (2):
    - $BASE_DIR/trash/[pageId]/route.ts (DELETE)
    - $BASE_DIR/trash/drives/[driveId]/route.ts (DELETE)

20. Upload Route (1):
    - $BASE_DIR/upload/route.ts (POST)

=================================================================
CONVERSION PATTERN
=================================================================

BEFORE (inline auth):
---------------------
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';

export async function POST(req: Request) {
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = decoded.userId;
  // ... rest of handler
}

AFTER (with AUTH_OPTIONS):
--------------------------
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;
  // ... rest of handler
}

=================================================================
VERIFICATION
=================================================================

After updating all routes, verify with:

# Count routes with requireCSRF
grep -r "requireCSRF.*true" apps/web/src/app/api/**/route.ts | wc -l

# Should equal: 19 (already done) + 36 (remaining) = 55 total

# List any mutation routes WITHOUT requireCSRF (should be empty except exempt routes)
for file in apps/web/src/app/api/**/route.ts; do
  if grep -qE "^export async function (POST|PATCH|PUT|DELETE)" "$file"; then
    if ! grep -q "requireCSRF.*true" "$file" && \
       ! grep -q "authenticateMCPRequest" "$file" && \
       ! echo "$file" | grep -qE "(auth/login|auth/signup|auth/refresh|auth/google|auth/resend|stripe/webhook|internal)"; then
      echo "MISSING CSRF: $file"
    fi
  fi
done

EOF

echo ""
echo "==================================================================="
echo "Summary saved to: /tmp/csrf_implementation_summary.md"
echo "This script saved to: scripts/complete-csrf-implementation.sh"
echo "==================================================================="
