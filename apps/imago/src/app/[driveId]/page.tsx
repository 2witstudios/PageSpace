import { getViewer } from '@/lib/auth/get-viewer';
import { SignOutButton } from '@/components/SignOutButton';

// Placeholder drive page until the shell lands (IMG-3.2): it renders the root
// layout (fonts, CSP nonce) behind the auth gate and offers sign-out. No other
// UI belongs here.
export default async function DrivePage() {
  await getViewer();

  return (
    <main>
      <p>Imago</p>
      <SignOutButton />
    </main>
  );
}
