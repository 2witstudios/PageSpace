import { pageMetadata } from "@/lib/metadata";
import { LoginContent } from "./LoginContent";

export const metadata = pageMetadata.login;

export default function LoginPage() {
  return <LoginContent />;
}
