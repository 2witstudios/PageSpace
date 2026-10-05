import { getViewer } from '@/lib/auth/get-viewer';
import { SignOutButton } from '@/components/SignOutButton';

// Placeholder index until the shell lands: it renders the root layout (fonts,
// CSP nonce) behind the auth gate and offers sign-out. No other UI belongs here.
export default async function Home() {
  await getViewer();

  return (
    <main>
      <p>Imago</p>
      <SignOutButton />
    </main>
  );
}
