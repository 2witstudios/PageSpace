import { cookies } from 'next/headers';

/**
 * Server-side conversation state management
 * For use in Server Components and API routes
 */

const ACTIVE_CONVERSATION_COOKIE = 'activeConversationId';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Get the active conversation ID from cookies (server-side)
 */
export async function getActiveConversationId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    return cookieStore.get(ACTIVE_CONVERSATION_COOKIE)?.value || null;
  } catch (error) {
    console.error('Error getting active conversation ID:', error);
    return null;
  }
}

/**
 * Set the active conversation ID in cookies (server-side)
 */
export async function setActiveConversationId(conversationId: string | null) {
  try {
    const cookieStore = await cookies();
    
    if (conversationId) {
      cookieStore.set(ACTIVE_CONVERSATION_COOKIE, conversationId, {
        maxAge: COOKIE_MAX_AGE,
        httpOnly: false, // Allow client-side access
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      });
    } else {
      cookieStore.delete(ACTIVE_CONVERSATION_COOKIE);
    }
  } catch (error) {
    console.error('Error setting active conversation ID:', error);
  }
}