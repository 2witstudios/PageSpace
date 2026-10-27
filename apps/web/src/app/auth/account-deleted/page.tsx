import { AccountDeletedView } from "@/components/account/AccountDeletedView";

export default async function AccountDeletedPage({
  searchParams,
}: {
  searchParams: Promise<{ appleSignIn?: string | string[] }>;
}) {
  const { appleSignIn } = await searchParams;
  return <AccountDeletedView showAppleSignInSteps={appleSignIn === "manual"} />;
}
