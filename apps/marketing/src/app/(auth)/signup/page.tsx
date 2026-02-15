import { pageMetadata } from "@/lib/metadata";
import { SignupContent } from "./SignupContent";

export const metadata = pageMetadata.signup;

export default function SignupPage() {
  return <SignupContent />;
}
